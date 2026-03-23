import { describe, expect, it } from 'vitest'
import { BedrockSentinelAdapter } from './bedrock.js'

describe('BedrockSentinelAdapter', () => {
  it('scores a prompt via Converse output', async () => {
    const adapter = new BedrockSentinelAdapter({
      modelId: 'bedrock-model',
      getClient: async () => ({
        send: async () => ({
          output: {
            message: {
              content: [{ text: '{"action":"FIRE","score":0.87,"reason":"rain + commute match"}' }],
            },
          },
          metrics: {
            latencyMs: 340,
          },
        }),
      }),
      buildCommand: async input => input,
    })

    const result = await adapter.score('rain + commute stimulus', { userId: 'user-1', stimulusKey: 'weather/rain_commute' })

    expect(result).toEqual({
      action: 'FIRE',
      score: 0.87,
      reason: 'rain + commute match',
      latencyMs: 340,
      provider: 'bedrock',
    })
  })

  it('defaults invalid model output to DROP', async () => {
    const adapter = new BedrockSentinelAdapter({
      modelId: 'bedrock-model',
      getClient: async () => ({
        send: async () => ({
          output: {
            message: {
              content: [{ text: 'not json' }],
            },
          },
          metrics: {
            latencyMs: 200,
          },
        }),
      }),
      buildCommand: async input => input,
    })

    const result = await adapter.score('invalid output stimulus')

    expect(result.action).toBe('DROP')
    expect(result.reason).toBe('invalid model output')
  })
})
