import { getPool } from '../character/session-store.js'
import { getFriends } from './friend-graph.js'
import type { FriendInfo } from './types.js'

export interface FriendActivityResult {
  friendId: string
  displayName: string | null
  alias: string | null
  pulseState: string | null
  lastTopic: string | null
  lastMessageAt: string | null
  lastActiveAt: string | null
  activitySummary: string
}

export async function lookupFriendActivity(
  userId: string,
  friendRef: string,
): Promise<FriendActivityResult | null> {
  const friends = await getFriends(userId)
  const friend = findFriendMatch(friends, friendRef)
  if (!friend) return null

  const pool = getPool()
  const [pulseRes, sessionRes] = await Promise.all([
    pool.query<{
      current_state: string | null
      last_topic: string | null
      last_message_at: Date | null
    }>(
      `SELECT current_state, last_topic, last_message_at
       FROM pulse_engagement_scores
       WHERE user_id = $1
       LIMIT 1`,
      [friend.friendId],
    ).catch(() => ({ rows: [] })),
    pool.query<{
      last_active: Date | null
    }>(
      `SELECT last_active
       FROM sessions
       WHERE user_id = $1
       ORDER BY last_active DESC
       LIMIT 1`,
      [friend.friendId],
    ).catch(() => ({ rows: [] })),
  ])

  const pulse = pulseRes.rows[0]
  const session = sessionRes.rows[0]
  const lastMessageAt = pulse?.last_message_at ? pulse.last_message_at.toISOString() : null
  const lastActiveAt = session?.last_active ? session.last_active.toISOString() : null

  return {
    friendId: friend.friendId,
    displayName: friend.displayName,
    alias: friend.alias,
    pulseState: pulse?.current_state ?? null,
    lastTopic: pulse?.last_topic ?? null,
    lastMessageAt,
    lastActiveAt,
    activitySummary: buildActivitySummary(friend, pulse?.current_state ?? null, pulse?.last_topic ?? null, lastActiveAt),
  }
}

function findFriendMatch(friends: FriendInfo[], friendRef: string): FriendInfo | null {
  const normalized = friendRef.trim().toLowerCase()
  if (!normalized) return null

  const exact = friends.find(friend =>
    [friend.friendId, friend.displayName, friend.alias, friend.channelUserId]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .some(value => value.toLowerCase() === normalized),
  )
  if (exact) return exact

  return friends.find(friend =>
    [friend.displayName, friend.alias, friend.channelUserId]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .some(value => value.toLowerCase().includes(normalized)),
  ) ?? null
}

function buildActivitySummary(
  friend: FriendInfo,
  pulseState: string | null,
  lastTopic: string | null,
  lastActiveAt: string | null,
): string {
  const name = friend.alias || friend.displayName || friend.channelUserId
  const pieces = [`${name} is in your friend graph.`]

  if (pulseState) pieces.push(`Current engagement: ${pulseState}.`)
  if (lastTopic) pieces.push(`Recent topic: ${lastTopic}.`)
  if (lastActiveAt) {
    pieces.push(`Last active: ${lastActiveAt}.`)
  } else {
    pieces.push('No recent activity snapshot is available yet.')
  }

  return pieces.join(' ')
}
