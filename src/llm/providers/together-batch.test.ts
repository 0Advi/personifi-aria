import { describe, expect, it } from 'vitest'
import { TogetherBatchAdapter } from './together-batch.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('TogetherBatchAdapter', () => {
  it('uploads, polls, and maps batch results by custom_id', async () => {
    const calls: string[] = []
    let batchPollCount = 0

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(`${init?.method ?? 'GET'} ${url}`)

      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse({ id: 'file-input-1' })
      }

      if (url.endsWith('/batches') && init?.method === 'POST') {
        return jsonResponse({ id: 'batch-1' })
      }

      if (url.endsWith('/batches/batch-1') && init?.method === 'GET') {
        batchPollCount += 1
        if (batchPollCount === 1) {
          return jsonResponse({ id: 'batch-1', status: 'IN_PROGRESS' })
        }

        return jsonResponse({
          id: 'batch-1',
          status: 'COMPLETED',
          output_file_id: 'file-output-1',
        })
      }

      if (url.endsWith('/files/file-output-1/content') && init?.method === 'GET') {
        return new Response(
          [
            JSON.stringify({
              custom_id: 'sentinel-1',
              response: {
                body: {
                  choices: [{ message: { content: '{"action":"BUFFER","score":0.64,"reason":"hold for better timing"}' } }],
                },
              },
            }),
            JSON.stringify({
              custom_id: 'sentinel-0',
              response: {
                body: {
                  choices: [{ message: { content: '{"action":"FIRE","score":0.81,"reason":"high relevance"}' } }],
                },
              },
            }),
          ].join('\n'),
          { status: 200 },
        )
      }

      throw new Error(`Unexpected fetch call: ${init?.method ?? 'GET'} ${url}`)
    }

    const adapter = new TogetherBatchAdapter({
      apiKey: 'test-key',
      fetchImpl,
      pollIntervalMs: 1,
      now: (() => {
        let now = 0
        return () => {
          now += 10
          return now
        }
      })(),
    })

    const results = await adapter.batchScore(['first', 'second'], {
      userIds: ['user-a', 'user-b'],
      batchTimeoutMs: 2_000,
    })

    expect(results).toHaveLength(2)
    expect(results[0]?.action).toBe('FIRE')
    expect(results[1]?.action).toBe('BUFFER')
    expect(calls).toContain('POST https://api.together.ai/v1/files')
    expect(calls).toContain('POST https://api.together.ai/v1/batches')
    expect(calls).toContain('GET https://api.together.ai/v1/files/file-output-1/content')
  })
})
