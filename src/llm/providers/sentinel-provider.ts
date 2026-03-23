import { logger } from '../../utils/logger.js'
import { BedrockSentinelAdapter } from './bedrock.js'
import { TogetherBatchAdapter } from './together-batch.js'
import type { SentinelOptions, SentinelProvider, SentinelScoreResult } from './sentinel-types.js'
import { estimateTokens } from './sentinel-types.js'

interface RealtimeSentinelScorer {
  score(prompt: string, opts?: SentinelOptions): Promise<SentinelScoreResult>
}

interface BatchSentinelScorer {
  score(prompt: string, opts?: SentinelOptions): Promise<SentinelScoreResult>
  batchScore(prompts: string[], opts?: SentinelOptions): Promise<SentinelScoreResult[]>
}

export interface SentinelProviderDeps {
  realtime?: RealtimeSentinelScorer
  batch?: BatchSentinelScorer
}

export interface SentinelScoringInput {
  stimulusType: string
  stimulusKey: string
  stimulusData: unknown
  pulseState: string
  pulseScore: number
  proactiveCountToday: number
  maxPerDay: number
  matchedPreferences?: string[]
  userId?: string
}

function buildStructuredScoringPrompt(input: SentinelScoringInput): string {
  return [
    `Stimulus type: ${input.stimulusType}`,
    `Stimulus key: ${input.stimulusKey}`,
    `Pulse state: ${input.pulseState} (score=${input.pulseScore})`,
    `Proactive sent today: ${input.proactiveCountToday}/${input.maxPerDay}`,
    `Matched preferences: ${input.matchedPreferences?.join(', ') || 'none'}`,
    'Stimulus data:',
    JSON.stringify(input.stimulusData, null, 2).slice(0, 1000),
  ].join('\n')
}

class DefaultSentinelProvider implements SentinelProvider {
  readonly name = 'sentinel-provider'
  private readonly realtime: RealtimeSentinelScorer
  private readonly batch: BatchSentinelScorer

  constructor(deps: SentinelProviderDeps = {}) {
    this.realtime = deps.realtime ?? new BedrockSentinelAdapter()
    this.batch = deps.batch ?? new TogetherBatchAdapter()
  }

  async score(prompt: string, opts: SentinelOptions = {}): Promise<SentinelScoreResult> {
    logger.info(
      `[Sentinel/Provider] Scoring stimulus: ${opts.stimulusKey ?? 'unknown'} for user=${opts.userId ?? 'unknown'}`,
      { estimatedInputTokens: estimateTokens(prompt) },
    )

    try {
      logger.info('[Sentinel/Provider] Using bedrock (real-time)')
      const result = await this.realtime.score(prompt, opts)
      logger.info(
        `[Sentinel/Provider] Result: ${result.action} score=${result.score.toFixed(2)} reason=${JSON.stringify(result.reason)} (${result.latencyMs}ms)`,
      )
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`[Sentinel/Provider] bedrock FAILED: ${reason}`)
      logger.warn('[Sentinel/Provider] Failover -> together-batch (single-item mode)')

      const result = await this.batch.score(prompt, opts)
      logger.info(
        `[Sentinel/Provider] Result: ${result.action} score=${result.score.toFixed(2)} reason=${JSON.stringify(result.reason)} (${result.latencyMs}ms)`,
      )
      return result
    }
  }

  async batchScore(prompts: string[], opts: SentinelOptions = {}): Promise<SentinelScoreResult[]> {
    const userCount = opts.userIds ? new Set(opts.userIds).size : 'unknown'
    logger.info(`[Sentinel/Provider] Batch scoring: ${prompts.length} stimuli across ${userCount} users`)
    logger.info('[Sentinel/Provider] Using together-batch')

    const startedAt = Date.now()
    const results = await this.batch.batchScore(prompts, opts)
    const elapsedMs = Date.now() - startedAt
    const fireCount = results.filter(result => result.action === 'FIRE').length
    const bufferCount = results.filter(result => result.action === 'BUFFER').length
    const dropCount = results.filter(result => result.action === 'DROP').length
    const avgMs = prompts.length > 0 ? Math.round(elapsedMs / prompts.length) : 0

    logger.info(
      `[Sentinel/Provider] Batch complete: ${prompts.length} scored in ${elapsedMs}ms (${avgMs}ms/stimulus avg)`,
      { estimatedInputTokens: prompts.reduce((total, prompt) => total + estimateTokens(prompt), 0) },
    )
    logger.info(`[Sentinel/Provider] Results: ${fireCount} FIRE, ${bufferCount} BUFFER, ${dropCount} DROP`)

    return results
  }
}

export function createSentinelProvider(deps: SentinelProviderDeps = {}): SentinelProvider {
  return new DefaultSentinelProvider(deps)
}

export const sentinelProvider = createSentinelProvider()

export async function sentinelScore(input: SentinelScoringInput): Promise<SentinelScoreResult> {
  return sentinelProvider.score(buildStructuredScoringPrompt(input), {
    userId: input.userId,
    stimulusKey: input.stimulusKey,
  })
}

export async function sentinelBatchScore(inputs: SentinelScoringInput[]): Promise<SentinelScoreResult[]> {
  return sentinelProvider.batchScore(
    inputs.map(buildStructuredScoringPrompt),
    {
      userIds: inputs
        .map(input => input.userId)
        .filter((userId): userId is string => typeof userId === 'string' && userId.length > 0),
    },
  )
}
