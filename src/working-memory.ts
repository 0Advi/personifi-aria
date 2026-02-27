/**
 * Working Memory — Stateful Persona Architecture
 *
 * Redis-backed working memory with in-memory Map fallback.
 * Holds ephemeral per-session state: mood, active plan, last tool result, and a
 * running summary the personality layer can inject directly into the prompt.
 *
 * Usage:
 *   const wm = await loadWorkingMemory(redisClient, userId, sessionId)
 *   wm.currentMood = 'excited'
 *   await saveWorkingMemory(redisClient, userId, sessionId, wm)
 *
 * If REDIS_URL is not set, pass null as redisClient and the module uses an
 * in-process Map — safe for single-instance deployments and unit tests.
 *
 * @see ARCHITECTURE.md — Stateful Persona Architecture section
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type MoodState =
    | 'neutral'
    | 'excited'
    | 'empathetic'
    | 'playful'
    | 'focused'
    | 'stressed'

/** Valid mood transitions — prevents sudden jarring swings */
const VALID_TRANSITIONS: Record<MoodState, MoodState[]> = {
    neutral:    ['excited', 'empathetic', 'playful', 'focused', 'stressed'],
    excited:    ['neutral', 'playful', 'focused'],
    empathetic: ['neutral', 'focused', 'stressed'],
    playful:    ['neutral', 'excited'],
    focused:    ['neutral', 'empathetic', 'excited'],
    stressed:   ['neutral', 'empathetic', 'focused'],
}

export interface WorkingMemory {
    /** Short paragraph summarising the conversation so far (injected as Layer 3) */
    summary: string
    /** Current active plan Aria is helping with (injected as Layer 4) */
    activePlan: string
    /** Aria's current mood — used by mood engine + personality layer */
    currentMood: MoodState
    /** Stringified result of the last tool execution (for cross-turn context) */
    lastToolResult: string
    /** ISO timestamp of the last write */
    updatedAt: string
}

const DEFAULT_WORKING_MEMORY: WorkingMemory = {
    summary: '',
    activePlan: '',
    currentMood: 'neutral',
    lastToolResult: '',
    updatedAt: new Date().toISOString(),
}

// ─── Minimal Redis-compatible interface ─────────────────────────────────────
// Accepts ioredis, node-redis v4, or any client with get/set/del methods.

export interface RedisLike {
    get(key: string): Promise<string | null>
    set(key: string, value: string, ...args: any[]): Promise<any>
}

// ─── In-memory fallback ──────────────────────────────────────────────────────

const memoryFallback = new Map<string, WorkingMemory>()

function makeKey(userId: string, sessionId: string): string {
    return `wm:${userId}:${sessionId}`
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load working memory for a user+session.
 * Falls back to in-memory Map when redisClient is null.
 */
export async function loadWorkingMemory(
    redisClient: RedisLike | null,
    userId: string,
    sessionId: string
): Promise<WorkingMemory> {
    const key = makeKey(userId, sessionId)

    try {
        if (redisClient) {
            const raw = await redisClient.get(key)
            if (raw) {
                return { ...DEFAULT_WORKING_MEMORY, ...JSON.parse(raw) }
            }
        } else {
            const cached = memoryFallback.get(key)
            if (cached) return { ...DEFAULT_WORKING_MEMORY, ...cached }
        }
    } catch (err) {
        console.warn('[working-memory] load failed, returning default:', err)
    }

    return { ...DEFAULT_WORKING_MEMORY }
}

/**
 * Persist working memory for a user+session.
 * TTL defaults to 4 hours (14400 s) — expires between sessions.
 */
export async function saveWorkingMemory(
    redisClient: RedisLike | null,
    userId: string,
    sessionId: string,
    wm: WorkingMemory,
    ttlSeconds = 14400
): Promise<void> {
    const key = makeKey(userId, sessionId)
    const payload = { ...wm, updatedAt: new Date().toISOString() }

    try {
        if (redisClient) {
            await redisClient.set(key, JSON.stringify(payload), 'EX', ttlSeconds)
        } else {
            memoryFallback.set(key, payload)
        }
    } catch (err) {
        console.warn('[working-memory] save failed:', err)
    }
}

/**
 * Validate a proposed mood transition.
 * Returns the proposed mood if allowed, or the previous mood if blocked.
 *
 * @example
 *   validateMoodTransition('neutral', 'excited') // → 'excited'
 *   validateMoodTransition('excited', 'stressed') // → 'excited' (blocked)
 */
export function validateMoodTransition(
    prevMood: MoodState,
    proposedMood: MoodState
): MoodState {
    const allowed = VALID_TRANSITIONS[prevMood] ?? []
    if (allowed.includes(proposedMood)) return proposedMood
    console.warn(`[working-memory] Blocked mood transition ${prevMood} → ${proposedMood}`)
    return prevMood
}
