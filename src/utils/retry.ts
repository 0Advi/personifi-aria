/**
 * Groq API Retry Utility (#28)
 *
 * Wraps Groq LLM calls with exponential backoff retry.
 * Retries on transient failures: rate limits (429), server errors (500/502/503),
 * and network-level errors (ECONNRESET, ETIMEDOUT, fetch failed).
 *
 * Config:
 *   maxRetries: 2  (3 total attempts)
 *   baseDelayMs: 500
 *   maxDelayMs: 5000
 *
 * Usage:
 *   const result = await withGroqRetry(
 *     () => groq.chat.completions.create({...}),
 *     'groq-8b-classify'
 *   )
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503])
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 5000
const MAX_RETRIES = 2

function isRetryable(err: unknown): boolean {
    if (err && typeof err === 'object') {
        // Groq SDK error — has .status
        const status = (err as any).status ?? (err as any).statusCode
        if (typeof status === 'number') return RETRYABLE_STATUS.has(status)
        // Groq SDK wraps 429 in error.error.type
        const errType = (err as any).error?.type ?? ''
        if (errType === 'tokens' || errType === 'requests') return true
    }
    if (err instanceof Error) {
        const msg = err.message
        return (
            msg.includes('ECONNRESET') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('fetch failed') ||
            msg.includes('socket hang up') ||
            msg.includes('rate_limit') ||
            msg.includes('overloaded')
        )
    }
    return false
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a Groq API call with exponential backoff.
 *
 * @param fn    Zero-argument async function wrapping the Groq call
 * @param label Short label for log lines (e.g. 'groq-70b', 'groq-8b-classify')
 */
export interface RetryOptions {
    /** Maximum number of retries (default: 2 = 3 total attempts) */
    maxRetries?: number
    /** Base delay in ms for exponential backoff (default: 500) */
    baseDelayMs?: number
}

export async function withGroqRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options?: RetryOptions,
): Promise<T> {
    const maxRetries = options?.maxRetries ?? MAX_RETRIES
    const baseDelay = options?.baseDelayMs ?? BASE_DELAY_MS
    let lastErr: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err

            if (attempt === maxRetries || !isRetryable(err)) {
                throw err
            }

            const waitMs = Math.min(baseDelay * Math.pow(2, attempt), MAX_DELAY_MS)
            const status = (err as any)?.status ?? '?'
            console.warn(
                `[retry] ${label} attempt ${attempt + 1}/${maxRetries} failed` +
                ` (status: ${status}), retrying in ${waitMs}ms`
            )
            await delay(waitMs)
        }
    }

    throw lastErr
}
