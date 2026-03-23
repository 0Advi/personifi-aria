export type SentinelAction = 'FIRE' | 'BUFFER' | 'DROP'

export interface SentinelOptions {
  userId?: string
  userIds?: string[]
  stimulusKey?: string
  maxTokens?: number
  temperature?: number
  batchTimeoutMs?: number
}

export interface SentinelScoreResult {
  action: SentinelAction
  score: number
  reason: string
  latencyMs: number
  provider?: string
}

export interface SentinelProvider {
  name: string
  score(prompt: string, opts?: SentinelOptions): Promise<SentinelScoreResult>
  batchScore(prompts: string[], opts?: SentinelOptions): Promise<SentinelScoreResult[]>
}

function stripJsonFences(text: string): string {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim()
}

function normalizeAction(value: unknown): SentinelAction | null {
  if (typeof value !== 'string') return null
  const action = value.toUpperCase()
  if (action === 'FIRE' || action === 'BUFFER' || action === 'DROP') {
    return action
  }
  return null
}

export function buildInvalidSentinelResult(reason: string, latencyMs: number, provider: string): SentinelScoreResult {
  return {
    action: 'DROP',
    score: 0,
    reason,
    latencyMs,
    provider,
  }
}

export function parseSentinelModelOutput(
  rawText: string,
  provider: string,
  latencyMs: number,
): SentinelScoreResult {
  try {
    const parsed = JSON.parse(stripJsonFences(rawText))
    const action = normalizeAction(parsed?.action)
    const score = typeof parsed?.score === 'number' ? Math.min(1, Math.max(0, parsed.score)) : null
    const reason = typeof parsed?.reason === 'string' ? parsed.reason.trim() : ''

    if (!action || score === null || !reason) {
      return buildInvalidSentinelResult('invalid model output', latencyMs, provider)
    }

    return {
      action,
      score,
      reason,
      latencyMs,
      provider,
    }
  } catch {
    return buildInvalidSentinelResult('invalid model output', latencyMs, provider)
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
