import { generateResponse, type ChatMessage } from '../llm/tierManager.js'
import { ToolSandbox } from './tool-sandbox.js'
import { AlphaContextBundle, serializeToolResultForPrompt } from './context-manager.js'
import { ALPHA_TOOL_DEFINITIONS, ALPHA_TOOL_NAMES } from '../tool-definitions.js'
import { executeAlphaTool, matchesPrefetchedTool } from '../tool-executor.js'

const sandbox = new ToolSandbox(ALPHA_TOOL_DEFINITIONS)
const MAX_SANDBOX_RETRIES = 2

export interface AlphaCallerResult {
    content: string
    toolCalls: Array<{ name: string; args: any }>
    toolResults: Array<{ name: string; result: any }>
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
        console.log(`[Alpha] Call 1: Message classification and tool decision (attempt ${attempt + 1})`)
        const start1 = Date.now()
        const res1 = await generateResponse(messages, {
            temperature: attempt === 0 ? 0.3 : 0.2,
            maxTokens: 256,
            tools: ALPHA_TOOL_DEFINITIONS,
            toolChoice: 'auto',
        })
        provider = res1.provider
        console.log(`[Alpha] Provider: ${res1.provider} | Latency: ${Date.now() - start1}ms`)

        if (!res1.toolCalls || res1.toolCalls.length === 0) {
            console.log('[Alpha] Decision: respond (no tool)')
            return {
                content: res1.text,
                toolCalls: [],
                toolResults: [],
                provider: res1.provider
            }
        }

        const executedCalls: Array<{ name: string; args: any }> = []
        const executionResults: Array<{ name: string; result: any }> = []
        let hadRecoverableFailure = false

        messages.push({ role: 'assistant', content: res1.text || '', tool_calls: res1.toolCalls } as any)

        for (const tc of res1.toolCalls) {
            const toolName = tc.function.name
            const argsStr = tc.function.arguments

            console.log(`[Alpha] Tool call: ${toolName} ${argsStr}`)

            const sandboxResult = await sandbox.executeToolCall(
                userId,
                toolName,
                argsStr,
                async args => {
                if (options.prefetchedToolResult && matchesPrefetchedTool(options.prefetchedToolResult.toolName, toolName)) {
                    console.log(`[Alpha/Tools] Prefetch hit: ${toolName}`)
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
                } as any)
                continue
            }

            hadRecoverableFailure = true
            console.log(`[Alpha/Tools] Validation failed: ${sandboxResult.error}`)
            messages.push({
                role: 'tool',
                content: JSON.stringify({
                    error: sandboxResult.error,
                    available_tools: [...ALPHA_TOOL_NAMES],
                    retryable: true,
                }),
                tool_call_id: tc.id,
            } as any)
        }

        if (hadRecoverableFailure && executionResults.length === 0 && attempt < MAX_SANDBOX_RETRIES) {
            console.log(`[Alpha] Repairing malformed tool call (retry ${attempt + 1}/${MAX_SANDBOX_RETRIES})`)
            messages.push({
                role: 'system',
                content: `The previous tool call was invalid or failed validation. Use only these tools when needed: ${[...ALPHA_TOOL_NAMES].join(', ')}. Return valid JSON arguments. If no tool is needed, answer directly without calling one.`,
            })
            continue
        }

        console.log('[Alpha] Call 2: Response with tool result')
        const start2 = Date.now()
        const res2 = await generateResponse(messages, {
            temperature: 0.5,
            maxTokens: 320,
        })
        console.log(`[Alpha] Provider: ${res2.provider} | Latency: ${Date.now() - start2}ms`)

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
