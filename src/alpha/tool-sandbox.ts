import { z, type ZodTypeAny } from 'zod'
import type { ToolExecutionResult } from '../hooks.js'
import type { AlphaToolDefinition } from '../tool-definitions.js'

export type ToolSchema = AlphaToolDefinition

export interface ValidationResult {
    valid: boolean
    toolName: string
    args: Record<string, any>
    error?: string
    repairAttempted?: boolean
}

export interface SandboxExecutionResult {
    success: boolean
    toolName: string
    args: Record<string, any>
    data: unknown
    error?: string
    executionMs: number
    repairAttempted?: boolean
    timedOut?: boolean
}

const rateLimits = new Map<string, { count: number; resetAt: number }>()
const globalRateWindow: number[] = []

export class ToolSandbox {
    private definitions: ToolSchema[]
    private schemaMap: Map<string, ZodTypeAny>

    constructor(definitions: ToolSchema[]) {
        this.definitions = definitions
        this.schemaMap = new Map(definitions.map(def => [def.function.name, buildZodSchema(def)]))
    }

    private checkRateLimit(userId: string, toolName: string, maxCalls: number = 10): boolean {
        const key = `${userId}:${toolName}`
        const now = Date.now()

        let record = rateLimits.get(key)
        if (!record || record.resetAt < now) {
            record = { count: 1, resetAt: now + 60000 }
            rateLimits.set(key, record)
        } else if (record.count >= maxCalls) {
            return false
        } else {
            record.count++
        }

        while (globalRateWindow.length > 0 && now - globalRateWindow[0] >= 60000) {
            globalRateWindow.shift()
        }
        if (globalRateWindow.length >= 100) {
            return false
        }
        globalRateWindow.push(now)
        return true
    }

    private repairJson(jsonStr: string): Record<string, any> | null {
        const trimmed = jsonStr.trim()
        if (!trimmed) return {}

        if (!trimmed.endsWith('}')) {
            try { return JSON.parse(trimmed + '}') } catch {}
            try { return JSON.parse(trimmed + '"}') } catch {}
        }

        try {
            return JSON.parse(trimmed.replace(/'/g, '"'))
        } catch {}

        return null
    }

    private coerceArgs(parsed: Record<string, any>, schema: ToolSchema): Record<string, any> {
        const props = schema.function.parameters.properties
        const coerced = { ...parsed }

        for (const [key, propSchema] of Object.entries(props)) {
            if (!(key in coerced)) continue

            if (propSchema.type === 'number' && typeof coerced[key] === 'string') {
                const num = Number(coerced[key])
                if (!Number.isNaN(num)) {
                    coerced[key] = num
                }
            }

            if (propSchema.type === 'boolean' && typeof coerced[key] === 'string') {
                if (coerced[key].toLowerCase() === 'true') coerced[key] = true
                if (coerced[key].toLowerCase() === 'false') coerced[key] = false
            }
        }

        return coerced
    }

    public validateToolCall(
        userId: string,
        toolName: string,
        argsStr: string,
        userContext?: Record<string, any>,
    ): ValidationResult {
        if (!this.checkRateLimit(userId, toolName)) {
            console.log(`[Alpha/Sandbox] REJECTED rate limit exceeded: "${toolName}"`)
            return { valid: false, toolName, args: {}, error: 'Rate limit exceeded for tool' }
        }

        const schema = this.definitions.find(def => def.function.name === toolName)
        if (!schema) {
            console.log(`[Alpha/Sandbox] REJECTED phantom tool: "${toolName}" — not in schema`)
            return { valid: false, toolName, args: {}, error: 'Tool not found in definitions' }
        }

        let parsed: Record<string, any>
        let repairAttempted = false

        try {
            parsed = JSON.parse(argsStr || '{}')
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { valid: false, toolName, args: {}, error: 'Parsed arguments did not yield an object.' }
            }
        } catch {
            const repaired = this.repairJson(argsStr)
            if (!repaired) {
                return { valid: false, toolName, args: {}, error: 'Malformed JSON arguments' }
            }
            parsed = repaired
            repairAttempted = true
            console.log('[Alpha/Sandbox] Repair attempt: fixed JSON syntax')
        }

        parsed = this.coerceArgs(parsed, schema)
        console.log(`[Alpha/Sandbox] Validating tool call: ${toolName} ${JSON.stringify(parsed)}`)

        const zodSchema = this.schemaMap.get(toolName)
        if (!zodSchema) {
            return { valid: false, toolName, args: {}, error: 'Schema registry missing tool' }
        }

        let parsedResult = zodSchema.safeParse(parsed)
        if (!parsedResult.success) {
            const missing = parsedResult.error.issues.find(issue =>
                issue.code === 'invalid_type'
                && (issue as { input?: unknown }).input === undefined,
            )
            const missingField = typeof missing?.path?.[0] === 'string' ? missing.path[0] : undefined
            if (missingField) {
                console.log(`[Alpha/Sandbox] Schema check: FAIL — missing required field "${missingField}"`)
                if (userContext && missingField in userContext) {
                    parsed[missingField] = userContext[missingField]
                    repairAttempted = true
                    console.log('[Alpha/Sandbox] Repair attempt: injected default from user context')
                    parsedResult = zodSchema.safeParse(parsed)
                }
            }
        }

        if (!parsedResult.success) {
            const firstIssue = parsedResult.error.issues[0]
            return {
                valid: false,
                toolName,
                args: parsed,
                repairAttempted,
                error: firstIssue?.message ?? 'Schema validation failed',
            }
        }

        console.log('[Alpha/Sandbox] Schema check: PASS')
        return { valid: true, toolName, args: parsedResult.data as Record<string, any>, repairAttempted }
    }

    async executeToolCall(
        userId: string,
        toolName: string,
        argsStr: string,
        executor: (args: Record<string, any>) => Promise<ToolExecutionResult>,
        opts?: { userContext?: Record<string, any>; timeoutMs?: number },
    ): Promise<SandboxExecutionResult> {
        const validation = this.validateToolCall(userId, toolName, argsStr, opts?.userContext)
        if (!validation.valid) {
            return {
                success: false,
                toolName,
                args: validation.args,
                data: null,
                error: validation.error,
                executionMs: 0,
                repairAttempted: validation.repairAttempted,
            }
        }

        const start = Date.now()
        try {
            const result = await withTimeout(executor(validation.args), opts?.timeoutMs ?? 10000)
            if (!result.success) {
                return {
                    success: false,
                    toolName,
                    args: validation.args,
                    data: result.data,
                    error: result.error ?? `Tool execution failed: ${toolName}`,
                    executionMs: Date.now() - start,
                    repairAttempted: validation.repairAttempted,
                }
            }

            return {
                success: true,
                toolName,
                args: validation.args,
                data: result.data,
                executionMs: Date.now() - start,
                repairAttempted: validation.repairAttempted,
            }
        } catch (err) {
            const timedOut = err instanceof Error && err.message === 'Tool execution timed out'
            return {
                success: false,
                toolName,
                args: validation.args,
                data: null,
                error: timedOut ? 'Tool execution timed out' : (err as Error).message,
                executionMs: Date.now() - start,
                repairAttempted: validation.repairAttempted,
                timedOut,
            }
        }
    }
}

function buildZodSchema(schema: ToolSchema): ZodTypeAny {
    const required = new Set(schema.function.parameters.required ?? [])
    const shape: Record<string, ZodTypeAny> = {}

    for (const [name, property] of Object.entries(schema.function.parameters.properties)) {
        let field: ZodTypeAny

        if (Array.isArray(property.enum) && property.enum.length > 0) {
            field = z.enum(property.enum as [string, ...string[]])
        } else if (property.type === 'number') {
            field = z.number()
        } else if (property.type === 'boolean') {
            field = z.boolean()
        } else {
            field = z.string().min(1)
        }

        shape[name] = required.has(name) ? field : field.optional()
    }

    return z.object(shape)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tool execution timed out')), timeoutMs)
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            err => {
                clearTimeout(timer)
                reject(err)
            },
        )
    })
}
