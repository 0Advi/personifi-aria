import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getOrCreateUserMock,
  getOrCreateSessionMock,
  appendMessagesMock,
  trimSessionHistoryMock,
  checkRateLimitMock,
  trackUsageMock,
  getPoolMock,
  scoredMemorySearchMock,
  enqueueMemoryWriteMock,
  searchGraphMock,
  loadPreferencesMock,
  pulseGetStateMock,
  pulseRecordEngagementMock,
  getActiveTopicsMock,
  processMessageMock,
  completeTopicMock,
  buildContextMock,
  callAlphaMock,
  filterOutputMock,
  getLinkedUserIdsMock,
  handleOnboardingMock,
  fusionReactiveDecisionMock,
  insertSignalPacketMock,
} = vi.hoisted(() => ({
  getOrCreateUserMock: vi.fn(),
  getOrCreateSessionMock: vi.fn(),
  appendMessagesMock: vi.fn(),
  trimSessionHistoryMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  trackUsageMock: vi.fn(),
  getPoolMock: vi.fn(),
  scoredMemorySearchMock: vi.fn(),
  enqueueMemoryWriteMock: vi.fn(),
  searchGraphMock: vi.fn(),
  loadPreferencesMock: vi.fn(),
  pulseGetStateMock: vi.fn(),
  pulseRecordEngagementMock: vi.fn(),
  getActiveTopicsMock: vi.fn(),
  processMessageMock: vi.fn(),
  completeTopicMock: vi.fn(),
  buildContextMock: vi.fn(),
  callAlphaMock: vi.fn(),
  filterOutputMock: vi.fn(),
  getLinkedUserIdsMock: vi.fn(),
  handleOnboardingMock: vi.fn(),
  fusionReactiveDecisionMock: vi.fn(),
  insertSignalPacketMock: vi.fn(),
}))

vi.mock('./session-store.js', () => ({
  getOrCreateUser: getOrCreateUserMock,
  getOrCreateSession: getOrCreateSessionMock,
  appendMessages: appendMessagesMock,
  trimSessionHistory: trimSessionHistoryMock,
  checkRateLimit: checkRateLimitMock,
  trackUsage: trackUsageMock,
  getPool: getPoolMock,
}))

vi.mock('./sanitize.js', () => ({
  sanitizeInput: vi.fn((msg: string) => ({ sanitized: msg, suspiciousPatterns: [] })),
  isPotentialAttack: vi.fn(() => false),
}))

vi.mock('../archivist/index.js', () => ({
  scoredMemorySearch: scoredMemorySearchMock,
  enqueueMemoryWrite: enqueueMemoryWriteMock,
}))

vi.mock('../graph-memory.js', () => ({
  searchGraph: searchGraphMock,
}))

vi.mock('../memory.js', () => ({
  loadPreferences: loadPreferencesMock,
}))

vi.mock('../pulse/index.js', () => ({
  pulseService: {
    getState: pulseGetStateMock,
    recordEngagement: pulseRecordEngagementMock,
  },
}))

vi.mock('../topic-intent/index.js', () => ({
  topicIntentService: {
    getActiveTopics: getActiveTopicsMock,
    processMessage: processMessageMock,
    completeTopic: completeTopicMock,
  },
}))

vi.mock('../alpha/context-manager.js', () => ({
  buildContext: buildContextMock,
  countTokens: vi.fn((text: string) => Math.ceil((text?.length ?? 0) / 4)),
}))

vi.mock('../alpha/alpha-caller.js', () => ({
  callAlpha: callAlphaMock,
}))

vi.mock('../alpha/soul-prompt.js', () => ({
  getAlphaSoulPrompt: vi.fn(() => 'SOUL_V2'),
}))

vi.mock('./output-filter.js', () => ({
  filterOutput: filterOutputMock,
}))

vi.mock('../identity.js', () => ({
  getLinkedUserIds: getLinkedUserIdsMock,
}))

vi.mock('../onboarding/onboarding-flow.js', () => ({
  handleOnboarding: handleOnboardingMock,
}))

vi.mock('../fusion/reactive.js', () => ({
  fusionReactiveDecision: fusionReactiveDecisionMock,
}))

vi.mock('../db/fusion-tables.js', () => ({
  insertSignalPacket: insertSignalPacketMock,
}))

import { handleMessageAlpha } from './handler-alpha.js'

describe('handleMessageAlpha', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    getPoolMock.mockReturnValue({})
    getOrCreateUserMock.mockResolvedValue({
      userId: 'user-1',
      channel: 'telegram',
      channelUserId: 'tg-1',
      displayName: 'Adi',
      homeLocation: 'Indiranagar',
      authenticated: true,
      createdAt: new Date(),
    })
    getOrCreateSessionMock.mockResolvedValue({
      sessionId: 'session-1',
      userId: 'user-1',
      messages: [],
      lastActive: new Date(),
    })
    checkRateLimitMock.mockResolvedValue(true)
    scoredMemorySearchMock.mockResolvedValue([])
    searchGraphMock.mockResolvedValue([])
    loadPreferencesMock.mockResolvedValue({})
    pulseGetStateMock.mockResolvedValue('PASSIVE')
    pulseRecordEngagementMock.mockResolvedValue({})
    getActiveTopicsMock.mockResolvedValue([])
    processMessageMock.mockResolvedValue({})
    completeTopicMock.mockResolvedValue(undefined)
    buildContextMock.mockImplementation((soul: string, gathered: any, proactiveState: string) => ({
      soul,
      userContext: gathered.userContext,
      pulseTopics: gathered.pulseTopics,
      history: gathered.history,
      proactiveState,
      toolResults: '',
    }))
    callAlphaMock.mockResolvedValue({
      content: 'alpha reply',
      toolCalls: [],
      toolResults: [],
      provider: 'mock',
    })
    filterOutputMock.mockImplementation((text: string) => ({ filtered: text }))
    getLinkedUserIdsMock.mockResolvedValue([])
    handleOnboardingMock.mockResolvedValue(null)
    fusionReactiveDecisionMock.mockResolvedValue({
      decision: 'respond',
      toolResult: null,
      contextAdditions: [],
      pulseDelta: 0,
      proactiveContext: null,
      invalidatedStimuli: [],
      confidence: 1,
    })
    appendMessagesMock.mockResolvedValue(undefined)
    trimSessionHistoryMock.mockResolvedValue(undefined)
    trackUsageMock.mockResolvedValue(undefined)
    enqueueMemoryWriteMock.mockResolvedValue(undefined)
    insertSignalPacketMock.mockResolvedValue(undefined)
  })

  it('defers background writes until after the response returns', async () => {
    const result = await handleMessageAlpha('telegram', 'tg-1', 'hello there')

    expect(result.text).toBe('alpha reply')
    expect(appendMessagesMock).not.toHaveBeenCalled()
    expect(trackUsageMock).not.toHaveBeenCalled()
    expect(enqueueMemoryWriteMock).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    expect(appendMessagesMock).toHaveBeenCalledWith('session-1', 'hello there', 'alpha reply')
    expect(trackUsageMock).toHaveBeenCalled()
    expect(enqueueMemoryWriteMock).toHaveBeenCalled()
  })

  it('preserves media and venue artifacts from Alpha tool results', async () => {
    callAlphaMock.mockResolvedValueOnce({
      content: 'Here you go',
      toolCalls: [{ name: 'place_search', args: { query: 'coffee' } }],
      toolResults: [{
        name: 'place_search',
        result: {
          images: [{ url: 'https://example.com/place.jpg', caption: 'Cafe photo' }],
          raw: [{
            displayName: { text: 'Blue Tokai' },
            formattedAddress: 'Indiranagar, Bengaluru',
            location: { latitude: 12.97, longitude: 77.64 },
          }],
        },
      }],
      provider: 'mock',
    })

    const result = await handleMessageAlpha('telegram', 'tg-1', 'find me a cafe')

    expect(result.text).toBe('Here you go')
    expect(result.media?.[0]?.url).toBe('https://example.com/place.jpg')
    expect(result.venues?.[0]?.name).toBe('Blue Tokai')
  })

  it('writes a fallback signal packet only when Fusion fails', async () => {
    fusionReactiveDecisionMock.mockRejectedValueOnce(new Error('fusion offline'))

    await handleMessageAlpha('telegram', 'tg-1', 'what should i do tonight')
    await vi.runAllTimersAsync()

    expect(insertSignalPacketMock).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a duplicate fallback signal packet when Fusion succeeds', async () => {
    await handleMessageAlpha('telegram', 'tg-1', 'what should i do tonight')
    await vi.runAllTimersAsync()

    expect(insertSignalPacketMock).not.toHaveBeenCalled()
  })
})
