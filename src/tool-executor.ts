import { bodyHooks } from './tools/index.js'
import type { ToolExecutionResult } from './hooks.js'
import { ALPHA_TOOL_NAMES } from './tool-definitions.js'
import { lookupFriendActivity } from './social/friend-activity.js'
import { createReminder } from './reminders/store.js'

const ALPHA_TO_LEGACY: Record<string, string> = {
    cab_compare: 'compare_rides',
    place_search: 'search_places',
    weather_check: 'get_weather',
    food_finder: 'compare_food_prices',
    price_alert: 'compare_prices_proactive',
    event_lookup: 'search_places',
    friend_activity: '__internal__',
    set_reminder: '__internal__',
}

export function getLegacyToolName(alphaToolName: string): string | null {
    return ALPHA_TO_LEGACY[alphaToolName] ?? null
}

export function matchesPrefetchedTool(prefetchedToolName: string | null | undefined, alphaToolName: string): boolean {
    if (!prefetchedToolName) return false
    return prefetchedToolName === alphaToolName || prefetchedToolName === getLegacyToolName(alphaToolName)
}

export async function executeAlphaTool(
    name: string,
    args: Record<string, unknown>,
    context?: { userId?: string },
): Promise<ToolExecutionResult> {
    if (!ALPHA_TOOL_NAMES.has(name)) {
        return { success: false, data: null, error: `Unknown Alpha tool: ${name}` }
    }

    const legacyName = getLegacyToolName(name)
    if (!legacyName) {
        return { success: false, data: null, error: `No legacy mapping for Alpha tool: ${name}` }
    }

    if (legacyName === '__internal__') {
        return executeInternalTool(name, args, context)
    }

    return bodyHooks.executeTool(legacyName, normalizeArgs(name, args))
}

function normalizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (name) {
        case 'cab_compare':
            return {
                origin: args.origin,
                destination: args.destination,
            }
        case 'event_lookup':
            return {
                query: `events: ${String(args.query ?? '').trim()}`.trim(),
                location: args.location,
                openNow: false,
            }
        default:
            return args
    }
}

async function executeInternalTool(
    name: string,
    args: Record<string, unknown>,
    context?: { userId?: string },
): Promise<ToolExecutionResult> {
    if (name === 'friend_activity') {
        const friendRef = String(args.friendId ?? '').trim()
        if (!friendRef) {
            return { success: false, data: null, error: 'friendId is required for friend_activity' }
        }
        const userId = typeof context?.userId === 'string' ? context.userId : null
        if (!userId) {
            return { success: false, data: null, error: 'Missing user context for friend_activity' }
        }
        const activity = await lookupFriendActivity(userId, friendRef)
        if (!activity) {
            return { success: false, data: null, error: `No connected friend found for "${friendRef}"` }
        }
        return { success: true, data: activity }
    }

    if (name === 'set_reminder') {
        const userId = typeof context?.userId === 'string' ? context.userId : null
        const message = String(args.message ?? '').trim()
        const time = String(args.time ?? '').trim()
        if (!userId) {
            return { success: false, data: null, error: 'Missing user context for set_reminder' }
        }
        if (!message || !time) {
            return { success: false, data: null, error: 'message and time are required for set_reminder' }
        }
        const reminder = await createReminder(userId, message, time)
        return {
            success: true,
            data: {
                reminderId: reminder.reminderId,
                message: reminder.message,
                timeText: reminder.timeText,
                scheduledFor: reminder.scheduledFor,
                status: reminder.status,
            },
        }
    }

    return { success: false, data: null, error: `Unsupported Alpha tool: ${name}` }
}
