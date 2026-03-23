type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogMeta = Record<string, unknown>

function shouldLogDebug(): boolean {
  return process.env.NODE_ENV !== 'production'
    || process.env.DEBUG_LOGS === 'true'
    || process.env.LOG_LEVEL?.toLowerCase() === 'debug'
}

function serializeMeta(meta: LogMeta): string {
  const seen = new WeakSet<object>()

  return JSON.stringify(meta, (_key, value) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      }
    }

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[circular]'
      }
      seen.add(value)
    }

    return value
  })
}

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (level === 'debug' && !shouldLogDebug()) return

  const metaSuffix = meta && Object.keys(meta).length > 0
    ? ` ${serializeMeta(meta)}`
    : ''
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${metaSuffix}\n`

  if (level === 'warn' || level === 'error') {
    process.stderr.write(line)
    return
  }

  process.stdout.write(line)
}

export const logger = {
  debug(message: string, meta?: LogMeta): void {
    write('debug', message, meta)
  },
  info(message: string, meta?: LogMeta): void {
    write('info', message, meta)
  },
  warn(message: string, meta?: LogMeta): void {
    write('warn', message, meta)
  },
  error(message: string, meta?: LogMeta): void {
    write('error', message, meta)
  },
}
