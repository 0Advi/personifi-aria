import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeAlphaTool, matchesPrefetchedTool } from './tool-executor.js'

const mockExecuteTool = vi.fn()
const mockLookupFriendActivity = vi.fn()
const mockCreateReminder = vi.fn()

vi.mock('./tools/index.js', () => ({
    bodyHooks: {
        executeTool: (...args: unknown[]) => mockExecuteTool(...args),
    },
}))

vi.mock('./social/friend-activity.js', () => ({
    lookupFriendActivity: (...args: unknown[]) => mockLookupFriendActivity(...args),
}))

vi.mock('./reminders/store.js', () => ({
    createReminder: (...args: unknown[]) => mockCreateReminder(...args),
}))

describe('executeAlphaTool', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockExecuteTool.mockResolvedValue({ success: true, data: { ok: true } })
        mockLookupFriendActivity.mockResolvedValue({
            friendId: 'friend-1',
            displayName: 'Rohan',
            alias: null,
            pulseState: 'ENGAGED',
            lastTopic: 'brunch plans',
            lastMessageAt: '2026-03-22T10:00:00.000Z',
            lastActiveAt: '2026-03-22T10:01:00.000Z',
            activitySummary: 'Rohan is active.',
        })
        mockCreateReminder.mockResolvedValue({
            reminderId: 'rem-1',
            message: 'Buy milk',
            timeText: '7pm',
            scheduledFor: '2026-03-22T19:00:00.000Z',
            status: 'scheduled',
        })
    })

    it('maps cab_compare to compare_rides with normalized args', async () => {
        await executeAlphaTool('cab_compare', { origin: 'Koramangala', destination: 'Airport' })
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_rides', {
            origin: 'Koramangala',
            destination: 'Airport',
        })
    })

    it('maps event_lookup to search_places with event-aware params', async () => {
        await executeAlphaTool('event_lookup', { query: 'standup comedy', location: 'HSR Layout' })
        expect(mockExecuteTool).toHaveBeenCalledWith('search_places', {
            query: 'events: standup comedy',
            location: 'HSR Layout',
            openNow: false,
        })
    })

    it('creates a reminder through the reminder store', async () => {
        const result = await executeAlphaTool('set_reminder', { message: 'Buy milk', time: '7pm' }, { userId: 'user-1' })
        expect(result.success).toBe(true)
        expect(mockExecuteTool).not.toHaveBeenCalled()
        expect(mockCreateReminder).toHaveBeenCalledWith('user-1', 'Buy milk', '7pm')
    })

    it('looks up friend activity through the social graph', async () => {
        const result = await executeAlphaTool('friend_activity', { friendId: 'Rohan' }, { userId: 'user-1' })

        expect(result.success).toBe(true)
        expect(mockLookupFriendActivity).toHaveBeenCalledWith('user-1', 'Rohan')
        expect(mockExecuteTool).not.toHaveBeenCalled()
    })
})

describe('matchesPrefetchedTool', () => {
    it('matches prefetched Alpha tool names or their legacy mapping', () => {
        expect(matchesPrefetchedTool('cab_compare', 'cab_compare')).toBe(true)
        expect(matchesPrefetchedTool('compare_rides', 'cab_compare')).toBe(true)
        expect(matchesPrefetchedTool('search_places', 'cab_compare')).toBe(false)
    })
})
