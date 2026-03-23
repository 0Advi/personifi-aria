import type { ToolDefinition } from './llm/tool-contracts.js'

export type AlphaToolDefinition = ToolDefinition

export const ALPHA_TOOL_DEFINITIONS: AlphaToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'cab_compare',
            description: 'Compare cab prices across Ola, Uber, Rapido, and Namma Yatri for a route.',
            parameters: {
                type: 'object',
                properties: {
                    origin: { type: 'string', description: 'Pickup location or area' },
                    destination: { type: 'string', description: 'Drop location or area' },
                },
                required: ['origin', 'destination'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'place_search',
            description: 'Search for cafes, restaurants, shops, or places near a location.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for' },
                    location: { type: 'string', description: 'Area or neighbourhood to search in' },
                    openNow: { type: 'boolean', description: 'Only include places open right now' },
                    minRating: { type: 'number', description: 'Minimum acceptable rating from 1 to 5' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'weather_check',
            description: 'Get current weather and short forecast for a location.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City or area name' },
                },
                required: ['location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'food_finder',
            description: 'Find food options or compare restaurant prices across delivery platforms.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Dish, cuisine, or restaurant to search for' },
                    location: { type: 'string', description: 'Area to search in' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'price_alert',
            description: 'Compare grocery or quick-commerce prices for an item.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Item or product to compare' },
                    location: { type: 'string', description: 'Area to search in' },
                    category: {
                        type: 'string',
                        description: 'Optional category hint',
                        enum: ['grocery', 'snacks', 'beverages', 'personal_care', 'other'],
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'event_lookup',
            description: 'Look up events, shows, activities, or things to do in an area.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Event type or activity to search for' },
                    location: { type: 'string', description: 'City or area to search in' },
                    date: { type: 'string', description: 'Optional natural-language date or date range' },
                },
                required: ['query', 'location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'friend_activity',
            description: 'Check recent or known activity for a specific friend.',
            parameters: {
                type: 'object',
                properties: {
                    friendId: { type: 'string', description: 'Friend identifier or known name' },
                },
                required: ['friendId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_reminder',
            description: 'Set a reminder for the user at a specific time.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'What to remind the user about' },
                    time: { type: 'string', description: 'Natural-language time for the reminder' },
                },
                required: ['message', 'time'],
            },
        },
    },
]

export const ALPHA_TOOL_NAMES: ReadonlySet<string> = new Set(
    ALPHA_TOOL_DEFINITIONS.map(tool => tool.function.name),
)
