import {
  getOrCreateUser,
  getOrCreateSession,
  checkRateLimit,
  getPool,
} from './session-store.js'
import { sanitizeInput, isPotentialAttack } from './sanitize.js'
import { scoredMemorySearch } from '../archivist/index.js'
import { searchGraph } from '../graph-memory.js'
import { loadPreferences } from '../memory.js'
import { pulseService } from '../pulse/index.js'
import { topicIntentService } from '../topic-intent/index.js'
import { buildContext, countTokens } from '../alpha/context-manager.js'
import { callAlpha } from '../alpha/alpha-caller.js'
import {
  buildAlphaUserContext,
  buildBackgroundOperations,
  buildPulseTopicContext,
  buildReactiveSignals,
  buildTopicIntentClassifierResult,
  estimatePromptTokens,
} from '../alpha/handler-support.js'
import { getAlphaSoulPrompt } from '../alpha/soul-prompt.js'
import { filterOutput } from './output-filter.js'
import { getLinkedUserIds } from '../identity.js'
import { handleOnboarding } from '../onboarding/onboarding-flow.js'
import { fusionReactiveDecision } from '../fusion/reactive.js'
import { safeError } from '../utils/safe-log.js'
import { extractResponseArtifacts } from './response-artifacts.js'
import type { MessageResponse, HandleMessageOptions } from './handler-legacy.js'
import { logger } from '../utils/logger.js'

export async function handleMessageAlpha(
  channel: string,
  channelUserId: string,
  rawMessage: string,
  options: HandleMessageOptions = {},
): Promise<MessageResponse> {
  try {
    const pool = getPool()

    const sanitizeResult = sanitizeInput(rawMessage)
    const userMessage = sanitizeResult.sanitized

    if (isPotentialAttack(sanitizeResult)) {
      return { text: "Ha, nice try! 😄 I'm just Aria, your travel buddy. So... anywhere you're thinking of exploring?" }
    }

    const user = await getOrCreateUser(channel, channelUserId)
    const withinLimit = await checkRateLimit(user.userId)
    if (!withinLimit) {
      return { text: "Whoa, we're chatting so fast! Give me a sec to catch my breath 😅 What were you asking about?" }
    }

    let onboardingResult = options.onboardingResult ?? null
    if (!options.bypassOnboarding && !user.authenticated) {
      onboardingResult = await handleOnboarding(user.userId, userMessage).catch(err => {
        logger.error('[HandlerAlpha] Onboarding flow failed', {
          userId: user.userId,
          error: safeError(err),
        })
        return null
      })
    }
    const onboardingActive = !!onboardingResult?.handled

    const searchUserIds = user.personId
      ? await getLinkedUserIds(user.userId).catch(() => [user.userId])
      : [user.userId]

    const session = await getOrCreateSession(user.userId)

    const [
      memories,
      graphContext,
      preferences,
      pulseState,
      activeTopics,
    ] = await Promise.all([
      scoredMemorySearch(searchUserIds, userMessage, 5).catch(() => []),
      searchGraph(searchUserIds, userMessage, 2, 10).catch(() => []),
      loadPreferences(pool, user.userId).catch(() => ({})),
      pulseService.getState(user.userId).catch(() => 'PASSIVE' as const),
      topicIntentService.getActiveTopics(user.userId, 3).catch(() => []),
    ])

    const reactiveSignals = buildReactiveSignals(userMessage, activeTopics)

    let proactiveStateStr = ''
    let fusionInvalidated: string[] = []
    let prefetchedToolResult: { toolName: string; result: unknown } | null = null
    let signalPacketWrittenByFusion = false

    try {
      const fusionResult = await fusionReactiveDecision(pool, {
        userId: user.userId,
        userMessage,
        extractedSignals: {
          topic: reactiveSignals.currentDirection,
          intent: reactiveSignals.topicLabel,
          sentiment: reactiveSignals.sentiment,
          entities: reactiveSignals.entities,
        },
        toolRequest: null,
        contextBundle: {
          memories: memories as unknown[],
          preferences: preferences as Record<string, string>,
          graphNeighbors: graphContext as unknown[],
        },
        pulseState,
        pulseScore: 0,
      })
      signalPacketWrittenByFusion = true

      fusionInvalidated = fusionResult.invalidatedStimuli ?? []
      if (fusionResult.contextAdditions?.length) {
        proactiveStateStr = fusionResult.contextAdditions.join('\n')
      }
      if (fusionResult.toolResult) {
        prefetchedToolResult = {
          toolName: fusionResult.toolResult.tool_name,
          result: fusionResult.toolResult.result,
        }
      }
      if (fusionInvalidated.length > 0) {
        logger.debug('[HandlerAlpha] Invalidated proactive stimuli', {
          userId: user.userId,
          invalidated: fusionInvalidated,
        })
      }
    } catch (err) {
      logger.error('[HandlerAlpha] Fusion reactive decision failed', {
        userId: user.userId,
        error: safeError(err),
      })
    }

    const soul = getAlphaSoulPrompt()
    const userContextStr = buildAlphaUserContext(
      user.displayName,
      user.homeLocation,
      preferences as Record<string, unknown>,
      memories as unknown[],
      graphContext as unknown[],
    )
    const pulseTopicStr = buildPulseTopicContext(pulseState, activeTopics)
    const history = session.messages
      .slice(-8)
      .map(message => ({ role: message.role as 'user' | 'assistant' | 'system', content: message.content }))

    const contextBundle = buildContext(
      soul,
      {
        userContext: userContextStr,
        pulseTopics: pulseTopicStr,
        history,
      },
      proactiveStateStr,
    )

    const startAlpha = Date.now()
    const alphaResult = await callAlpha(
      user.userId,
      contextBundle,
      userMessage,
      {
        userContext: {
          location: user.homeLocation,
          origin: user.homeLocation,
          query: reactiveSignals.topicLabel,
        },
        prefetchedToolResult,
      },
    )
    const alphaMs = Date.now() - startAlpha
    const llmCalls = alphaResult.toolCalls.length > 0 ? 2 : 1

    const responseText = filterOutput(alphaResult.content).filtered
    const primaryToolResult = alphaResult.toolResults[0] ?? null
    const responseArtifacts = extractResponseArtifacts(
      primaryToolResult?.name,
      primaryToolResult?.result,
      user.homeLocation,
    )

    logger.debug('[HandlerAlpha] Pipeline completed', {
      userId: user.userId,
      latencyMs: alphaMs,
      llmCalls,
      tools: alphaResult.toolCalls.map(t => t.name),
      prefetched: Boolean(prefetchedToolResult),
    })

    const previousUserMessage = [...session.messages]
      .reverse()
      .find(message => message.role === 'user')?.content ?? null
    const previousMessageAt = [...session.messages]
      .reverse()
      .find(message => !!message.timestamp)?.timestamp ?? null
    const promptTokens = estimatePromptTokens(contextBundle, userMessage)
    const completionTokens = countTokens(responseText)
    const executingTopic = activeTopics.find(topic => topic.phase === 'executing') ?? null
    const toolName = alphaResult.toolCalls[0]?.name ?? null
    const backgroundOps = buildBackgroundOperations({
      channel,
      userId: user.userId,
      sessionId: session.sessionId,
      userMessage,
      responseText,
      sessionHistory: session.messages.slice(-6),
      previousUserMessage,
      previousMessageAt,
      promptTokens,
      completionTokens,
      currentDirection: reactiveSignals.currentDirection ?? reactiveSignals.topicLabel,
      extractedIntents: reactiveSignals.entities.length > 0
        ? reactiveSignals.entities
        : (reactiveSignals.topicLabel ? [reactiveSignals.topicLabel] : []),
      engagementSignal: reactiveSignals.sentiment,
      fusionInvalidated,
      classifierResult: buildTopicIntentClassifierResult(userMessage, reactiveSignals, toolName),
      executingTopic,
      hasToolExecution: alphaResult.toolCalls.length > 0,
      writeSignalPacketFallback: !signalPacketWrittenByFusion,
    })

    setImmediate(() => {
      void Promise.allSettled(backgroundOps.map(op => op.run())).then(results => {
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            logger.error('[HandlerAlpha] Background operation failed', {
              userId: user.userId,
              label: backgroundOps[index].label,
              error: safeError(result.reason),
            })
          }
        })
      })
    })

    return {
      text: responseText,
      media: responseArtifacts.media,
      venues: responseArtifacts.venues,
      ...(onboardingActive && onboardingResult?.requestLocation ? { requestLocation: true } : {}),
      ...(onboardingActive && onboardingResult?.buttons ? { _buttons: onboardingResult.buttons } : {}),
    }
  } catch (err) {
    logger.error('[HandlerAlpha] Message handling failed', {
      channel,
      channelUserId,
      error: safeError(err),
    })
    return { text: "Oops, something went wrong on my end! Mind trying that again? 😅" }
  }
}
