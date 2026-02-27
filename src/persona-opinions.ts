/**
 * Persona Opinions — Stateful Persona Architecture
 *
 * DB helpers to persist and retrieve Aria's formed opinions about topics relevant
 * to a specific user (e.g. "User prefers window seats", "User dislikes Zomato UX").
 *
 * Opinions are injected as a late layer in the system prompt so Aria can speak
 * with continuity ("Last time you mentioned you found Zomato slow…").
 *
 * Table: persona_opinions (see database/persona-opinions.sql)
 *
 * @see ARCHITECTURE.md — Persona Opinions section
 */

import type { Pool } from 'pg'
import { safeError } from './utils/safe-log.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PersonaOpinion {
    id: string
    userId: string
    topic: string
    opinion: string
    context?: string
    createdAt: string
    updatedAt: string
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

/**
 * Load all opinions Aria holds about this user.
 * Returns an empty array (not throws) on DB error.
 */
export async function loadPersonaOpinions(
    pool: Pool,
    userId: string
): Promise<PersonaOpinion[]> {
    try {
        const result = await pool.query(
            `SELECT id, user_id, topic, opinion, context, created_at, updated_at
             FROM persona_opinions
             WHERE user_id = $1
             ORDER BY updated_at DESC
             LIMIT 20`,
            [userId]
        )
        return result.rows.map((row: any) => ({
            id:        row.id,
            userId:    row.user_id,
            topic:     row.topic,
            opinion:   row.opinion,
            context:   row.context ?? undefined,
            createdAt: row.created_at?.toISOString(),
            updatedAt: row.updated_at?.toISOString(),
        }))
    } catch (err) {
        console.error('[persona-opinions] loadPersonaOpinions failed:', safeError(err))
        return []
    }
}

/**
 * Upsert an opinion Aria has formed about a topic for a user.
 * Uses ON CONFLICT to update an existing opinion for the same (user_id, topic).
 */
export async function savePersonaOpinion(
    pool: Pool,
    userId: string,
    topic: string,
    opinion: string,
    context?: string
): Promise<void> {
    try {
        await pool.query(
            `INSERT INTO persona_opinions (user_id, topic, opinion, context)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, topic)
             DO UPDATE SET
               opinion    = EXCLUDED.opinion,
               context    = EXCLUDED.context,
               updated_at = NOW()`,
            [userId, topic.substring(0, 120), opinion.substring(0, 500), context ?? null]
        )
    } catch (err) {
        console.error('[persona-opinions] savePersonaOpinion failed:', safeError(err))
    }
}

// ─── Prompt Formatter ────────────────────────────────────────────────────────

/**
 * Format loaded opinions into a system-prompt-ready string.
 * Returns empty string if opinions is empty.
 *
 * @example
 *   formatOpinionsForPrompt([{ topic: 'airlines', opinion: 'Prefers IndiGo' }])
 *   // → "## Aria's Notes on This User\n- airlines: Prefers IndiGo"
 */
export function formatOpinionsForPrompt(opinions: PersonaOpinion[]): string {
    if (opinions.length === 0) return ''

    const lines = opinions
        .slice(0, 8) // cap at 8 to stay within token budget
        .map(o => `- ${o.topic}: ${o.opinion}`)

    return `## Aria's Notes on This User\n${lines.join('\n')}`
}
