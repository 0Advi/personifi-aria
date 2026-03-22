import { getPool } from '../character/session-store.js'

export interface ReminderRecord {
  reminderId: string
  userId: string
  message: string
  timeText: string
  scheduledFor: string | null
  status: 'pending' | 'scheduled'
}

export async function createReminder(
  userId: string,
  message: string,
  timeText: string,
): Promise<ReminderRecord> {
  const pool = getPool()
  const scheduledFor = parseReminderTime(timeText)
  const status = scheduledFor ? 'scheduled' : 'pending'

  const { rows } = await pool.query<{
    reminder_id: string
    user_id: string
    message: string
    time_text: string
    scheduled_for: Date | null
    status: 'pending' | 'scheduled'
  }>(
    `INSERT INTO user_reminders (user_id, message, time_text, scheduled_for, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING reminder_id, user_id, message, time_text, scheduled_for, status`,
    [userId, message.trim(), timeText.trim(), scheduledFor, status],
  )

  const row = rows[0]
  return {
    reminderId: row.reminder_id,
    userId: row.user_id,
    message: row.message,
    timeText: row.time_text,
    scheduledFor: row.scheduled_for ? row.scheduled_for.toISOString() : null,
    status: row.status,
  }
}

function parseReminderTime(raw: string): Date | null {
  const text = raw.trim()
  if (!text) return null

  const relative = parseRelativeTime(text)
  if (relative) return relative

  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime())) {
    return direct
  }

  const tomorrow = text.match(/\btomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (tomorrow) {
    const date = new Date()
    date.setDate(date.getDate() + 1)
    const hours = normalizeHours(Number(tomorrow[1]), tomorrow[3])
    date.setHours(hours, tomorrow[2] ? Number(tomorrow[2]) : 0, 0, 0)
    return date
  }

  return null
}

function parseRelativeTime(text: string): Date | null {
  const match = text.match(/\bin\s+(\d+)\s*(minute|minutes|hour|hours|day|days)\b/i)
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null

  const now = new Date()
  const unit = match[2].toLowerCase()
  const minutes = unit.startsWith('minute')
    ? amount
    : unit.startsWith('hour')
      ? amount * 60
      : amount * 24 * 60

  return new Date(now.getTime() + minutes * 60_000)
}

function normalizeHours(hours: number, meridiem?: string): number {
  if (!meridiem) return hours
  const lower = meridiem.toLowerCase()
  if (lower === 'pm' && hours < 12) return hours + 12
  if (lower === 'am' && hours === 12) return 0
  return hours
}
