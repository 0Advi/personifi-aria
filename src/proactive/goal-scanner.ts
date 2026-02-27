/**
 * Goal Scanner — Stateful Persona Architecture
 *
 * Scans conversation_goals, memories (commitments), and price_alerts to produce
 * a list of proactive triggers that Aria can act on between user messages.
 *
 * Designed to run on a cron/background worker; returns lightweight trigger
 * objects so the caller can decide how to dispatch them (push, queue, etc.).
 *
 * @see ARCHITECTURE.md — Proactive Triggers section
 */

import type { Pool } from 'pg'
import { safeError } from '../utils/safe-log.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type TriggerKind =
    | 'goal_deadline'
    | 'memory_commitment'
    | 'price_alert'

export interface ProactiveTrigger {
    /** Type of trigger */
    kind: TriggerKind
    /** User to notify */
    userId: string
    /** Human-readable reason Aria should reach out */
    reason: string
    /** Optional structured payload (e.g. alert threshold, goal ID) */
    payload?: Record<string, unknown>
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────

async function scanGoals(pool: Pool): Promise<ProactiveTrigger[]> {
    try {
        // Goals whose target_date is within the next 48 hours and still active
        const result = await pool.query(`
            SELECT user_id, goal, context
            FROM conversation_goals
            WHERE status = 'active'
              AND context->>'target_date' IS NOT NULL
              AND (context->>'target_date')::timestamptz BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
            LIMIT 50
        `)
        return result.rows.map((row: any) => ({
            kind:    'goal_deadline' as const,
            userId:  row.user_id,
            reason:  `Goal deadline approaching: "${row.goal}"`,
            payload: { goal: row.goal, context: row.context },
        }))
    } catch (err) {
        console.warn('[goal-scanner] scanGoals failed:', safeError(err))
        return []
    }
}

async function scanMemoryCommitments(pool: Pool): Promise<ProactiveTrigger[]> {
    try {
        // Memories that look like commitments (e.g. "will", "planning to", "want to")
        // and haven't been accessed in 7+ days
        const result = await pool.query(`
            SELECT user_id, memory, id
            FROM memories
            WHERE memory ~* '\\y(will|planning to|want to|going to|need to|should)\\y'
              AND (last_accessed IS NULL OR last_accessed < NOW() - INTERVAL '7 days')
              AND (memory_type IS NULL OR memory_type = 'commitment')
            ORDER BY created_at DESC
            LIMIT 30
        `)
        return result.rows.map((row: any) => ({
            kind:    'memory_commitment' as const,
            userId:  row.user_id,
            reason:  `Unresolved commitment: "${row.memory}"`,
            payload: { memoryId: row.id, memory: row.memory },
        }))
    } catch (err) {
        console.warn('[goal-scanner] scanMemoryCommitments failed:', safeError(err))
        return []
    }
}

async function scanPriceAlerts(pool: Pool): Promise<ProactiveTrigger[]> {
    try {
        const result = await pool.query(`
            SELECT user_id, alert_id, description, target_price, current_price, currency
            FROM price_alerts
            WHERE active = TRUE
              AND current_price IS NOT NULL
              AND current_price <= target_price
              AND (last_triggered IS NULL OR last_triggered < NOW() - INTERVAL '6 hours')
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 50
        `)
        return result.rows.map((row: any) => ({
            kind:    'price_alert' as const,
            userId:  row.user_id,
            reason:  `Price alert triggered: ${row.description} — ${row.currency}${row.current_price} ≤ target ${row.currency}${row.target_price}`,
            payload: {
                alertId:      row.alert_id,
                description:  row.description,
                currentPrice: row.current_price,
                targetPrice:  row.target_price,
                currency:     row.currency,
            },
        }))
    } catch (err) {
        console.warn('[goal-scanner] scanPriceAlerts failed:', safeError(err))
        return []
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan all proactive trigger sources and return a merged list.
 * Each source is queried independently; failures degrade gracefully.
 *
 * @param pool - PostgreSQL pool
 * @returns Array of ProactiveTrigger sorted by kind (price_alert first)
 */
export async function scanGoalTriggers(pool: Pool): Promise<ProactiveTrigger[]> {
    const [goals, commitments, alerts] = await Promise.all([
        scanGoals(pool),
        scanMemoryCommitments(pool),
        scanPriceAlerts(pool),
    ])

    // Price alerts are most time-sensitive — put them first
    return [...alerts, ...goals, ...commitments]
}
