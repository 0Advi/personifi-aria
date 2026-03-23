import fs from 'node:fs'
import path from 'node:path'

let cachedPrompt: string | null = null
let cachedMtime = 0

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text.trim()

  const end = text.indexOf('---', 3)
  if (end === -1) return text.trim()
  return text.slice(end + 3).trim()
}

export function getSentinelSoulPrompt(): string {
  const promptPath = path.join(process.cwd(), 'config', 'sentinel-soul.md')
  const stats = fs.statSync(promptPath)

  if (cachedPrompt && cachedMtime === stats.mtimeMs) {
    return cachedPrompt
  }

  cachedPrompt = stripFrontmatter(fs.readFileSync(promptPath, 'utf8'))
  cachedMtime = stats.mtimeMs
  return cachedPrompt
}

export function buildSentinelScoringPrompt(prompt: string): string {
  return [
    'Evaluate this proactive stimulus and return JSON only.',
    'Required schema: {"action":"FIRE|BUFFER|DROP","score":0..1,"reason":"short explanation"}',
    '',
    prompt.trim(),
  ].join('\n')
}

export function _resetSentinelPromptCache(): void {
  cachedPrompt = null
  cachedMtime = 0
}
