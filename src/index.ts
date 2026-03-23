/**
 * Aria Travel Guide - Main Server
 * Multi-channel support with proactive scheduler and browser automation
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { handleMessage, initDatabase, registerBrainHooks, saveUserLocation } from './character/index.js'
import { getOrCreateUser } from './character/session-store.js'
import { brainHooks } from './brain/index.js'
import { initScheduler } from './scheduler.js'
import { initMCPTokenStore } from './tools/mcp-client.js'
import { initArchivist } from './archivist/index.js'
import { initBrowser, closeBrowser } from './browser.js'
import './tools/index.js'  // Register body hooks (DEV 2 tools)
import { verifySlackSignature } from './slack-verify.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  channels,
  getEnabledChannels,
  type ChannelAdapter,
  type ChannelMessage
} from './channels.js'
import { pendingLocationStore, reverseGeocode } from './location.js'
import { setLiveUserLocation } from './location-presence.js'
import {
  DEFAULT_QUEUE_OVERFLOW_MESSAGE,
  MessageQueue,
  QueueOverflowError,
  WebhookDeduper,
  extractTelegramWebhookDedupKey,
} from './concurrency/message-queue.js'

// Type augmentation for raw body on Slack requests
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
  }
}

const server = Fastify({ logger: true })

type TelegramScalar = string | number

interface TelegramChat {
  id?: TelegramScalar
}

interface TelegramUser {
  id?: TelegramScalar
}

interface TelegramLocation {
  latitude: number
  longitude: number
}

interface TelegramMessage {
  chat?: TelegramChat
  from?: TelegramUser
  message_id?: TelegramScalar
  location?: TelegramLocation
  text?: string
}

interface TelegramCallbackQuery {
  id?: string
  data?: string
  from?: TelegramUser
  message?: {
    chat?: TelegramChat
  }
}

interface TelegramReactionEntry {
  type?: string
  emoji?: string
}

interface TelegramMessageReaction {
  chat?: TelegramChat
  user?: TelegramUser
  new_reaction?: TelegramReactionEntry[]
}

interface TelegramWebhookBody {
  callback_query?: TelegramCallbackQuery
  message?: TelegramMessage
  message_reaction?: TelegramMessageReaction
}

interface TelegramApiResponse {
  ok?: boolean
  description?: string
  result?: {
    message_id?: number
  }
}

type SlackWebhookBody = Record<string, unknown> & {
  type?: string
  challenge?: string
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return parsed
}

const messageQueue = new MessageQueue({
  maxConcurrentUsers: readPositiveIntEnv('MAX_CONCURRENT_USERS', 50),
  maxQueueDepthPerUser: readPositiveIntEnv('MAX_QUEUE_DEPTH_PER_USER', 5),
})

const telegramWebhookDeduper = new WebhookDeduper({ ttlMs: 5 * 60 * 1000 })

await server.register(cors)

// Health check with enabled channels
server.get('/health', async () => ({
  status: 'ok',
  character: 'aria',
  proactive: true,
  channels: getEnabledChannels().map(ch => ch.name),
}))

// ============================================
// Generic webhook handler for all channels
// ============================================

function getChannelJobId(message: ChannelMessage): string {
  const metadata = message.metadata ?? {}
  const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : null
  return messageId ?? `${message.channel}:${message.timestamp.getTime()}`
}

async function enqueueUserTask(
  userId: string,
  jobId: string,
  task: () => Promise<void>,
  onOverflow?: () => Promise<void>,
): Promise<void> {
  try {
    await messageQueue.enqueue({ userId, jobId, task })
  } catch (error) {
    if (error instanceof QueueOverflowError) {
      server.log.warn({ userId, jobId, queueDepth: error.queueDepth }, 'Queue overflow, sending soft backpressure message')
      if (onOverflow) {
        await onOverflow().catch(overflowError => {
          server.log.error(overflowError, 'Failed to send queue overflow response')
        })
      }
      return
    }

    throw error
  }
}

function runDetached(label: string, task: () => Promise<void>): void {
  void task().catch(error => {
    server.log.error(error, label)
  })
}

async function processChannelMessage(adapter: ChannelAdapter, body: unknown): Promise<void> {
  const message = adapter.parseWebhook(body)
  if (!message) return

  await enqueueUserTask(
    message.userId,
    getChannelJobId(message),
    async () => {
      const response = await handleMessage(message.channel, message.userId, message.text)
      if (response.media?.length && adapter.sendMedia) {
        await adapter.sendMedia(message.chatId, response.media)
      }
      await adapter.sendMessage(message.chatId, response.text)
    },
    async () => {
      await adapter.sendMessage(message.chatId, DEFAULT_QUEUE_OVERFLOW_MESSAGE)
    },
  )
}

// ============================================
// Telegram helpers
// ============================================

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || ''

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Fire-and-forget typing indicator. Never awaited — must not block the pipeline. */
function sendChatAction(chatId: string, action: string): void {
  const token = TOKEN()
  if (!token) return
  fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => { })
}

/** Determine typing action from message text before 8B runs. */
function typingActionFor(text: string): string {
  const t = text.toLowerCase()
  if (/flight|fly|airline/.test(t)) return 'upload_document'
  if (/where|place|restaurant|cafe|spot/.test(t)) return 'find_location'
  if (/photo|picture|image|gallery/.test(t)) return 'upload_photo'
  return 'typing'
}

/** True when the message probably needs a real-time lookup. */
function looksLikeLookup(text: string): boolean {
  return /flight|hotel|weather|rain|restaurant|food|order|compare|price|place|where|weather/.test(
    text.toLowerCase()
  )
}

/**
 * Show a placeholder bubble for any message that will take a noticeable moment
 * to process — either a data lookup or any conversational message with substance.
 */
function needsPlaceholder(text: string): boolean {
  const wordCount = text.trim().split(/\s+/).length
  return looksLikeLookup(text) || wordCount > 4
}

const THINKING_BUBBLES = [
  'Thinking...',
  'Hmm, let me think da...',
  'One sec...',
  '...',
]

const LOCATION_ACKS = [
  (addr: string) => `📍 Got it — <b>${addr}</b>! Give me a sec...`,
  (addr: string) => `Nice, using <b>${addr}</b>. On it! 🗺️`,
  (addr: string) => `<b>${addr}</b> — perfect. Hang tight da.`,
  (addr: string) => `Locked in <b>${addr}</b>. Let me pull this up.`,
]

const LOCATION_ERRORS = [
  "Couldn't read your location da — mind typing your area name instead?",
  "Hmm, that location didn't come through clearly. Just type your neighbourhood and I've got you!",
  "My GPS sense is off right now 😅 — type your area and I'll sort it.",
]

/** Placeholder text matched to query type — falls back to a thinking bubble. */
function placeholderFor(text: string): string {
  const t = text.toLowerCase()
  if (/flight|fly/.test(t)) return '✈️ Checking flights...'
  if (/hotel|stay/.test(t)) return '🏨 Looking up stays...'
  if (/weather|rain/.test(t)) return '🌤️ Checking the sky...'
  if (/food|order|restaurant/.test(t)) return '🍽️ Hunting for the best bites...'
  if (/place|where|cafe/.test(t)) return '📍 Finding spots near you...'
  if (/grocery|blinkit|zepto/.test(t)) return '🛒 Checking grocery prices...'
  return pick(THINKING_BUBBLES)
}

async function tgFetch(method: string, body: object): Promise<TelegramApiResponse | null> {
  const token = TOKEN()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null) as TelegramApiResponse | null
    if (!res.ok || data?.ok === false) {
      server.log.warn({ method, description: data?.description || res.statusText }, 'Telegram API call failed')
    }
    return data
  } catch (err) {
    server.log.warn({ err, method }, 'Telegram API transport error')
    return null
  }
}

/**
 * Send a Telegram message with an inline keyboard attachment.
 * Used for the "Share Location" ReplyKeyboard and inline button rows.
 */
async function sendTelegramWithKeyboard(
  chatId: string,
  text: string,
  keyboard: object
): Promise<void> {
  await tgFetch('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: keyboard,
    parse_mode: 'HTML',
  })
}

/** Dismiss any visible ReplyKeyboard by sending remove_keyboard. */
async function dismissKeyboard(chatId: string, text: string): Promise<void> {
  await tgFetch('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  })
}

/** Drop a named map pin for the top places result. */
async function sendVenue(chatId: string, place: {
  name: string; address?: string; lat: number; lng: number
}): Promise<void> {
  await tgFetch('sendVenue', {
    chat_id: chatId,
    latitude: place.lat,
    longitude: place.lng,
    title: place.name,
    address: place.address ?? '',
  })
}

async function processTelegramCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const chatId = String(query?.message?.chat?.id ?? '')
  const userId = String(query?.from?.id ?? '')
  const callbackId = String(query?.id ?? '')
  const data = typeof query?.data === 'string' ? query.data : ''

  if (!chatId || !userId || !data || !callbackId) {
    return
  }

  await tgFetch('answerCallbackQuery', { callback_query_id: callbackId })

  await enqueueUserTask(
    userId,
    `telegram:callback:${callbackId}`,
    async () => {
      const { handleCallbackAction } = await import('./character/callback-handler.js')
      const response = await handleCallbackAction('telegram', userId, data)

      if (!response?.text) {
        return
      }

      if (response.choices?.length) {
        await sendTelegramWithKeyboard(chatId, response.text, {
          inline_keyboard: response.choices.map(choice => [{ text: choice.label, callback_data: choice.action }]),
        })
        return
      }

      await channels.telegram.sendMessage(chatId, response.text)
    },
    async () => {
      await channels.telegram.sendMessage(chatId, DEFAULT_QUEUE_OVERFLOW_MESSAGE)
    },
  )
}

async function processTelegramLocationMessage(message: TelegramMessage): Promise<void> {
  const userId = String(message?.from?.id ?? '')
  const chatId = String(message?.chat?.id ?? '')
  const messageId = String(message?.message_id ?? 'location')
  const location = message.location

  if (!userId || !chatId || !location) {
    return
  }

  await enqueueUserTask(
    userId,
    `telegram:location:${messageId}`,
    async () => {
      const { latitude, longitude } = location
      const address = await reverseGeocode(latitude, longitude)
      const user = await getOrCreateUser('telegram', userId)
      await saveUserLocation(user.userId, address)
      setLiveUserLocation(userId, { address, lat: latitude, lng: longitude, source: 'gps' })

      const pending = pendingLocationStore.get(userId)
      pendingLocationStore.delete(userId)

      await dismissKeyboard(chatId, pick(LOCATION_ACKS)(address))

      if (!pending) {
        await channels.telegram.sendMessage(chatId, 'Lovely — location saved ✅ What should I call you?')
        return
      }

      const originalQuery = pending.originalMessage || ''
      const retriggerMsg = originalQuery
        ? `${originalQuery.replace(/near\s+me/i, '').trim()} near ${address}`
        : `near ${address}`

      sendChatAction(chatId, 'find_location')
      const response = await handleMessage('telegram', userId, retriggerMsg)

      if (response.media?.length && channels.telegram.sendMedia) {
        await channels.telegram.sendMedia(chatId, response.media)
      }
      await channels.telegram.sendMessage(chatId, response.text)
    },
    async () => {
      await channels.telegram.sendMessage(chatId, DEFAULT_QUEUE_OVERFLOW_MESSAGE)
    },
  )
}

async function processTelegramTextMessage(body: TelegramWebhookBody): Promise<void> {
  const adapter = channels.telegram
  const parsedMessage = adapter.parseWebhook(body)
  if (!parsedMessage) return

  const chatId = parsedMessage.chatId
  const msgText = parsedMessage.text
  const jobId = `telegram:text:${String(body?.message?.message_id ?? parsedMessage.timestamp.getTime())}`

  await enqueueUserTask(
    parsedMessage.userId,
    jobId,
    async () => {
      sendChatAction(chatId, typingActionFor(msgText))

      let placeholderMsgId: number | null = null
      if (needsPlaceholder(msgText)) {
        const res = await tgFetch('sendMessage', {
          chat_id: chatId,
          text: placeholderFor(msgText),
        })
        placeholderMsgId = res?.result?.message_id ?? null
      }

      const response = await handleMessage(parsedMessage.channel, parsedMessage.userId, msgText)

      if (placeholderMsgId) {
        if (response.requestLocation || response.media?.length || response._buttons?.length) {
          await tgFetch('deleteMessage', { chat_id: chatId, message_id: placeholderMsgId })
          placeholderMsgId = null
        } else {
          await tgFetch('editMessageText', {
            chat_id: chatId,
            message_id: placeholderMsgId,
            text: response.text,
            parse_mode: 'HTML',
          })
        }
      }

      if (response.media?.length && adapter.sendMedia) {
        await adapter.sendMedia(chatId, response.media)
      }

      if (!placeholderMsgId || response.media?.length) {
        if (response.requestLocation) {
          await sendTelegramWithKeyboard(chatId, response.text, {
            keyboard: [[{ text: '📍 Share my location', request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          })
          const user = await getOrCreateUser(parsedMessage.channel, parsedMessage.userId)
          if (user.authenticated) {
            pendingLocationStore.set(parsedMessage.userId, {
              toolHint: 'food_grocery',
              chatId,
              originalMessage: msgText,
            })
          }
        } else if (response._buttons?.length) {
          await sendTelegramWithKeyboard(chatId, response.text, {
            inline_keyboard: response._buttons,
          })
        } else {
          await adapter.sendMessage(chatId, response.text)
        }
      }

      if (response.venues?.length && !response.media?.length) {
        await Promise.all(response.venues.slice(0, 3).map(venue => sendVenue(chatId, venue)))
      }
    },
    async () => {
      await adapter.sendMessage(chatId, DEFAULT_QUEUE_OVERFLOW_MESSAGE)
    },
  )
}

async function processTelegramWebhook(body: TelegramWebhookBody): Promise<void> {
  if (body?.callback_query) {
    await processTelegramCallbackQuery(body.callback_query)
    return
  }

  if (body?.message_reaction) {
    const reaction = body.message_reaction
    const chatId = String(reaction.chat?.id ?? '')
    const userId = String(reaction.user?.id ?? '')
    const positiveEmoji = ['🔥', '👍', '❤️', '😍', '🤩', '🫡', '💯']
    const isPositive = (reaction.new_reaction ?? [])
      .some(r => r.type === 'emoji' && typeof r.emoji === 'string' && positiveEmoji.includes(r.emoji))

    if (isPositive && chatId && userId) {
      setTimeout(async () => {
        const followUps = [
          'Glad you liked it da! 😄 Want me to find more like this?',
          'Right? This city is unhinged in the best way 🔥 Want directions or delivery options?',
          'Aye! Should I check if it\'s open / bookable right now?',
        ]
        await channels.telegram.sendMessage(chatId, pick(followUps))
      }, 8000)
    }
    return
  }

  const message = body?.message
  if (message?.location) {
    try {
      await processTelegramLocationMessage(message)
    } catch (error) {
      const chatId = String(message?.chat?.id ?? '')
      server.log.error(error, 'Failed to handle Telegram location message')
      if (chatId) {
        await channels.telegram.sendMessage(chatId, pick(LOCATION_ERRORS))
      }
    }
    return
  }

  await processTelegramTextMessage(body)
}

// ============================================
// Telegram Webhook
// ============================================

server.post('/webhook/telegram', async (request, reply) => {
  if (!channels.telegram.isEnabled()) {
    return { ok: false, error: 'Telegram not configured' }
  }

  // Verify webhook secret token (set via Telegram setWebhook API)
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (webhookSecret) {
    const headerSecret = request.headers['x-telegram-bot-api-secret-token']
    const incomingToken = Array.isArray(headerSecret) ? headerSecret[0] : (headerSecret || '')
    const expectedDigest = createHash('sha256').update(webhookSecret).digest()
    const actualDigest = createHash('sha256').update(incomingToken).digest()
    if (!timingSafeEqual(expectedDigest, actualDigest)) {
      server.log.warn('Telegram webhook: invalid secret token')
      return reply.code(403).send({ ok: false, error: 'Forbidden' })
    }
  }

  const body = request.body as TelegramWebhookBody
  const dedupKey = extractTelegramWebhookDedupKey(body)
  if (dedupKey && !telegramWebhookDeduper.rememberIfNew(dedupKey)) {
    server.log.info({ dedupKey }, 'Skipping duplicate Telegram webhook')
    return reply.code(200).send({ ok: true, duplicate: true })
  }

  await reply.code(200).send({ ok: true })
  runDetached('Failed to process Telegram webhook', async () => {
    await processTelegramWebhook(body)
  })
})

// ============================================
// WhatsApp Webhook
// ============================================

server.get('/webhook/whatsapp', async (request, reply) => {
  const query = request.query as Record<string, string>
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return reply.send(challenge)
  }
  return reply.code(403).send('Forbidden')
})

server.post('/webhook/whatsapp', async (request, reply) => {
  if (!channels.whatsapp.isEnabled()) {
    return { ok: false, error: 'WhatsApp not configured' }
  }

  await reply.code(200).send({ ok: true })
  runDetached('Failed to process WhatsApp webhook', async () => {
    await processChannelMessage(channels.whatsapp, request.body)
  })
})

// ============================================
// Slack Webhook
// ============================================

server.addHook('preParsing', async (request, reply, payload) => {
  if (request.url === '/webhook/slack' && request.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    request.rawBody = raw
    const { Readable } = await import('node:stream')
    const newPayload = Readable.from(Buffer.from(raw)) as typeof payload
    return newPayload
  }
  return payload
})

server.post('/webhook/slack', async (request, reply) => {
  const body = request.body as SlackWebhookBody

  // Handle Slack URL verification first — must come before signature
  // verification because Slack sends this during initial app setup.
  if (body?.type === 'url_verification') {
    return { challenge: body.challenge }
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (signingSecret) {
    if (!request.rawBody) {
      server.log.warn('Missing raw body for Slack signature verification')
      return reply.code(400).send({ error: 'Invalid request' })
    }
    const result = verifySlackSignature(
      signingSecret,
      request.headers['x-slack-request-timestamp'] as string | undefined,
      request.rawBody,
      request.headers['x-slack-signature'] as string | undefined
    )
    if (!result.valid) {
      server.log.warn(`Slack signature verification failed: ${result.error}`)
      return reply.code(403).send({ error: result.error })
    }
  }

  if (!channels.slack.isEnabled()) {
    return { ok: false, error: 'Slack not configured' }
  }

  await reply.code(200).send({ ok: true })
  runDetached('Failed to process Slack webhook', async () => {
    await processChannelMessage(channels.slack, body)
  })
})

// ============================================
// Send message helper (used by scheduler)
// ============================================

export async function sendChannelMessage(
  channelName: string,
  chatId: string,
  text: string
): Promise<void> {
  const adapter = channels[channelName]
  if (adapter && adapter.isEnabled()) {
    await adapter.sendMessage(chatId, text)
  }
}

// ============================================
// Startup
// ============================================

const start = async () => {
  try {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) throw new Error('DATABASE_URL is required')
    initDatabase(dbUrl)

    await initMCPTokenStore(dbUrl)
    initArchivist()
    registerBrainHooks(brainHooks)

    if (process.env.BROWSER_SCRAPING_ENABLED !== 'false') {
      await initBrowser()
    }

    initScheduler(dbUrl)

    const port = parseInt(process.env.PORT || '3000')
    await server.listen({ port, host: '0.0.0.0' })

    const enabledChannels = getEnabledChannels().map(ch => ch.name).join(', ') || 'none'
    server.log.info(`Aria ready on port ${port} | Channels: ${enabledChannels}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

process.on('SIGTERM', async () => { await closeBrowser(); await server.close(); process.exit(0) })
process.on('SIGINT', async () => { await closeBrowser(); await server.close(); process.exit(0) })

start()
