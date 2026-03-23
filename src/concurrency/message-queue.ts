/**
 * Message Queue — Per-User Concurrency Control (Issue #139)
 *
 * Guarantees:
 *   Same user   -> sequential processing (no races, correct ordering)
 *   Diff users  -> parallel processing (bounded by MAX_CONCURRENT_USERS)
 *
 * Features:
 *   1. Per-user Promise chain — each message awaits the previous one for that user
 *   2. Queue depth cap — reject when pending depth reaches MAX_QUEUE_DEPTH_PER_USER
 *   3. 5-minute webhook dedup helper for retry-safe delivery
 *   4. No external dependencies — in-memory Map based queue for single-instance deploys
 */

import { logger } from '../utils/logger.js'

export const DEFAULT_QUEUE_OVERFLOW_MESSAGE = "I'm processing your previous messages, one moment."
const DEFAULT_MAX_QUEUE_DEPTH_PER_USER = 5
const DEFAULT_MAX_CONCURRENT_USERS = 50

export interface MessageQueueOptions {
  maxQueueDepthPerUser?: number
  maxConcurrentUsers?: number
  now?: () => number
}

export interface QueueJob<T> {
  userId: string
  jobId: string
  task: () => Promise<T>
}

export class QueueOverflowError extends Error {
  readonly userId: string
  readonly queueDepth: number
  readonly maxQueueDepth: number

  constructor(userId: string, queueDepth: number, maxQueueDepth: number) {
    super(DEFAULT_QUEUE_OVERFLOW_MESSAGE)
    this.name = 'QueueOverflowError'
    this.userId = userId
    this.queueDepth = queueDepth
    this.maxQueueDepth = maxQueueDepth
  }
}

class GlobalConcurrencyGate {
  private activeCount = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) { }

  async acquire(): Promise<() => void> {
    if (this.limit <= 0 || this.activeCount < this.limit) {
      this.activeCount += 1
      return () => this.release()
    }

    return new Promise(resolve => {
      this.waiters.push(() => {
        this.activeCount += 1
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1)
    const next = this.waiters.shift()
    if (next) next()
  }
}

export class MessageQueue {
  private readonly maxQueueDepthPerUser: number
  private readonly now: () => number
  private readonly tails = new Map<string, Promise<void>>()
  private readonly depths = new Map<string, number>()
  private readonly concurrencyGate: GlobalConcurrencyGate

  constructor(options: MessageQueueOptions = {}) {
    this.maxQueueDepthPerUser = options.maxQueueDepthPerUser ?? DEFAULT_MAX_QUEUE_DEPTH_PER_USER
    this.now = options.now ?? Date.now
    this.concurrencyGate = new GlobalConcurrencyGate(options.maxConcurrentUsers ?? DEFAULT_MAX_CONCURRENT_USERS)
  }

  getDepth(userId: string): number {
    return this.depths.get(userId) ?? 0
  }

  async enqueue<T>({ userId, jobId, task }: QueueJob<T>): Promise<T> {
    const currentDepth = this.getDepth(userId)
    if (currentDepth >= this.maxQueueDepthPerUser) {
      logger.warn(`[Queue] user=${userId} enqueue ${jobId} rejected`, {
        queueDepth: currentDepth,
        maxQueueDepth: this.maxQueueDepthPerUser,
      })
      throw new QueueOverflowError(userId, currentDepth, this.maxQueueDepthPerUser)
    }

    const nextDepth = currentDepth + 1
    this.depths.set(userId, nextDepth)
    logger.info(`[Queue] user=${userId} enqueue ${jobId}`, {
      queueDepth: nextDepth,
      waiting: nextDepth > 1,
    })

    const previousTail = this.tails.get(userId) ?? Promise.resolve()
    const run = previousTail.catch(() => undefined).then(async () => {
      const release = await this.concurrencyGate.acquire()
      const start = this.now()

      logger.info(`[Queue] user=${userId} processing ${jobId}`)

      try {
        const result = await task()
        logger.info(`[Queue] user=${userId} ${jobId} complete`, {
          elapsedMs: this.now() - start,
        })
        return result
      } catch (error) {
        logger.error(`[Queue] user=${userId} ${jobId} failed`, {
          elapsedMs: this.now() - start,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      } finally {
        release()
      }
    })

    const settledTail = run.then(() => undefined, () => undefined)
    this.tails.set(userId, settledTail)

    return run.finally(() => {
      const remaining = Math.max(0, this.getDepth(userId) - 1)
      if (remaining === 0) {
        this.depths.delete(userId)
      } else {
        this.depths.set(userId, remaining)
      }

      if (this.tails.get(userId) === settledTail) {
        this.tails.delete(userId)
      }
    })
  }
}

export interface WebhookDeduperOptions {
  ttlMs?: number
  now?: () => number
}

export class WebhookDeduper {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly entries = new Map<string, number>()

  constructor(options: WebhookDeduperOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  rememberIfNew(key: string): boolean {
    const now = this.now()
    this.prune(now)

    const expiresAt = this.entries.get(key)
    if (expiresAt && expiresAt > now) {
      return false
    }

    this.entries.set(key, now + this.ttlMs)
    return true
  }

  size(): number {
    this.prune(this.now())
    return this.entries.size
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) {
        this.entries.delete(key)
      }
    }
  }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function stringifyDedupPart(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return null
}

export function extractTelegramWebhookDedupKey(body: unknown): string | null {
  if (!isRecord(body)) return null

  const updateId = stringifyDedupPart(body.update_id)
  if (updateId) {
    return `telegram:update:${updateId}`
  }

  const callbackQuery = isRecord(body.callback_query) ? body.callback_query : null
  const callbackId = stringifyDedupPart(callbackQuery?.id)
  if (callbackId) {
    return `telegram:callback:${callbackId}`
  }

  const message = isRecord(body.message) ? body.message : null
  const messageId = stringifyDedupPart(message?.message_id)
  const chat = isRecord(message?.chat) ? message?.chat : null
  const chatId = stringifyDedupPart(chat?.id)
  if (chatId && messageId) {
    return `telegram:message:${chatId}:${messageId}`
  }

  return null
}
