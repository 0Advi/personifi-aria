type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

function safeStringify(meta: unknown): string {
  try {
    return JSON.stringify(meta)
  } catch {
    return '"[unserializable-meta]"'
  }
}

function writeLog(level: LogLevel, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString()
  const suffix = meta === undefined ? '' : ` ${safeStringify(meta)}`
  const line = `${timestamp} ${level} ${message}${suffix}\n`

  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(line)
    return
  }

  process.stdout.write(line)
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    if (process.env.LOG_LEVEL === 'debug') {
      writeLog('DEBUG', message, meta)
    }
  },

  info(message: string, meta?: unknown): void {
    writeLog('INFO', message, meta)
  },

  warn(message: string, meta?: unknown): void {
    writeLog('WARN', message, meta)
  },

  error(message: string, meta?: unknown): void {
    writeLog('ERROR', message, meta)
  },
}
