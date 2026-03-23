import {
    handleMessage as handleMessageLegacy,
    resetUserSession as resetUserSessionLegacy,
    saveUserLocation as saveUserLocationLegacy,
    type MessageResponse
} from './handler-legacy.js';

import { handleMessageAlpha } from './handler-alpha.js';

import type { HandleMessageOptions } from './handler-legacy.js';
import { logger } from '../utils/logger.js';

// Feature flag: set in .env
// ALPHA_HANDLER_ENABLED=true  → use new 5-step pipeline
// ALPHA_AB_MODE=true          → run BOTH, log comparison, return Alpha result
export async function handleMessage(
    channel: string,
    channelUserId: string,
    rawMessage: string,
    options: HandleMessageOptions = {}
): Promise<MessageResponse> {
    const handlerVersion = process.env.HANDLER_VERSION?.toLowerCase()
    const useAlpha = handlerVersion
        ? handlerVersion === 'v2' || handlerVersion === 'alpha'
        : process.env.ALPHA_HANDLER_ENABLED === 'true'
    const abMode = process.env.ALPHA_AB_MODE === 'true'

    if (abMode) {
        logger.debug('[Handler] Running A/B comparison', { channel, channelUserId })
        const start = Date.now()
        const [legacyResult, alphaResult] = await Promise.all([
            handleMessageLegacy(channel, channelUserId, rawMessage, options)
                .catch(err => ({ text: `[LEGACY_ERROR] ${err.message}` } as MessageResponse)),
            handleMessageAlpha(channel, channelUserId, rawMessage, options)
                .catch(err => ({ text: `[ALPHA_ERROR] ${err.message}` } as MessageResponse)),
        ])
        const elapsedMs = Date.now() - start

        logger.debug('[Handler/AB] Completed', {
            elapsedMs,
            legacyChars: legacyResult.text.length,
            alphaChars: alphaResult.text.length,
        })
        return alphaResult
    }

    if (useAlpha) {
        logger.debug('[Handler] Using alpha handler', { channel, channelUserId })
        return handleMessageAlpha(channel, channelUserId, rawMessage, options)
    }
    logger.debug('[Handler] Using legacy handler', { channel, channelUserId })
    return handleMessageLegacy(channel, channelUserId, rawMessage, options)
}

// Pass-through exports
export function resetUserSession(channel: string, channelUserId: string) {
    return resetUserSessionLegacy(channel, channelUserId);
}

export function saveUserLocation(userId: string, location: string) {
    return saveUserLocationLegacy(userId, location);
}

export type { MessageResponse };
