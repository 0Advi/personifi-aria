import { describe, it, expect } from 'vitest';
import {
    buildContext,
    compressToolResults,
    countContextTokens,
    countTokens,
    MAX_TOKENS,
    serializeToolResultForPrompt,
} from './context-manager.js';

describe('Context Manager', () => {
    it('empty context stays within budget', () => {
        const result = buildContext('', { userContext: '', pulseTopics: '', history: [] }, '');
        expect(countTokens(result.soul)).toBe(0);
    });

    it('max history + large tool result gets truncated to fit', () => {
        const longHistory = Array(50).fill({ role: 'user', content: 'A'.repeat(800) }); // 50 * 200 = 10000 tokens
        const largeToolResult = 'B'.repeat(10000); // 2500 tokens
        
        const result = buildContext('soul', {
            userContext: 'ctx',
            pulseTopics: 'pulse',
            history: longHistory,
            toolResults: largeToolResult
        }, 'proactive');

        // Total should be exactly or very close to MAX_TOKENS (8192)
        const total = countTokens(result.soul) 
                    + countTokens(result.userContext) 
                    + countTokens(result.proactiveState) 
                    + countTokens(result.pulseTopics) 
                    + result.history.reduce((a, m) => a + countTokens(m.content), 0) 
                    + countTokens(result.toolResults);
        
        expect(total).toBeLessThanOrEqual(MAX_TOKENS);
    });

    it('ProactiveState injection is counted in budget', () => {
         const proactive = 'P'.repeat(1200); // 300 tokens
         const result = buildContext('soul', { userContext: '', pulseTopics: '', history: [] }, proactive);
         expect(countTokens(result.proactiveState)).toBe(300);
    });

    it('compression reduces tool output by >= 50%', () => {
         const largeJson = JSON.stringify(Array(400).fill({ prop: "very long property value that takes up space" }));
         const originalTokens = countTokens(largeJson);
         const compressed = compressToolResults(largeJson, 800);
         const newTokens = countTokens(compressed);
         
         expect(newTokens).toBeLessThanOrEqual(800);
         expect(newTokens).toBeLessThan(originalTokens / 2);
    });

    it('tracks warning threshold before Alpha call', () => {
        const breakdown = countContextTokens({
            soul: 'S'.repeat(5000),
            userContext: 'C'.repeat(5000),
            proactiveState: 'P'.repeat(3500),
            pulseTopics: 'Pulse: ENGAGED',
            history: Array(8).fill({ role: 'user', content: 'H'.repeat(1400) }),
            toolResults: 'T'.repeat(4000),
        });

        expect(breakdown.total).toBeGreaterThan(0);
        expect(breakdown.overWarning).toBe(true);
    });

    it('drops graph context first when budget gets tight', () => {
        const result = buildContext(
            'S'.repeat(15000),
            {
                userContext: [
                    '## User Profile',
                    'Name: Aditya',
                    '',
                    '## Memory Highlights',
                    'Loved rooftop cafes in Koramangala',
                    '',
                    '## Graph Context',
                    'G'.repeat(8000),
                ].join('\n'),
                pulseTopics: 'Pulse: ENGAGED',
                history: Array(8).fill({ role: 'user', content: 'H'.repeat(1500) }),
            },
            'ProactiveState: keep this',
        );

        expect(result.userContext).toContain('## User Profile');
        expect(result.userContext).not.toContain('## Graph Context');
    });

    it('removes media urls before tool results go back into prompt', () => {
        const serialized = serializeToolResultForPrompt({
            title: 'Cafe',
            imageUrl: 'https://example.com/cafe.jpg',
            photos: [{ url: 'https://example.com/pic.png' }],
            summary: 'good vibes',
        });

        expect(serialized).toContain('summary');
        expect(serialized).not.toContain('https://example.com');
        expect(serialized).not.toContain('imageUrl');
    });
});
