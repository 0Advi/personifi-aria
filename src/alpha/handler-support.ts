import { enqueueMemoryWrite } from '../archivist/index.js'
import { insertSignalPacket } from '../db/fusion-tables.js'
import { pulseService } from '../pulse/index.js'
import { inferCategory } from '../topic-intent/tool-map.js'
import { topicIntentService } from '../topic-intent/index.js'
import { appendMessages, getPool, trackUsage, trimSessionHistory } from '../character/session-store.js'
import { countTokens, type AlphaContextBundle } from './context-manager.js'
import type { TopicIntent } from '../topic-intent/types.js'
import type { EngagementState } from '../pulse/types.js'
import type { ClassifierResult } from '../types/cognitive.js'

export interface AlphaSignals {
  currentDirection: string | null
  topicLabel: string | null
  sentiment: 'positive' | 'negative' | 'neutral'
  entities: string[]
}

export interface BackgroundOperation {
  label: string
  run: () => Promise<unknown>
}

export function buildAlphaUserContext(
  displayName: string | undefined,
  homeLocation: string | undefined,
  preferences: Record<string, unknown>,
  memories: unknown[],
  graphContext: unknown[],
): string {
  const sections = [
    `## User Profile\nName: ${displayName || 'Unknown'}\nHome: ${homeLocation || 'Unknown'}`,
  ]

  const preferenceSummary = summarizePreferences(preferences)
  if (preferenceSummary) sections.push(`## Preferences\n${preferenceSummary}`)

  const memorySummary = summarizeCollection(memories, 4)
  if (memorySummary) sections.push(`## Memory Highlights\n${memorySummary}`)

  const graphSummary = summarizeCollection(graphContext, 3)
  if (graphSummary) sections.push(`## Graph Context\n${graphSummary}`)

  return sections.join('\n\n')
}

export function buildPulseTopicContext(
  pulseState: EngagementState,
  activeTopics: TopicIntent[],
): string {
  const lines = [`Pulse: ${pulseState}`]
  if (activeTopics.length > 0) {
    lines.push(`Topics: ${activeTopics.map(topic => `${topic.topic} (${topic.phase}, ${topic.confidence}%)`).join(' | ')}`)
  } else {
    lines.push('Topics: none')
  }
  return lines.join('\n')
}

export function buildReactiveSignals(
  userMessage: string,
  activeTopics: TopicIntent[],
): AlphaSignals {
  return {
    currentDirection: inferCurrentDirection(userMessage, activeTopics),
    topicLabel: inferTopicLabel(userMessage, activeTopics),
    sentiment: inferSentiment(userMessage),
    entities: inferEntities(userMessage, activeTopics),
  }
}

export function estimatePromptTokens(
  contextBundle: AlphaContextBundle,
  userMessage: string,
): number {
  return countTokens(contextBundle.soul)
    + countTokens(contextBundle.userContext)
    + countTokens(contextBundle.proactiveState)
    + countTokens(contextBundle.pulseTopics)
    + contextBundle.history.reduce((sum, message) => sum + countTokens(message.content), 0)
    + countTokens(contextBundle.toolResults)
    + countTokens(userMessage)
}

export function buildTopicIntentClassifierResult(
  userMessage: string,
  signals: AlphaSignals,
  toolName: string | null,
) : ClassifierResult {
  const wordCount = userMessage.trim().split(/\s+/).filter(Boolean).length
  const messageComplexity = wordCount <= 4 ? 'simple' : 'moderate'

  return {
    message_complexity: messageComplexity,
    needs_tool: !!toolName,
    tool_hint: toolName,
    tool_args: {},
    skip_memory: messageComplexity === 'simple',
    skip_graph: false,
    skip_cognitive: true,
    userSignal: 'normal',
    detected_topic: signals.topicLabel,
    interest_signal: toolName
      ? 'committed'
      : (signals.sentiment === 'negative'
        ? 'negative'
        : (signals.topicLabel ? 'positive' : 'neutral')),
  }
}

export function buildBackgroundOperations(input: {
  channel: string
  userId: string
  sessionId: string
  userMessage: string
  responseText: string
  sessionHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp?: string }>
  previousUserMessage: string | null
  previousMessageAt: string | null
  promptTokens: number
  completionTokens: number
  currentDirection: string | null
  extractedIntents: string[]
  engagementSignal: 'positive' | 'negative' | 'neutral'
  fusionInvalidated: string[]
  classifierResult: ClassifierResult
  executingTopic: TopicIntent | null
  hasToolExecution: boolean
  writeSignalPacketFallback: boolean
}): BackgroundOperation[] {
  const operations: BackgroundOperation[] = [
    {
      label: 'pulse engagement',
      run: () => pulseService.recordEngagement({
        userId: input.userId,
        message: input.userMessage,
        previousUserMessage: input.previousUserMessage,
        previousMessageAt: input.previousMessageAt,
      }),
    },
    {
      label: 'vector memory write',
      run: () => enqueueMemoryWrite(input.userId, 'ADD_MEMORY', {
        userId: input.userId,
        message: input.userMessage,
        history: input.sessionHistory,
      }),
    },
    {
      label: 'graph memory write',
      run: () => enqueueMemoryWrite(input.userId, 'GRAPH_WRITE', {
        userId: input.userId,
        message: input.userMessage,
      }),
    },
    {
      label: 'session append',
      run: () => appendMessages(input.sessionId, input.userMessage, input.responseText),
    },
    {
      label: 'session trim',
      run: () => trimSessionHistory(input.userId),
    },
    {
      label: 'usage tracking',
      run: () => trackUsage(
        input.userId,
        input.channel,
        input.promptTokens,
        input.completionTokens,
        0,
      ),
    },
    {
      label: 'topic intent update',
      run: () => topicIntentService.processMessage(
        input.userId,
        input.sessionId,
        input.userMessage,
        input.classifierResult,
      ),
    },
  ]

  if (input.writeSignalPacketFallback) {
    operations.push({
      label: 'signal packet write',
      run: () => insertSignalPacket(getPool(), {
        user_id: input.userId,
        invalidated_stimuli: input.fusionInvalidated.length > 0 ? input.fusionInvalidated : null,
        current_direction: input.currentDirection,
        extracted_intents: input.extractedIntents.length > 0 ? input.extractedIntents : null,
        engagement_signal: input.engagementSignal,
      }),
    })
  }

  if (input.hasToolExecution && input.executingTopic) {
    const executingTopic = input.executingTopic
    operations.push({
      label: 'topic completion',
      run: () => topicIntentService.completeTopic(input.userId, executingTopic.id),
    })
  }

  return operations
}

function summarizePreferences(preferences: Record<string, unknown>): string {
  const entries = Object.entries(preferences)
    .filter(([, value]) => value !== null && value !== undefined && `${value}`.trim() !== '')
    .slice(0, 8)

  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
}

function summarizeCollection(items: unknown[], limit: number): string {
  return items
    .slice(0, limit)
    .map(item => formatContextItem(item))
    .filter(Boolean)
    .map(item => `- ${item}`)
    .join('\n')
}

function formatContextItem(item: unknown): string {
  if (typeof item === 'string') return item.trim().slice(0, 180)
  if (!item || typeof item !== 'object') return `${item}`.slice(0, 180)

  const record = item as Record<string, unknown>
  const preferredFields = ['content', 'text', 'memory', 'summary', 'fact', 'message', 'title', 'name']
  for (const field of preferredFields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 180)
    }
  }

  try {
    return JSON.stringify(record).slice(0, 180)
  } catch {
    return '[unserializable context item]'
  }
}

function inferCurrentDirection(
  userMessage: string,
  activeTopics: TopicIntent[],
): string | null {
  const lower = userMessage.toLowerCase()

  if (/\b(watch|netflix|series|movie|anime|stream|youtube|at home|home tonight|indoors?)\b/i.test(lower)) {
    return 'indoor_evening'
  }
  if (/\b(order in|delivery|swiggy|zomato|takeout|comfort food)\b/i.test(lower)) {
    return 'food_delivery'
  }
  if (/\b(pub|bar|brewery|cocktail|drinks?|party|clubbing|night out)\b/i.test(lower)) {
    return 'night_out'
  }
  if (/\b(restaurant|cafe|brunch|dinner|lunch|rooftop|biryani|pizza|coffee|tea|chai|dessert)\b/i.test(lower)) {
    return 'food_outing'
  }
  if (/\b(concert|comedy|show|event|museum|park|trek|hike|ride|cycling|outdoors?|go out)\b/i.test(lower)) {
    return 'outdoor_activity'
  }
  if (/\b(cab|uber|ola|rapido|traffic|route|drive|airport ride)\b/i.test(lower)) {
    return 'commute'
  }
  if (/\b(grocery|milk|blinkit|zepto|instamart|snacks?|beverages?|shopping)\b/i.test(lower)) {
    return 'shopping'
  }
  if (/\b(travel|trip|flight|hotel|stay|airport|vacation|holiday)\b/i.test(lower)) {
    return 'travel'
  }

  const activeTopic = activeTopics[0]?.topic
  if (activeTopic) {
    switch (inferCategory(activeTopic)) {
      case 'food':
        return 'food_outing'
      case 'travel':
        return 'travel'
      case 'nightlife':
        return 'night_out'
      case 'activity':
        return 'outdoor_activity'
      default:
        return activeTopic
    }
  }

  return null
}

function inferTopicLabel(
  userMessage: string,
  activeTopics: TopicIntent[],
): string | null {
  const normalized = userMessage
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s,'-]/g, '')
    .trim()

  if (!normalized) return activeTopics[0]?.topic ?? null
  if (normalized.split(/\s+/).length <= 2 && activeTopics[0]?.topic) return activeTopics[0].topic
  return normalized.slice(0, 96)
}

function inferSentiment(userMessage: string): 'positive' | 'negative' | 'neutral' {
  const lower = userMessage.toLowerCase()
  if (/\b(no thanks|not interested|nah|stop|leave me alone|don't want|do not want|skip)\b/i.test(lower)) {
    return 'negative'
  }
  if (/\b(yes|sure|let's|lets|sounds good|love that|awesome|perfect|great)\b/i.test(lower)) {
    return 'positive'
  }
  return 'neutral'
}

function inferEntities(
  userMessage: string,
  activeTopics: TopicIntent[],
): string[] {
  const matches = userMessage.toLowerCase().match(/\b(netflix|movie|series|biryani|pizza|coffee|pub|bar|brewery|concert|flight|hotel|uber|ola|blinkit|zepto|swiggy|zomato)\b/g) ?? []
  const entities = new Set(matches)

  if (activeTopics[0]?.topic) {
    entities.add(activeTopics[0].topic.slice(0, 60))
  }

  return [...entities].slice(0, 5)
}
