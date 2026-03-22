import { ChatMessage } from '../llm/tierManager.js'

export const MAX_TOKENS = 8192
export const WARN_TOKENS = Math.floor(MAX_TOKENS * 0.8)
export const MAX_TOOL_TOKENS = 800

export interface AlphaContextBundle {
    soul: string;
    userContext: string;
    proactiveState: string;
    pulseTopics: string;
    history: ChatMessage[];
    toolResults: string;
}

export interface GatheredContext {
    userContext: string;
    pulseTopics: string;
    history: ChatMessage[];
    toolResults?: string;
    activeToolName?: string;
}

export interface ContextTokenBreakdown {
    soul: number
    userContext: number
    proactiveState: number
    pulseTopics: number
    history: number
    toolResults: number
    total: number
    budget: number
    overBudget: boolean
    overWarning: boolean
}

export function countTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 4)
}

export function compressToolResults(results: string, maxTokens: number = MAX_TOOL_TOKENS, toolName?: string): string {
    if (!results) return ''

    const sanitized = sanitizeToolPayloadString(results)
    const currentTokens = countTokens(sanitized)
    if (currentTokens <= maxTokens) return sanitized

    const maxChars = maxTokens * 4
    const nameStr = toolName ? ` (${toolName})` : ''
    console.log(`[Alpha/Context] Tool result compressed: ${currentTokens} → ${maxTokens} tokens${nameStr}`)

    try {
        const parsed = JSON.parse(sanitized)
        if (Array.isArray(parsed)) {
            const truncated: any[] = []
            for (const item of parsed) {
                truncated.push(item)
                if (countTokens(JSON.stringify(truncated)) > maxTokens) {
                    truncated.pop()
                    break
                }
            }
            if (truncated.length > 0) {
                return JSON.stringify(truncated)
            }
        }
    } catch {
        // Fall back to string slice
    }

    return sanitized.slice(0, maxChars)
}

export function serializeToolResultForPrompt(
    result: unknown,
    maxTokens: number = MAX_TOOL_TOKENS,
    toolName?: string,
): string {
    const sanitized = stripMediaFields(result)
    return compressToolResults(JSON.stringify(sanitized), maxTokens, toolName)
}

export function countContextTokens(parts: {
    soul: string
    userContext: string
    proactiveState: string
    pulseTopics: string
    history: ChatMessage[]
    toolResults?: string
    budget?: number
}): ContextTokenBreakdown {
    const breakdown: ContextTokenBreakdown = {
        soul: countTokens(parts.soul),
        userContext: countTokens(parts.userContext),
        proactiveState: countTokens(parts.proactiveState),
        pulseTopics: countTokens(parts.pulseTopics),
        history: parts.history.reduce((acc, msg) => acc + countTokens(msg.content), 0),
        toolResults: countTokens(parts.toolResults ?? ''),
        total: 0,
        budget: parts.budget ?? MAX_TOKENS,
        overBudget: false,
        overWarning: false,
    }

    breakdown.total = breakdown.soul
        + breakdown.userContext
        + breakdown.proactiveState
        + breakdown.pulseTopics
        + breakdown.history
        + breakdown.toolResults
    breakdown.overBudget = breakdown.total > breakdown.budget
    breakdown.overWarning = breakdown.total > Math.floor(breakdown.budget * 0.8)
    return breakdown
}

export function truncateHistory(history: ChatMessage[], targetTokens: number): { truncated: ChatMessage[]; newTokens: number } {
    const currentTokens = history.reduce((acc, msg) => acc + countTokens(msg.content), 0)
    if (currentTokens <= targetTokens) return { truncated: history, newTokens: currentTokens }

    const systemMsgs = history.filter(m => m.role === 'system')
    const nonSystemMsgs = history.filter(m => m.role !== 'system')
    const systemTokens = systemMsgs.reduce((acc, m) => acc + countTokens(m.content), 0)

    const resultNonSystem: ChatMessage[] = []
    let allocated = systemTokens

    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        const msg = nonSystemMsgs[i]
        const msgTokens = countTokens(msg.content)
        if (allocated + msgTokens <= targetTokens) {
            resultNonSystem.unshift(msg)
            allocated += msgTokens
        } else {
            break
        }
    }

    return { truncated: [...systemMsgs, ...resultNonSystem], newTokens: allocated }
}

export function buildContext(
    soul: string,
    gathered: GatheredContext,
    proactiveState: string
): AlphaContextBundle {
    let userContext = gathered.userContext
    const tsoul = countTokens(soul)
    let tuser = countTokens(userContext)
    let tproact = countTokens(proactiveState)
    const tpulse = countTokens(gathered.pulseTopics)
    let compressedTools = compressToolResults(gathered.toolResults || '', MAX_TOOL_TOKENS, gathered.activeToolName)
    let ttools = countTokens(compressedTools)
    let thistory = gathered.history.reduce((acc, msg) => acc + countTokens(msg.content), 0)

    let total = tsoul + tuser + tproact + tpulse + thistory + ttools
    let finalHistory = gathered.history

    if (total > WARN_TOKENS && finalHistory.length > 4) {
        const tightenedHistory = keepRecentMessages(finalHistory, 4)
        const tightenedTokens = tightenedHistory.reduce((acc, msg) => acc + countTokens(msg.content), 0)
        if (tightenedTokens < thistory) {
            console.log(`[Alpha/Context] Tight budget: trimming history window (${thistory} → ${tightenedTokens} tokens)`)
            finalHistory = tightenedHistory
            thistory = tightenedTokens
            total = tsoul + tuser + tproact + tpulse + thistory + ttools
        }
    }

    if (total > WARN_TOKENS && hasSection(userContext, '## Graph Context')) {
        const withoutGraph = removeSection(userContext, '## Graph Context')
        const graphlessTokens = countTokens(withoutGraph)
        if (graphlessTokens < tuser) {
            console.log(`[Alpha/Context] Tight budget: dropping graph context (${tuser} → ${graphlessTokens} tokens)`)
            userContext = withoutGraph
            tuser = graphlessTokens
            total = tsoul + tuser + tproact + tpulse + thistory + ttools
        }
    }

    if (total > MAX_TOKENS) {
        // Trim oversized tool payloads before touching conversation history.
        if (total > MAX_TOKENS) {
            const allowedTools = Math.max(0, MAX_TOKENS - (total - ttools))
            compressedTools = compressToolResults(compressedTools, allowedTools, gathered.activeToolName)
            ttools = countTokens(compressedTools)
            total = tsoul + tuser + tproact + tpulse + thistory + ttools
        }

        if (total > MAX_TOKENS) {
            const allowedHistory = Math.max(0, MAX_TOKENS - (total - thistory))
            if (allowedHistory < thistory) {
                const result = truncateHistory(finalHistory, allowedHistory)
                console.log(`[Alpha/Context] OVERFLOW: ${total}/${MAX_TOKENS} — trimming history (${thistory} → ${result.newTokens} tokens)`)
                finalHistory = result.truncated
                thistory = result.newTokens
                total = tsoul + tuser + tproact + tpulse + thistory + ttools
            }
        }

        if (total > MAX_TOKENS) {
            const allowedUser = Math.max(0, MAX_TOKENS - (total - tuser))
            userContext = userContext.slice(0, allowedUser * 4)
            tuser = countTokens(userContext)
            total = tsoul + tuser + tproact + tpulse + thistory + ttools
        }

        if (total > MAX_TOKENS) {
            const allowedProact = Math.max(0, MAX_TOKENS - (total - tproact))
            proactiveState = proactiveState.slice(0, allowedProact * 4)
            tproact = countTokens(proactiveState)
            total = tsoul + tuser + tproact + tpulse + thistory + ttools
        }
    }

    if (total > WARN_TOKENS) {
        console.warn(`[Alpha/Context] Warning: context budget high (${total}/${MAX_TOKENS})`)
    }
    console.log(`[Alpha/Context] Budget: soul=${tsoul} ctx=${tuser} proactive=${tproact} pulse=${tpulse} history=${thistory} tools=${ttools} total=${total}/${MAX_TOKENS}`)

    return {
        soul,
        userContext,
        proactiveState,
        pulseTopics: gathered.pulseTopics,
        history: finalHistory,
        toolResults: compressedTools
    }
}

function sanitizeToolPayloadString(results: string): string {
    try {
        return JSON.stringify(stripMediaFields(JSON.parse(results)))
    } catch {
        return results
    }
}

function stripMediaFields(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripMediaFields)
    }

    if (!value || typeof value !== 'object') {
        if (typeof value === 'string' && looksLikeMediaUrl(value)) {
            return '[media-removed]'
        }
        return value
    }

    const sanitized: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (/(image|photo|thumbnail|video|sprite|media|mapUrl|photoUrl|imageUrl|photoUri|imageUri)/i.test(key)) {
            continue
        }
        const stripped = stripMediaFields(nested)
        if (stripped !== undefined) {
            sanitized[key] = stripped
        }
    }
    return sanitized
}

function looksLikeMediaUrl(value: string): boolean {
    return /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp|svg|bmp|mp4|mov|avi|webm)(\?\S*)?$/i.test(value)
}

function keepRecentMessages(history: ChatMessage[], recentCount: number): ChatMessage[] {
    const systemMessages = history.filter(msg => msg.role === 'system')
    const nonSystemMessages = history.filter(msg => msg.role !== 'system')
    return [...systemMessages, ...nonSystemMessages.slice(-recentCount)]
}

function hasSection(text: string, heading: string): boolean {
    return text.includes(`${heading}\n`) || text.endsWith(heading)
}

function removeSection(text: string, heading: string): string {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:\\n|^)${escapedHeading}\\n[\\s\\S]*?(?=\\n## |$)`, 'm')
    return text.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim()
}
