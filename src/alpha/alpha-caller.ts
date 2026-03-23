import { generateResponse, type ChatMessage } from '../llm/tierManager.js'
import type { ToolArgs } from '../llm/tool-contracts.js'
import { ToolSandbox } from './tool-sandbox.js'
import { AlphaContextBundle, serializeToolResultForPrompt } from './context-manager.js'
import { ALPHA_TOOL_DEFINITIONS, ALPHA_TOOL_NAMES } from '../tool-definitions.js'
import { executeAlphaTool, matchesPrefetchedTool } from '../tool-executor.js'
import { logger } from '../utils/logger.js'

const sandbox = new ToolSandbox(ALPHA_TOOL_DEFINITIONS)
const MAX_SANDBOX_RETRIES = 2

export interface AlphaCallerResult {
    content: string
    toolCalls: Array<{ name: string; args: ToolArgs }>
    toolResults: Array<{ name: string; result: unknown }>
    provider: string
}

export function buildSystemPrompt(bundle: AlphaContextBundle): string {
    const parts = [bundle.soul]
    if (bundle.userContext) parts.push(`## User Context\n${bundle.userContext}`)
    if (bundle.pulseTopics) parts.push(`## Pulse & Topics\n${bundle.pulseTopics}`)
    if (bundle.proactiveState) parts.push(`## Proactive State\n${bundle.proactiveState}`)
    if (bundle.toolResults) parts.push(bundle.toolResults)
    return parts.join('\n\n')
}

export interface AlphaCallerOptions {
    userContext?: Record<string, unknown>
    prefetchedToolResult?: { toolName: string; result: unknown } | null
}

export async function callAlpha(
    userId: string,
    bundle: AlphaContextBundle,
    userMessage: string,
    options: AlphaCallerOptions = {},
): Promise<AlphaCallerResult> {
    const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(bundle) },
        ...bundle.history,
        { role: 'user', content: userMessage }
    ]

    let provider = 'none'

    for (let attempt = 0; attempt <= MAX_SANDBOX_RETRIES; attempt++) {
        const start1 = Date.now()
        const res1 = await generateResponse(messages, {
            temperature: attempt === 0 ? 0.3 : 0.2,
            maxTokens: 256,
            tools: ALPHA_TOOL_DEFINITIONS,
            toolChoice: 'auto',
        })
        provider = res1.provider
        logger.debug('[Alpha] First LLM call completed', {
            provider: res1.provider,
            latencyMs: Date.now() - start1,
            attempt: attempt + 1,
            toolCalls: res1.toolCalls?.length ?? 0,
        })

        if (!res1.toolCalls || res1.toolCalls.length === 0) {
            logger.debug('[Alpha] Responding without tools', { provider: res1.provider })
            return {
                content: res1.text,
                toolCalls: [],
                toolResults: [],
                provider: res1.provider
            }
        }

        const executedCalls: Array<{ name: string; args: ToolArgs }> = []
        const executionResults: Array<{ name: string; result: unknown }> = []
        let hadRecoverableFailure = false

        messages.push({ role: 'assistant', content: res1.text || '', tool_calls: res1.toolCalls })

        for (const tc of res1.toolCalls) {
            const toolName = tc.function.name
            const argsStr = tc.function.arguments

            logger.debug('[Alpha] Tool requested by model', {
                toolName,
                hasArgs: Boolean(argsStr?.trim()),
            })

            const sandboxResult = await sandbox.executeToolCall(
                userId,
                toolName,
                argsStr,
                async args => {
                if (options.prefetchedToolResult && matchesPrefetchedTool(options.prefetchedToolResult.toolName, toolName)) {
                    logger.debug('[Alpha/Tools] Using prefetched tool result', { toolName })
                    return { success: true, data: options.prefetchedToolResult.result }
                }
                return executeAlphaTool(toolName, args, { userId })
            },
            { userContext: options.userContext },
        )

            if (sandboxResult.success) {
                executedCalls.push({ name: toolName, args: sandboxResult.args })
                executionResults.push({ name: toolName, result: sandboxResult.data })
                messages.push({
                    role: 'tool',
                    content: serializeToolResultForPrompt(sandboxResult.data, 800, toolName),
                    tool_call_id: tc.id,
                })
                continue
            }

            hadRecoverableFailure = true
            logger.warn('[Alpha/Tools] Tool validation failed', {
                toolName,
                error: sandboxResult.error,
                timedOut: sandboxResult.timedOut ?? false,
            })
            messages.push({
                role: 'tool',
                content: JSON.stringify({
                    error: sandboxResult.error,
                    available_tools: [...ALPHA_TOOL_NAMES],
                    retryable: true,
                }),
                tool_call_id: tc.id,
            })
        }

        if (hadRecoverableFailure && executionResults.length === 0 && attempt < MAX_SANDBOX_RETRIES) {
            logger.warn('[Alpha] Retrying after recoverable tool-call failure', {
                attempt: attempt + 1,
                maxRetries: MAX_SANDBOX_RETRIES,
            })
            messages.push({
                role: 'system',
                content: `The previous tool call was invalid or failed validation. Use only these tools when needed: ${[...ALPHA_TOOL_NAMES].join(', ')}. Return valid JSON arguments. If no tool is needed, answer directly without calling one.`,
            })
            continue
        }

        const start2 = Date.now()
        const res2 = await generateResponse(messages, {
            temperature: 0.5,
            maxTokens: 320,
        })
        logger.debug('[Alpha] Second LLM call completed', {
            provider: res2.provider,
            latencyMs: Date.now() - start2,
            executedTools: executedCalls.map(call => call.name),
        })

        return {
            content: res2.text,
            toolCalls: executedCalls,
            toolResults: executionResults,
            provider: res2.provider
        }
    }

    return {
        content: "I'm sorry, I hit a tool-routing snag. Let me answer without tools for now.",
        toolCalls: [],
        toolResults: [],
        provider,
    }
}
