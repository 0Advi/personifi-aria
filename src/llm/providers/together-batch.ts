import { buildSentinelScoringPrompt, getSentinelSoulPrompt } from './sentinel-prompt.js'
import type { SentinelOptions, SentinelScoreResult } from './sentinel-types.js'
import { buildInvalidSentinelResult, parseSentinelModelOutput } from './sentinel-types.js'

interface TogetherFileResponse {
  id?: string
}

interface TogetherBatchCreateResponse {
  id?: string
  job?: {
    id?: string
    output_file_id?: string
  }
}

interface TogetherBatchStatusResponse {
  id?: string
  status?: string
  output_file_id?: string
  error?: string
}

interface TogetherBatchOutputLine {
  custom_id?: string
  response?: {
    body?: {
      choices?: Array<{
        message?: {
          content?: string
        }
      }>
    }
  }
  error?: {
    message?: string
  }
}

export interface TogetherBatchAdapterOptions {
  apiKey?: string
  model?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  now?: () => number
}

export class TogetherBatchAdapter {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly pollIntervalMs: number
  private readonly now: () => number

  constructor(options: TogetherBatchAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TOGETHER_API_KEY ?? ''
    this.model = options.model ?? process.env.TOGETHER_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
    this.baseUrl = options.baseUrl ?? 'https://api.together.ai/v1'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.now = options.now ?? Date.now
  }

  async score(prompt: string, opts: SentinelOptions = {}): Promise<SentinelScoreResult> {
    const [result] = await this.batchScore([prompt], opts)
    return result ?? buildInvalidSentinelResult('empty batch result', 0, 'together-batch')
  }

  async batchScore(prompts: string[], opts: SentinelOptions = {}): Promise<SentinelScoreResult[]> {
    if (!this.apiKey) {
      throw new Error('TOGETHER_API_KEY is not set')
    }

    if (prompts.length === 0) {
      return []
    }

    const start = this.now()
    const batchLines = prompts.map((prompt, index) => JSON.stringify({
      custom_id: `sentinel-${index}`,
      body: {
        model: this.model,
        messages: [
          { role: 'system', content: getSentinelSoulPrompt() },
          { role: 'user', content: buildSentinelScoringPrompt(prompt) },
        ],
        max_tokens: opts.maxTokens ?? 250,
        temperature: opts.temperature ?? 0,
      },
    }))

    const inputFileId = await this.uploadInputFile(batchLines.join('\n'))
    const batchId = await this.createBatch(inputFileId)
    const outputFileId = await this.waitForCompletion(batchId, opts.batchTimeoutMs ?? 30_000)
    const outputContent = await this.fetchOutputFile(outputFileId)
    const elapsedMs = this.now() - start
    const perItemLatencyMs = Math.max(1, Math.round(elapsedMs / prompts.length))

    const parsedLines = outputContent
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as TogetherBatchOutputLine)

    const lineByCustomId = new Map(parsedLines.map(line => [line.custom_id ?? '', line]))

    return prompts.map((_, index) => {
      const customId = `sentinel-${index}`
      const line = lineByCustomId.get(customId)

      if (!line) {
        return buildInvalidSentinelResult('missing batch output', perItemLatencyMs, 'together-batch')
      }

      if (line.error?.message) {
        return buildInvalidSentinelResult(line.error.message, perItemLatencyMs, 'together-batch')
      }

      const content = line.response?.body?.choices?.[0]?.message?.content ?? ''
      return parseSentinelModelOutput(content, 'together-batch', perItemLatencyMs)
    })
  }

  private async uploadInputFile(fileContent: string): Promise<string> {
    const form = new FormData()
    form.append('purpose', 'batch-api')
    form.append('file', new Blob([fileContent], { type: 'application/jsonl' }), 'sentinel-batch.jsonl')

    const response = await this.fetchJson<TogetherFileResponse>('/files', {
      method: 'POST',
      body: form,
    })

    if (!response.id) {
      throw new Error('Together file upload did not return an id')
    }

    return response.id
  }

  private async createBatch(inputFileId: string): Promise<string> {
    const response = await this.fetchJson<TogetherBatchCreateResponse>('/batches', {
      method: 'POST',
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: '/v1/chat/completions',
        model_id: this.model,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const batchId = response.job?.id ?? response.id
    if (!batchId) {
      throw new Error('Together batch creation did not return a batch id')
    }

    return batchId
  }

  private async waitForCompletion(batchId: string, timeoutMs: number): Promise<string> {
    const startedAt = this.now()

    while (this.now() - startedAt < timeoutMs) {
      const batch = await this.fetchJson<TogetherBatchStatusResponse>(`/batches/${batchId}`, {
        method: 'GET',
      })

      if (batch.status === 'COMPLETED' && batch.output_file_id) {
        return batch.output_file_id
      }

      if (batch.status === 'FAILED' || batch.status === 'CANCELLED') {
        throw new Error(batch.error ?? `Together batch ${batch.status?.toLowerCase() ?? 'failed'}`)
      }

      await sleep(this.pollIntervalMs)
    }

    throw new Error(`Together batch timed out after ${timeoutMs}ms`)
  }

  private async fetchOutputFile(fileId: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/files/${fileId}/content`, {
      method: 'GET',
      headers: this.buildHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Together file download failed: ${response.status} ${response.statusText}`)
    }

    return response.text()
  }

  private async fetchJson<T>(pathname: string, init: RequestInit): Promise<T> {
    const headers = new Headers(this.buildHeaders())

    if (init.headers) {
      const extraHeaders = new Headers(init.headers)
      extraHeaders.forEach((value, key) => headers.set(key, value))
    }

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      throw new Error(`Together API failed: ${response.status} ${bodyText || response.statusText}`)
    }

    return response.json() as Promise<T>
  }

  private buildHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
