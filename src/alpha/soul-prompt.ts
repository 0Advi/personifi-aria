import fs from 'node:fs'
import path from 'node:path'

const SOUL_CANDIDATE_PATHS = [
  path.join(process.cwd(), 'config', 'soul-v2.md'),
  path.join(process.cwd(), 'config', 'SOUL.md'),
  path.join(process.cwd(), 'SOUL.md'),
]

let cachedPath: string | null = null
let cachedMtimeMs = 0
let cachedPrompt: string | null = null

function resolveSoulPath(): string {
  const existingPath = SOUL_CANDIDATE_PATHS.find(candidate => fs.existsSync(candidate))
  if (!existingPath) {
    throw new Error('No Alpha soul prompt found in config/soul-v2.md, config/SOUL.md, or SOUL.md')
  }
  return existingPath
}

export function getAlphaSoulPrompt(): string {
  const resolvedPath = resolveSoulPath()
  const stat = fs.statSync(resolvedPath)

  if (cachedPrompt && cachedPath === resolvedPath && cachedMtimeMs === stat.mtimeMs) {
    return cachedPrompt
  }

  cachedPath = resolvedPath
  cachedMtimeMs = stat.mtimeMs
  cachedPrompt = stripFrontmatter(fs.readFileSync(resolvedPath, 'utf8').trim())
  return cachedPrompt
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content

  const endIdx = content.indexOf('---', 3)
  if (endIdx === -1) return content
  return content.slice(endIdx + 3).trim()
}
