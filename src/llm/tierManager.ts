/**
 * Tier Manager — Central LLM calling module with fallback chains
 *
 * Tier 1 (8B): Intent classification + tool arg extraction
 *   Chain: Groq 8B → Groq 70B → Gemini Flash 2.0
 *
 * Tier 2 (70B): Personality response + proactive agent
 *   Chain: Groq 70B → Gemini Flash 2.0 → Gemini 1.5 Flash
 *
 * Each tier tries providers in order with exponential backoff (1s, 2s, 4s)
 * before moving to the next provider.
 */

import Groq from 'groq-sdk'
import { withGroqRetry } from '../utils/retry.js'
import type { ToolCall, ToolChoice, ToolDefinition } from './tool-contracts.js'
import { logger } from '../utils/logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProviderCallResult {
    text: string;
    toolCalls?: ToolCall[];
}

export interface LLMProvider {
    name: string
    call: (
        messages: ChatMessage[],
        opts: CallOptions
    ) => Promise<ProviderCallResult>
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_calls?: ToolCall[]
    tool_call_id?: string
}

export interface CallOptions {
    maxTokens?: number
    temperature?: number
    jsonMode?: boolean
    tools?: ToolDefinition[]
    toolChoice?: ToolChoice
}

export interface ProviderResult {
    text: string
    provider: string
    toolCalls?: ToolCall[]
}

interface GeminiFunctionCall {
    name?: string
    args?: Record<string, unknown>
}

interface GeminiPart {
    text?: string
    functionCall?: GeminiFunctionCall
}

interface GeminiCandidate {
    content?: {
        parts?: GeminiPart[]
    }
}

interface GeminiResponseBody {
    candidates?: GeminiCandidate[]
}

interface GeminiRequestBody {
    contents: Array<{
        role: 'user' | 'model'
        parts: Array<{ text: string }>
    }>
    generationConfig: {
        maxOutputTokens: number
        temperature: number
        responseMimeType?: 'application/json'
    }
    systemInstruction?: {
        parts: Array<{ text: string }>
    }
}

interface GroqCompletionParams {
    model: string
    messages: Groq.Chat.ChatCompletionMessageParam[]
    max_tokens: number
    temperature: number
    response_format?: { type: 'json_object' }
    tools?: Groq.Chat.ChatCompletionTool[]
    tool_choice?: Groq.Chat.ChatCompletionToolChoiceOption
}

interface ProviderError extends Error {
    status?: number
    error?: {
        error?: {
            code?: number
        }
    }
}

// ─── Media URL Stripping ────────────────────────────────────────────────────
// CRITICAL: Never send video/image URLs or CDN links to LLMs

const MEDIA_URL_PATTERN = /https?:\/\/[^\s]+?\.(mp4|mov|avi|webm|mkv|jpg|jpeg|png|gif|webp|svg|bmp|cdn[^\s]*|rapidapi[^\s]*)/gi
const CDN_PATTERN = /https?:\/\/[^\s]*(cdn|media|image|video|thumbnail|reel|clip)[^\s]*/gi

function stripMediaUrls(text: string): string {
    return text
        .replace(MEDIA_URL_PATTERN, '[media-removed]')
        .replace(CDN_PATTERN, '[media-removed]')
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => ({
        ...m,
        content: stripMediaUrls(m.content),
    }))
}

// ─── Provider Factories ─────────────────────────────────────────────────────

let groqClient: Groq | null = null
function getGroq(): Groq {
    if (!groqClient) {
        groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groqClient
}

function makeGroqProvider(model: string, label: string): LLMProvider {
    return {
        name: label,
        call: async (messages, opts) => {
            const client = getGroq()
            const params: GroqCompletionParams = {
                model,
                messages: messages.map(toGroqMessage),
                max_tokens: opts.maxTokens ?? 500,
                temperature: opts.temperature ?? 0.8,
            }
            if (opts.jsonMode) {
                params.response_format = { type: 'json_object' }
            }
            if (opts.tools?.length) {
                params.tools = opts.tools as unknown as Groq.Chat.ChatCompletionTool[]
                params.tool_choice = opts.toolChoice ?? 'auto'
            }
            const completion = await withGroqRetry(
                () => client.chat.completions.create(params),
                `groq-${model.includes('70b') || model.includes('70B') ? '70b' : '8b'}`,
            )
            const message = completion.choices[0]?.message
            return {
                text: message?.content || '',
                toolCalls: message?.tool_calls as ToolCall[] | undefined,
            }
        },
    }
}

function makeGeminiProvider(model: string, label: string): LLMProvider {
    return {
        name: label,
        call: async (messages, opts) => {
            const apiKey = process.env.GEMINI_API_KEY
            if (!apiKey) throw new Error('GEMINI_API_KEY not set')

            // Convert chat messages to Gemini format
            const systemMsg = messages.find(m => m.role === 'system')
            const nonSystem = messages.filter(m => m.role !== 'system')
            const contents: GeminiRequestBody['contents'] = nonSystem.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            }))

            const body: GeminiRequestBody = {
                contents,
                generationConfig: {
                    maxOutputTokens: opts.maxTokens ?? 500,
                    temperature: opts.temperature ?? 0.8,
                },
            }
            if (systemMsg) {
                body.systemInstruction = { parts: [{ text: systemMsg.content }] }
            }
            if (opts.jsonMode) {
                body.generationConfig.responseMimeType = 'application/json'
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })

            if (!resp.ok) {
                const err = await resp.text().catch(() => '')
                const status = resp.status
                const error = new Error(`Gemini ${status}: ${err}`) as ProviderError
                error.status = status
                throw error
            }

            const data: GeminiResponseBody = await resp.json()
            const fnCalls: ToolCall[] | undefined = data.candidates?.[0]?.content?.parts
                ?.filter(part => part.functionCall?.name)
                .map(part => ({
                id: 'call_' + Math.random().toString(36).slice(2, 11),
                type: 'function' as const,
                function: {
                    name: part.functionCall?.name ?? 'unknown_tool',
                    arguments: JSON.stringify(part.functionCall?.args ?? {}),
                },
            }))
            return {
                text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
                toolCalls: fnCalls?.length ? fnCalls : undefined,
            }
        },
    }
}

// ─── Provider Chains ────────────────────────────────────────────────────────

const TIER1_PROVIDERS: LLMProvider[] = [
    makeGroqProvider('llama-3.1-8b-instant', 'groq-8b'),
    makeGroqProvider('llama-3.3-70b-versatile', 'groq-70b'),
    makeGeminiProvider('gemini-2.0-flash', 'gemini-flash-2.0'),
]

const TIER2_PROVIDERS: LLMProvider[] = [
    makeGroqProvider('llama-3.3-70b-versatile', 'groq-70b'),
    makeGeminiProvider('gemini-2.0-flash', 'gemini-flash-2.0'),
    makeGeminiProvider('gemini-1.5-flash', 'gemini-1.5-flash'),
]

// ─── Core: Call with Fallback ───────────────────────────────────────────────

const BACKOFF_DELAYS = [1000, 2000, 4000] // exponential backoff per provider

async function callWithFallback(
    providers: LLMProvider[],
    messages: ChatMessage[],
    opts: CallOptions,
    tier: string
): Promise<ProviderResult> {
    for (let pi = 0; pi < providers.length; pi++) {
        const provider = providers[pi]

        for (let attempt = 0; attempt < BACKOFF_DELAYS.length; attempt++) {
            try {
                logger.debug('[LLM] Calling provider', {
                    provider: provider.name,
                    tier,
                    attempt: attempt + 1,
                })
                const res = await provider.call(messages, opts)
                return { text: res.text, toolCalls: res.toolCalls, provider: provider.name }
            } catch (error) {
                const err = error as ProviderError
                const is429 = err?.status === 429
                    || err?.error?.error?.code === 429
                    || String(err?.message).includes('429')
                    || String(err?.message).includes('rate_limit')

                if (is429) {
                    if (attempt < BACKOFF_DELAYS.length - 1) {
                        const delay = BACKOFF_DELAYS[attempt]
                        logger.warn('[LLM] Provider rate limited, retrying', {
                            provider: provider.name,
                            tier,
                            delay,
                            attempt: attempt + 1,
                        })
                        await sleep(delay)
                        continue
                    }
                    // Exhausted retries for this provider → fallback to next
                    logger.warn('[LLM] Provider exhausted after rate limits, falling back', {
                        provider: provider.name,
                        tier,
                    })
                    break
                }

                // Non-429 error — retry once, then move on
                if (attempt === 0) {
                    logger.warn('[LLM] Provider call failed, retrying once', {
                        provider: provider.name,
                        tier,
                        message: err?.message,
                    })
                    await sleep(BACKOFF_DELAYS[0])
                    continue
                }

                logger.error('[LLM] Provider failed permanently', {
                    provider: provider.name,
                    tier,
                    message: err?.message,
                })
                break
            }
        }
    }

    // All providers exhausted
    logger.error('[LLM] All providers exhausted', { tier })
    return { text: '', provider: 'none' }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function toGroqMessage(message: ChatMessage): Groq.Chat.ChatCompletionMessageParam {
    switch (message.role) {
        case 'system':
            return {
                role: 'system',
                content: message.content,
            }
        case 'user':
            return {
                role: 'user',
                content: message.content,
            }
        case 'assistant':
            return {
                role: 'assistant',
                content: message.content,
                ...(message.tool_calls ? { tool_calls: message.tool_calls as unknown as Groq.Chat.ChatCompletionMessageToolCall[] } : {}),
            }
        case 'tool':
            return {
                role: 'tool',
                content: message.content,
                tool_call_id: message.tool_call_id ?? '',
            }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a personality response via Tier 2 (70B).
 * Used for reactive Aria responses in the handler.
 *
 * Automatically strips media URLs from all messages before sending.
 */
export async function generateResponse(
    messages: ChatMessage[],
    opts: CallOptions = {}
): Promise<ProviderResult> {
    const safeMessages = sanitizeMessages(messages)
    return callWithFallback(TIER2_PROVIDERS, safeMessages, opts, 'tier2-response')
}

/**
 * Call the proactive agent (70B) to decide what to send.
 * Returns raw JSON string from the model.
 *
 * Automatically strips media URLs from context before sending.
 */
export async function callProactiveAgent(
    systemPrompt: string,
    userContext: string,
    opts: CallOptions = {}
): Promise<{ text: string; provider: string }> {
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: stripMediaUrls(userContext) },
    ]
    return callWithFallback(TIER2_PROVIDERS, messages, {
        ...opts,
        maxTokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.7,
        jsonMode: true,
    }, 'tier2-proactive')
}

/**
 * Generate a reel/content caption via Tier 2 (70B).
 * Only receives text metadata — never media/URLs.
 */
export async function generateCaption(
    systemPrompt: string,
    context: string,
    opts: CallOptions = {}
): Promise<string> {
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: stripMediaUrls(context) },
    ]
    const result = await callWithFallback(TIER2_PROVIDERS, messages, {
        ...opts,
        maxTokens: opts.maxTokens ?? 100,
        temperature: opts.temperature ?? 0.9,
    }, 'tier2-caption')
    return result.text
}
