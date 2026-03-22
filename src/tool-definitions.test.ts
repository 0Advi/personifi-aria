import { describe, expect, it } from 'vitest'
import { ALPHA_TOOL_DEFINITIONS, ALPHA_TOOL_NAMES } from './tool-definitions.js'

describe('ALPHA_TOOL_DEFINITIONS', () => {
    it('exports the expected 8 curated Alpha tools', () => {
        expect(ALPHA_TOOL_DEFINITIONS).toHaveLength(8)
        expect(ALPHA_TOOL_NAMES).toEqual(new Set([
            'cab_compare',
            'place_search',
            'weather_check',
            'food_finder',
            'price_alert',
            'event_lookup',
            'friend_activity',
            'set_reminder',
        ]))
    })

    it('keeps every required field present in properties', () => {
        for (const tool of ALPHA_TOOL_DEFINITIONS) {
            const required = tool.function.parameters.required ?? []
            for (const field of required) {
                expect(tool.function.parameters.properties).toHaveProperty(field)
            }
        }
    })
})
