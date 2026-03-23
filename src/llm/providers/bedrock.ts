import { sentinelClients } from '../../aws/aws-clients.js'
import { getAwsConfig } from '../../aws/aws-config.js'
import { buildSentinelScoringPrompt, getSentinelSoulPrompt } from './sentinel-prompt.js'
import type { SentinelOptions, SentinelScoreResult } from './sentinel-types.js'
import { parseSentinelModelOutput } from './sentinel-types.js'

interface BedrockClientLike {
  send(command: unknown): Promise<{
    output?: {
      message?: {
        content?: Array<{ text?: string }>
      }
    }
    metrics?: {
      latencyMs?: number
    }
  }>
}

interface BedrockCommandInput {
  modelId: string
  system: Array<{ text: string }>
  messages: Array<{
    role: 'user'
    content: Array<{ text: string }>
  }>
  inferenceConfig: {
    maxTokens: number
    temperature: number
  }
}

export interface BedrockSentinelAdapterOptions {
  getClient?: () => Promise<BedrockClientLike | null>
  buildCommand?: (input: BedrockCommandInput) => Promise<unknown>
  modelId?: string
  now?: () => number
}

export class BedrockSentinelAdapter {
  private readonly getClient: () => Promise<BedrockClientLike | null>
  private readonly buildCommand: (input: BedrockCommandInput) => Promise<unknown>
  private readonly modelId: string
  private readonly now: () => number

  constructor(options: BedrockSentinelAdapterOptions = {}) {
    this.getClient = options.getClient ?? (() => sentinelClients.getBedrock())
    this.buildCommand = options.buildCommand ?? this.defaultBuildCommand
    this.modelId = options.modelId ?? getAwsConfig().bedrock.modelId
    this.now = options.now ?? Date.now
  }

  async score(prompt: string, opts: SentinelOptions = {}): Promise<SentinelScoreResult> {
    const client = await this.getClient()
    if (!client) {
      throw new Error('AWS Bedrock is not configured for Sentinel')
    }

    const start = this.now()
    const command = await this.buildCommand({
      modelId: this.modelId,
      system: [{ text: getSentinelSoulPrompt() }],
      messages: [
        {
          role: 'user',
          content: [{ text: buildSentinelScoringPrompt(prompt) }],
        },
      ],
      inferenceConfig: {
        maxTokens: opts.maxTokens ?? 250,
        temperature: opts.temperature ?? 0,
      },
    })

    const response = await client.send(command)
    const text = response.output?.message?.content?.map(part => part.text ?? '').join('').trim() ?? ''
    const latencyMs = response.metrics?.latencyMs ?? (this.now() - start)
    return parseSentinelModelOutput(text, 'bedrock', latencyMs)
  }

  private async defaultBuildCommand(input: BedrockCommandInput): Promise<unknown> {
    const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime')
    return new ConverseCommand(input)
  }
}
