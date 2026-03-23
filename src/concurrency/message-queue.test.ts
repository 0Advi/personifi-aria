import { describe, expect, it } from 'vitest'
import {
  MessageQueue,
  QueueOverflowError,
  WebhookDeduper,
  extractTelegramWebhookDedupKey,
} from './message-queue.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('MessageQueue', () => {
  it('processes same-user jobs sequentially', async () => {
    const queue = new MessageQueue({ maxConcurrentUsers: 10, maxQueueDepthPerUser: 5 })
    const firstGate = deferred<void>()
    const firstStarted = deferred<void>()
    const order: string[] = []

    const first = queue.enqueue({
      userId: 'user-1',
      jobId: 'msg#1',
      task: async () => {
        order.push('first:start')
        firstStarted.resolve()
        await firstGate.promise
        order.push('first:end')
        return 'first'
      },
    })

    await firstStarted.promise

    const second = queue.enqueue({
      userId: 'user-1',
      jobId: 'msg#2',
      task: async () => {
        order.push('second:start')
        return 'second'
      },
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    firstGate.resolve()

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs different users in parallel', async () => {
    const queue = new MessageQueue({ maxConcurrentUsers: 10, maxQueueDepthPerUser: 5 })
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const started: string[] = []

    const first = queue.enqueue({
      userId: 'user-a',
      jobId: 'msg#1',
      task: async () => {
        started.push('user-a')
        firstStarted.resolve()
        await firstGate.promise
        return 'a'
      },
    })

    const second = queue.enqueue({
      userId: 'user-b',
      jobId: 'msg#1',
      task: async () => {
        started.push('user-b')
        secondStarted.resolve()
        await secondGate.promise
        return 'b'
      },
    })

    await Promise.all([firstStarted.promise, secondStarted.promise])

    expect(started.sort()).toEqual(['user-a', 'user-b'])

    firstGate.resolve()
    secondGate.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
  })

  it('caps global cross-user concurrency', async () => {
    const queue = new MessageQueue({ maxConcurrentUsers: 1, maxQueueDepthPerUser: 5 })
    const firstGate = deferred<void>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const started: string[] = []

    const first = queue.enqueue({
      userId: 'user-a',
      jobId: 'msg#1',
      task: async () => {
        started.push('user-a')
        firstStarted.resolve()
        await firstGate.promise
        return 'a'
      },
    })

    const second = queue.enqueue({
      userId: 'user-b',
      jobId: 'msg#1',
      task: async () => {
        started.push('user-b')
        secondStarted.resolve()
        return 'b'
      },
    })

    await firstStarted.promise
    expect(started).toEqual(['user-a'])

    firstGate.resolve()
    await secondStarted.promise

    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
    expect(started).toEqual(['user-a', 'user-b'])
  })

  it('rejects when a user queue exceeds max depth', async () => {
    const queue = new MessageQueue({ maxConcurrentUsers: 10, maxQueueDepthPerUser: 5 })
    const blocker = deferred<void>()

    const accepted = Array.from({ length: 5 }, (_, index) =>
      queue.enqueue({
        userId: 'user-1',
        jobId: `msg#${index + 1}`,
        task: async () => {
          await blocker.promise
          return index
        },
      }),
    )

    await expect(
      queue.enqueue({
        userId: 'user-1',
        jobId: 'msg#6',
        task: async () => 6,
      }),
    ).rejects.toBeInstanceOf(QueueOverflowError)

    blocker.resolve()
    await expect(Promise.all(accepted)).resolves.toEqual([0, 1, 2, 3, 4])
  })
})

describe('WebhookDeduper', () => {
  it('suppresses duplicates within the TTL window', () => {
    let now = 1_000
    const deduper = new WebhookDeduper({ ttlMs: 1_000, now: () => now })

    expect(deduper.rememberIfNew('telegram:update:1')).toBe(true)
    expect(deduper.rememberIfNew('telegram:update:1')).toBe(false)

    now += 1_001
    expect(deduper.rememberIfNew('telegram:update:1')).toBe(true)
  })
})

describe('extractTelegramWebhookDedupKey', () => {
  it('prefers update_id when present', () => {
    expect(extractTelegramWebhookDedupKey({ update_id: 42 })).toBe('telegram:update:42')
  })

  it('falls back to callback id', () => {
    expect(extractTelegramWebhookDedupKey({ callback_query: { id: 'cb-1' } })).toBe('telegram:callback:cb-1')
  })

  it('falls back to message id and chat id', () => {
    expect(
      extractTelegramWebhookDedupKey({
        message: {
          message_id: 7,
          chat: { id: 99 },
        },
      }),
    ).toBe('telegram:message:99:7')
  })
})
