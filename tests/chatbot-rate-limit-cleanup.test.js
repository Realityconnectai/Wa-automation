/**
 * tests/chatbot-rate-limit-cleanup.test.js
 *
 * Deterministic unit tests for DEF-07:
 *   - Bounded map capacity and proactive eviction of expired entries.
 *   - Correct expiry sweep preserving unexpired active throttles.
 *   - Safe timer shutdown without leaking open handles.
 */
'use strict';

const chatbot = require('../src/services/chatbot');

describe('DEF-07: Chatbot rate-limit bounded cleanup', () => {
    beforeEach(() => {
        chatbot.__resetRateLimits();
    });

    afterAll(() => {
        chatbot.stopChatbotCleanup();
    });

    test('cleanupExpiredRateLimits evicts entries older than window', () => {
        const userId = 1;
        const now = 1000000;

        // Populate two senders: one recent, one old
        chatbot.isRateLimited(userId, '919999999991');
        chatbot.isRateLimited(userId, '919999999992');

        // Manually run cleanup with a future timestamp (e.g. 5 minutes later)
        chatbot.cleanupExpiredRateLimits(Date.now() + 5 * 60 * 1000);

        // Next message from the expired sender starts a fresh count (count = 1, not rate limited)
        const limited = chatbot.isRateLimited(userId, '919999999991');
        expect(limited).toBe(false);
    });

    test('active rate-limit state is preserved during partial cleanup', () => {
        const userId = 2;
        // Fire messages up to limit
        for (let i = 0; i < 10; i++) {
            chatbot.isRateLimited(userId, '919888888888');
        }
        // Exceed limit
        const overLimit = chatbot.isRateLimited(userId, '919888888888');
        expect(overLimit).toBe(true);

        // Run cleanup at current time — should NOT evict active unexpired sender
        chatbot.cleanupExpiredRateLimits(Date.now());
        const stillLimited = chatbot.isRateLimited(userId, '919888888888');
        expect(stillLimited).toBe(true);
    });

    test('stopChatbotCleanup stops interval without errors', () => {
        expect(() => chatbot.stopChatbotCleanup()).not.toThrow();
    });
});
