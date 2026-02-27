/**
 * Post-Tool Reflection — Stateful Persona Architecture
 *
 * Runs a lightweight Tier 1 (8B) JSON-mode pass after a tool executes to:
 *   1. Validate whether the tool output actually answers the user's query.
 *   2. Extract key facts (2-4 bullet points) for injection into working memory.
 *   3. Determine whether Aria should mention the data quality/caveat.
 *
 * The structured summary replaces raw JSON.stringify() in Layer 8, keeping the
 * 70B prompt tight and reducing hallucination risk.
 *
 * Graceful degradation: if the reflection call fails (network, rate-limit, parse
 * error), the caller receives null and should fall back to the raw JSON string.
 *
 * @see ARCHITECTURE.md — Reflection Pipeline section
 */

import { generateResponse } from '../llm/tierManager.js'
import { safeError } from '../utils/safe-log.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReflectionResult {
    /** True if the tool output appears to answer the user's question */
    answersQuery: boolean
    /** 2-4 concise facts extracted from the tool output */
    keyFacts: string[]
    /** True if Aria should caveat the data (stale, partial, low confidence) */
    ariaShouldMention: boolean
    /** 'good' | 'partial' | 'poor' */
    dataQuality: 'good' | 'partial' | 'poor'
    /** Human-readable summary suitable for Layer 8 injection */
    summary: string
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const REFLECTION_SYSTEM = `You are Aria's internal tool auditor.
Given a user message, the tool that ran, and its raw output, return a JSON object:
{
  "answersQuery": boolean,
  "keyFacts": ["fact1", "fact2"],
  "ariaShouldMention": boolean,
  "dataQuality": "good" | "partial" | "poor",
  "summary": "one or two sentence plain-English summary of the most useful data"
}
Rules:
- keyFacts: 2-4 short bullet strings. Extract numbers, names, prices where present.
- answersQuery: true only if the output directly resolves what the user asked.
- ariaShouldMention: true if data is stale (>24h), incomplete, or has obvious gaps.
- dataQuality: "good" if complete, "partial" if some info missing, "poor" if empty/error.
- summary: plain text, no markdown, ≤80 words. Use the keyFacts to write it.
Return ONLY the JSON object.`

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Reflect on a tool result using the Tier 1 (8B) model in JSON mode.
 *
 * @param userMessage   - The original user message that triggered the tool
 * @param toolName      - Name of the tool that ran (e.g. "search_flights")
 * @param toolOutput    - Raw tool output (will be stringified if not a string)
 * @param userPreferences - Optional brief preference context for better reflection
 * @returns ReflectionResult or null on failure (caller should fall back to raw JSON)
 */
export async function reflectOnToolResult(
    userMessage: string,
    toolName: string,
    toolOutput: unknown,
    userPreferences?: string
): Promise<ReflectionResult | null> {
    const rawStr = typeof toolOutput === 'string'
        ? toolOutput
        : JSON.stringify(toolOutput, null, 2)

    // Trim to ~1200 chars so we don't burn tokens on huge payloads
    const trimmedOutput = rawStr.length > 1200
        ? rawStr.substring(0, 1200) + '\n…[truncated]'
        : rawStr

    const prefContext = userPreferences
        ? `\nUser preferences: ${userPreferences.substring(0, 200)}`
        : ''

    const userPrompt =
        `User asked: "${userMessage}"\n` +
        `Tool used: ${toolName}\n` +
        `Tool output:\n${trimmedOutput}` +
        prefContext

    try {
        const { text } = await generateResponse(
            [
                { role: 'system', content: REFLECTION_SYSTEM },
                { role: 'user', content: userPrompt },
            ],
            { maxTokens: 200, temperature: 0.1, jsonMode: true }
        )

        if (!text) return null

        const parsed = JSON.parse(text) as Partial<ReflectionResult>

        // Validate shape — be lenient, fill defaults
        return {
            answersQuery:       typeof parsed.answersQuery === 'boolean' ? parsed.answersQuery : true,
            keyFacts:           Array.isArray(parsed.keyFacts) ? parsed.keyFacts.slice(0, 4) : [],
            ariaShouldMention:  typeof parsed.ariaShouldMention === 'boolean' ? parsed.ariaShouldMention : false,
            dataQuality:        (['good', 'partial', 'poor'] as const).includes(parsed.dataQuality as any)
                ? parsed.dataQuality as 'good' | 'partial' | 'poor'
                : 'good',
            summary:            typeof parsed.summary === 'string' ? parsed.summary : '',
        }
    } catch (err) {
        console.warn('[reflect] Reflection failed, falling back to raw output:', safeError(err))
        return null
    }
}
