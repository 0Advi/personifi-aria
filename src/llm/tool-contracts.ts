export type ToolParameterType = 'string' | 'number' | 'boolean'

export interface ToolSchemaProperty {
  type: ToolParameterType
  description: string
  enum?: readonly string[]
}

export interface ToolSchemaObject {
  type: 'object'
  properties: Record<string, ToolSchemaProperty>
  required?: string[]
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolSchemaObject
  }
}

export interface ToolCallFunction {
  name: string
  arguments: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: ToolCallFunction
}

export type ToolChoice = 'auto' | 'none'
export type ToolArgs = Record<string, unknown>
