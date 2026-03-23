import { sentinelProvider } from './llm/providers/sentinel-provider.js'
import type { SentinelOptions, SentinelScoreResult } from './llm/providers/sentinel-types.js'

export async function scoreSentinelStimulus(
  prompt: string,
  opts: SentinelOptions = {},
): Promise<SentinelScoreResult> {
  return sentinelProvider.score(prompt, opts)
}

export async function batchScoreSentinelStimuli(
  prompts: string[],
  opts: SentinelOptions = {},
): Promise<SentinelScoreResult[]> {
  return sentinelProvider.batchScore(prompts, opts)
}

export { sentinelProvider }
export type { SentinelAction, SentinelOptions, SentinelProvider, SentinelScoreResult } from './llm/providers/sentinel-types.js'
