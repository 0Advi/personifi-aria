import { describe, expect, it, vi } from 'vitest'
import { buildSentinelScoringPrompt, getSentinelSoulPrompt } from './sentinel-prompt.js'
import { createSentinelProvider } from './sentinel-provider.js'

describe('sentinel prompt helpers', () => {
  it('loads sentinel-soul.md and keeps the scoring contract in the user prompt', () => {
    const soul = getSentinelSoulPrompt()
    const prompt = buildSentinelScoringPrompt('rain + commute')

    expect(soul).toContain('background scoring engine')
    expect(prompt).toContain('FIRE|BUFFER|DROP')
    expect(prompt).toContain('rain + commute')
  })
})

describe('createSentinelProvider', () => {
  it('uses Bedrock as the primary real-time scorer', async () => {
    const realtime = {
      score: vi.fn().mockResolvedValue({
        action: 'FIRE',
        score: 0.9,
        reason: 'strong match',
        latencyMs: 300,
        provider: 'bedrock',
      }),
    }
    const batch = {
      score: vi.fn(),
      batchScore: vi.fn(),
    }

    const provider = createSentinelProvider({ realtime, batch })
    const result = await provider.score('strong weather signal', { userId: 'u1', stimulusKey: 'weather/rain_commute' })

    expect(result.action).toBe('FIRE')
    expect(realtime.score).toHaveBeenCalledTimes(1)
    expect(batch.score).not.toHaveBeenCalled()
  })

  it('fails over to Together Batch when Bedrock throws', async () => {
    const realtime = {
      score: vi.fn().mockRejectedValue(new Error('ThrottlingException')),
    }
    const batch = {
      score: vi.fn().mockResolvedValue({
        action: 'BUFFER',
        score: 0.66,
        reason: 'fallback batch result',
        latencyMs: 420,
        provider: 'together-batch',
      }),
      batchScore: vi.fn(),
    }

    const provider = createSentinelProvider({ realtime, batch })
    const result = await provider.score('fallback stimulus', { userId: 'u2', stimulusKey: 'traffic/commute' })

    expect(result.action).toBe('BUFFER')
    expect(realtime.score).toHaveBeenCalledTimes(1)
    expect(batch.score).toHaveBeenCalledTimes(1)
  })

  it('uses Together Batch for multi-item scoring', async () => {
    const provider = createSentinelProvider({
      realtime: {
        score: vi.fn(),
      },
      batch: {
        score: vi.fn(),
        batchScore: vi.fn().mockResolvedValue([
          { action: 'FIRE', score: 0.82, reason: 'one', latencyMs: 80, provider: 'together-batch' },
          { action: 'DROP', score: 0.12, reason: 'two', latencyMs: 80, provider: 'together-batch' },
        ]),
      },
    })

    const results = await provider.batchScore(['first', 'second'], { userIds: ['u1', 'u2'] })

    expect(results).toHaveLength(2)
    expect(results[0]?.action).toBe('FIRE')
    expect(results[1]?.action).toBe('DROP')
  })
})
