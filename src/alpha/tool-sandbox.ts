import { z, type ZodTypeAny } from 'zod'
import type { ToolExecutionResult } from '../hooks.js'
import type { ToolArgs } from '../llm/tool-contracts.js'
import type { AlphaToolDefinition } from '../tool-definitions.js'
import { logger } from '../utils/logger.js'

export type ToolSchema = AlphaToolDefinition

export interface ValidationResult {
    valid: boolean
    toolName: string
    args: ToolArgs
    error?: string
    repairAttempted?: boolean
}

export interface SandboxExecutionResult {
    success: boolean
    toolName: string
    args: ToolArgs
    data: unknown
    error?: string
    executionMs: number
    repairAttempted?: boolean
    timedOut?: boolean
}

interface ParsedArgsResult {
    args: ToolArgs | null
    error?: string
    repairAttempted: boolean
}

interface SchemaValidationOutcome {
    valid: boolean
    args: ToolArgs
    error?: string
    repairAttempted: boolean
}

const TOOL_TIMEOUT_MESSAGE = 'Tool execution timed out'
const RATE_LIMIT_WINDOW_MS = 60_000
const GLOBAL_TOOL_LIMIT = 100

const rateLimits = new Map<string, { count: number; resetAt: number }>()
const globalRateWindow: number[] = []

const buildRepairCandidates = (trimmed: string): string[] => {
    const candidates = [trimmed]
    if (!trimmed.endsWith('}')) {
        candidates.push(`${trimmed}}`, `${trimmed}"}`)
    }

    const normalizedQuotes = trimmed.replace(/'/g, '"')
    if (normalizedQuotes !== trimmed) {
        candidates.push(normalizedQuotes)
    }

    return candidates
}

const buildExecutionFailure = (
    toolName: string,
    args: ToolArgs,
    executionMs: number,
    error?: string,
    repairAttempted?: boolean,
    data: unknown = null,
    timedOut?: boolean,
): SandboxExecutionResult => ({
    success: false,
    toolName,
    args,
    data,
    error,
    executionMs,
    repairAttempted,
    timedOut,
})

const buildZodField = (
    property: ToolSchema['function']['parameters']['properties'][string],
): ZodTypeAny => {
    if (Array.isArray(property.enum) && property.enum.length > 0) {
        return z.enum(property.enum as [string, ...string[]])
    }
    if (property.type === 'number') {
        return z.number()
    }
    if (property.type === 'boolean') {
        return z.boolean()
    }
    return z.string().min(1)
}

const buildZodSchema = (schema: ToolSchema): ZodTypeAny => {
    const required = new Set(schema.function.parameters.required ?? [])
    const shape: Record<string, ZodTypeAny> = {}

    for (const [name, property] of Object.entries(schema.function.parameters.properties)) {
        const field = buildZodField(property)
        shape[name] = required.has(name) ? field : field.optional()
    }

    return z.object(shape)
}

const coerceToolValue = (
    value: unknown,
    type: ToolSchema['function']['parameters']['properties'][string]['type'],
): unknown => {
    if (type === 'number' && typeof value === 'string') {
        const parsedNumber = Number(value)
        return Number.isNaN(parsedNumber) ? value : parsedNumber
    }

    if (type === 'boolean' && typeof value === 'string') {
        const lowered = value.toLowerCase()
        if (lowered === 'true') return true
        if (lowered === 'false') return false
    }

    return value
}

const coerceArgs = (parsed: ToolArgs, schema: ToolSchema): ToolArgs =>
    Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => {
            const property = schema.function.parameters.properties[key]
            return [key, property ? coerceToolValue(value, property.type) : value]
        }),
    )

const findMissingRequiredField = (result: ReturnType<ZodTypeAny['safeParse']>): string | undefined => {
    if (result.success) return undefined

    const issue = result.error.issues.find(candidate =>
        candidate.code === 'invalid_type' && (candidate as { input?: unknown }).input === undefined,
    )

    return typeof issue?.path?.[0] === 'string' ? issue.path[0] : undefined
}

const getErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

const injectUserContextField = (
    toolName: string,
    args: ToolArgs,
    userContext: ToolArgs | undefined,
    missingField: string | undefined,
): ToolArgs | null => {
    if (!missingField || !userContext || !(missingField in userContext)) {
        return null
    }

    logger.debug('[Alpha/Sandbox] Injected default from user context', {
        toolName,
        missingField,
    })

    return {
        ...args,
        [missingField]: userContext[missingField],
    }
}

const isToolArgs = (value: unknown): value is ToolArgs =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const tryParseToolArgs = (candidate: string): ToolArgs | null => {
    try {
        const parsed: unknown = JSON.parse(candidate)
        return isToolArgs(parsed) ? parsed : null
    } catch {
        return null
    }
}

const repairJson = (jsonStr: string): ToolArgs | null => {
    const trimmed = jsonStr.trim()
    if (!trimmed) return {}

    for (const candidate of buildRepairCandidates(trimmed)) {
        const parsed = tryParseToolArgs(candidate)
        if (parsed) return parsed
    }

    return null
}

const parseToolArgs = (argsStr: string): ParsedArgsResult => {
    const direct = tryParseToolArgs(argsStr || '{}')
    if (direct) {
        return { args: direct, repairAttempted: false }
    }

    const repaired = repairJson(argsStr)
    if (!repaired) {
        return {
            args: null,
            error: 'Malformed JSON arguments',
            repairAttempted: false,
        }
    }

    logger.debug('[Alpha/Sandbox] Repaired malformed JSON arguments')
    return {
        args: repaired,
        repairAttempted: true,
    }
}

const validateSchemaArgs = (
    toolName: string,
    args: ToolArgs,
    zodSchema: ZodTypeAny,
    userContext: ToolArgs | undefined,
    repairAttempted: boolean,
): SchemaValidationOutcome => {
    let currentArgs = args
    let currentRepairAttempted = repairAttempted
    let parsedResult = zodSchema.safeParse(currentArgs)

    const missingField = findMissingRequiredField(parsedResult)
    if (missingField) {
        logger.debug('[Alpha/Sandbox] Schema missing required field', {
            toolName,
            missingField,
        })

        const repairedArgs = injectUserContextField(toolName, currentArgs, userContext, missingField)
        if (repairedArgs) {
            currentArgs = repairedArgs
            currentRepairAttempted = true
            parsedResult = zodSchema.safeParse(currentArgs)
        }
    }

    if (!parsedResult.success) {
        return {
            valid: false,
            args: currentArgs,
            error: parsedResult.error.issues[0]?.message ?? 'Schema validation failed',
            repairAttempted: currentRepairAttempted,
        }
    }

    return {
        valid: true,
        args: parsedResult.data as ToolArgs,
        repairAttempted: currentRepairAttempted,
    }
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(TOOL_TIMEOUT_MESSAGE)), timeoutMs)
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })

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
            record = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS }
            rateLimits.set(key, record)
        } else if (record.count >= maxCalls) {
            return false
        } else {
            record.count++
        }

        while (globalRateWindow.length > 0 && now - globalRateWindow[0] >= RATE_LIMIT_WINDOW_MS) {
            globalRateWindow.shift()
        }
        if (globalRateWindow.length >= GLOBAL_TOOL_LIMIT) {
            return false
        }
        globalRateWindow.push(now)
        return true
    }

    public validateToolCall(
        userId: string,
        toolName: string,
        argsStr: string,
        userContext?: ToolArgs,
    ): ValidationResult {
        if (!this.checkRateLimit(userId, toolName)) {
            logger.warn('[Alpha/Sandbox] Tool rejected: rate limit exceeded', { toolName, userId })
            return { valid: false, toolName, args: {}, error: 'Rate limit exceeded for tool' }
        }

        const schema = this.definitions.find(def => def.function.name === toolName)
        if (!schema) {
            logger.warn('[Alpha/Sandbox] Tool rejected: not in schema', { toolName, userId })
            return { valid: false, toolName, args: {}, error: 'Tool not found in definitions' }
        }

        const parsedArgs = parseToolArgs(argsStr)
        if (!parsedArgs.args) {
            return {
                valid: false,
                toolName,
                args: {},
                error: parsedArgs.error ?? 'Malformed JSON arguments',
            }
        }

        const coercedArgs = coerceArgs(parsedArgs.args, schema)
        logger.debug('[Alpha/Sandbox] Validating tool call', {
            toolName,
            argKeys: Object.keys(coercedArgs),
            repairAttempted: parsedArgs.repairAttempted,
        })

        const zodSchema = this.schemaMap.get(toolName)
        if (!zodSchema) {
            return { valid: false, toolName, args: {}, error: 'Schema registry missing tool' }
        }

        const schemaValidation = validateSchemaArgs(
            toolName,
            coercedArgs,
            zodSchema,
            userContext,
            parsedArgs.repairAttempted,
        )

        if (!schemaValidation.valid) {
            return {
                valid: false,
                toolName,
                args: schemaValidation.args,
                error: schemaValidation.error,
                repairAttempted: schemaValidation.repairAttempted,
            }
        }

        logger.debug('[Alpha/Sandbox] Schema validation passed', { toolName })
        return {
            valid: true,
            toolName,
            args: schemaValidation.args,
            repairAttempted: schemaValidation.repairAttempted,
        }
    }

    async executeToolCall(
        userId: string,
        toolName: string,
        argsStr: string,
        executor: (args: ToolArgs) => Promise<ToolExecutionResult>,
        opts?: { userContext?: ToolArgs; timeoutMs?: number },
    ): Promise<SandboxExecutionResult> {
        const validation = this.validateToolCall(userId, toolName, argsStr, opts?.userContext)
        if (!validation.valid) {
            return buildExecutionFailure(toolName, validation.args, 0, validation.error, validation.repairAttempted)
        }

        const start = Date.now()
        try {
            const result = await withTimeout(executor(validation.args), opts?.timeoutMs ?? 10_000)
            const executionMs = Date.now() - start

            if (!result.success) {
                return buildExecutionFailure(
                    toolName,
                    validation.args,
                    executionMs,
                    result.error ?? `Tool execution failed: ${toolName}`,
                    validation.repairAttempted,
                    result.data,
                )
            }

            return {
                success: true,
                toolName,
                args: validation.args,
                data: result.data,
                executionMs,
                repairAttempted: validation.repairAttempted,
            }
        } catch (error) {
            const executionMs = Date.now() - start
            const timedOut = error instanceof Error && error.message === TOOL_TIMEOUT_MESSAGE
            return buildExecutionFailure(
                toolName,
                validation.args,
                executionMs,
                timedOut ? TOOL_TIMEOUT_MESSAGE : getErrorMessage(error),
                validation.repairAttempted,
                null,
                timedOut,
            )
        }
    }
}
