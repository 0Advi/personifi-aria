
import type { BrainHooks, RouteContext, RouteDecision, ToolResult } from '../hooks.js'
import { getBodyHooks } from '../hook-registry.js'
import { reflectOnToolResult } from './reflect.js'

export const brainHooks: BrainHooks = {
    async routeMessage(context: RouteContext): Promise<RouteDecision> {
        const { classification } = context

        // Default decision: no tool
        const decision: RouteDecision = {
            useTool: false,
            toolName: null,
            toolParams: {},
        }

        // If classifier says we need a tool, use the LLM-extracted args
        if (classification.needs_tool && classification.tool_hint) {
            const args = classification.tool_args || {}
            const hasValidParams = Object.keys(args).length > 0

            if (hasValidParams) {
                decision.useTool = true
                decision.toolName = classification.tool_hint
                decision.toolParams = args
            } else {
                console.warn(`[brain] Classifier indicated tool '${classification.tool_hint}' but provided no tool_args for message`)
            }
        }

        return decision
    },

    async executeToolPipeline(decision: RouteDecision, context: RouteContext): Promise<ToolResult | null> {
        if (!decision.useTool || !decision.toolName) {
            return null
        }

        try {
            const bodyHooks = getBodyHooks()
            const result = await bodyHooks.executeTool(decision.toolName, decision.toolParams)

            // Build raw JSON string as the safe fallback
            let formattedData = ''
            if (result.success) {
                formattedData = JSON.stringify(result.data, null, 2)
            } else {
                formattedData = `Tool execution failed: ${result.error || 'Unknown error'}`
            }

            // Reflection pass: use Tier 1 (8B) to validate output and extract key facts.
            // Falls back to raw formattedData if reflection fails.
            if (result.success && result.data != null) {
                const reflection = await reflectOnToolResult(
                    context.userMessage,
                    decision.toolName,
                    result.data
                )
                if (reflection?.summary) {
                    // Use the structured summary for Layer 8 — keeps prompt tight
                    formattedData = reflection.summary
                    if (reflection.ariaShouldMention) {
                        formattedData += '\n[Note: data may be partial — mention this to the user if relevant]'
                    }
                }
            }

            return {
                success: result.success,
                data: formattedData,
                raw: result.data
            }
        } catch (error) {
            console.error('[brain] Tool pipeline execution failed:', error)
            return {
                success: false,
                data: 'Internal error executing tool',
                raw: error instanceof Error
                    ? { name: error.name, message: error.message }
                    : String(error)
            }
        }
    },

    formatResponse(rawResponse: string, toolResult: ToolResult | null): string {
        // Optional: append a footer if a tool was used
        // if (toolResult?.success) {
        //     return `${rawResponse}\n\n_(Information provided by Aria's real-time tools)_`
        // }
        return rawResponse
    }
}
