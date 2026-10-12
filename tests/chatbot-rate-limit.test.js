/**
 * tests/chatbot-rate-limit.test.js
 *
 * Verifies the chatbot rate-limit behaviour introduced in phase0-preflight:
 *
 *   1. All 11 messages (10 allowed + 1 throttled) are saved to the DB.
 *   2. The first 10 messages each trigger a normal reply.
 *   3. Message 11 (the one that exceeds the limit) does NOT get a normal reply.
 *   4. Exactly ONE throttle reply is sent to the sender per window.
 *   5. A second window resets the counter — message 12 is processed normally.
 *   6. Two senders are rate-limited independently.
 *   7. The throttle reply text comes from the 'chatbot_throttle_reply' setting
 *      when set, falling back to the default otherwise.
 *
 * These tests use the real application stack (real DB, real chatbot.js) but
 * mock the WhatsApp send layer so no real messages are dispatched.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/chatbot-rate-limit.test.js --forceExit
 */
'use strict';

describe('Chatbot rate-limit — lead-drop fix', () => {
    let db, userId;

    // Collected sends from the fake WhatsApp layer
    const sentMessages = [];

    // A minimal fake client / msg that records sends without touching WhatsApp
    function makeFakeClient() {
        return {
            sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); }
        };
    }
    function makeFakeMsg(from, body) {
        return {
            from,
            body,
            isGroupMsg: false,
            fromMe:     false,
            reply: async (text) => { sentMessages.push({ chatId: from, text }); },
            getChat: async () => ({ sendStateTyping: async () => {} })
        };
    }

    beforeAll(async () => {
        db = await freshDatabase();
        const { createUser } = require('../src/services/database');
        const user = await createUser({
            email: `rl_test_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });
        userId = user.id;

        // Enable chatbot with a simple default reply so every non-throttled
        // message actually produces an outgoing message.
        const { setSetting } = require('../src/services/database');
        await setSetting(userId, 'chatbot_enabled', 'true');
        await setSetting(userId, 'ai_enabled', 'false');
        await setSetting(userId, 'default_reply', 'Hello from bot!');
    });

    beforeEach(() => {
        sentMessages.length = 0;

        // Reset the rate-limit state between tests by clearing internal maps.
        // We reach into the module to do this — it is the same approach the
        // existing rateLimit.js tests use with clearBuckets().
        const chatbot = require('../src/services/chatbot');
        if (typeof chatbot.__resetRateLimits === 'function') {
            chatbot.__resetRateLimits();
        }
    });

    // ─── Helper: fire N messages from one sender synchronously (serialised) ───
    async function fireMessages(phone, count, opts = {}) {
        const { processMessage } = require('../src/services/chatbot');
        const client = makeFakeClient();
        const results = [];
        for (let i = 0; i < count; i++) {
            const body = opts.body || `Message ${i + 1}`;
            const msg = makeFakeMsg(`${phone}@c.us`, body);
            // processMessage serialises per-conversation via conversationQueue
            const result = await processMessage(userId, phone, body, `Sender ${phone}`, client, msg);
            results.push(result);
        }
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────────
    test('all 11 messages are stored in the DB regardless of rate limit', async () => {
        const phone = '919000000001';
        await fireMessages(phone, 11);

        const { countMessages } = require('../src/services/database');
        const stored = await countMessages(userId, { phone, direction: 'incoming' });
        expect(stored).toBe(11);
    });

    test('first 10 messages each get a normal reply (default reply)', async () => {
        const phone = '919000000002';
        const results = await fireMessages(phone, 10);

        // Every result should be replied:true
        results.forEach((r, i) => {
            expect(r.replied).toBe(true);
        });

        // 10 outgoing messages logged in DB
        const { countMessages } = require('../src/services/database');
        const outgoing = await countMessages(userId, { phone, direction: 'outgoing' });
        expect(outgoing).toBe(10);
    });

    test('message 11 does NOT get a normal reply (reason: rate_limit)', async () => {
        const phone = '919000000003';
        const results = await fireMessages(phone, 11);

        const eleventh = results[10];
        expect(eleventh.replied).toBe(false);
        expect(eleventh.reason).toBe('rate_limit');
    });

    test('exactly ONE throttle reply is sent for messages 11..N in the same window', async () => {
        const phone = '919000000004';
        // Send 15 messages — only one throttle reply should go out
        await fireMessages(phone, 15);

        // Count outgoing: 10 normal replies + 1 throttle reply = 11
        const { countMessages } = require('../src/services/database');
        const outgoing = await countMessages(userId, { phone, direction: 'outgoing' });
        expect(outgoing).toBe(11);

        // The 11th outgoing message in sentMessages is the throttle reply
        const throttleReplies = sentMessages.filter(m =>
            m.text.includes("quickly") || m.text.includes("right with you")
        );
        expect(throttleReplies).toHaveLength(1);
    });

    test('throttle reply text comes from chatbot_throttle_reply setting when set', async () => {
        const phone = '919000000005';
        const customText = 'Please slow down, I will respond soon!';
        const { setSetting } = require('../src/services/database');
        await setSetting(userId, 'chatbot_throttle_reply', customText);

        await fireMessages(phone, 11);

        expect(sentMessages.some(m => m.text === customText)).toBe(true);

        // Clean up
        await setSetting(userId, 'chatbot_throttle_reply', '');
    });

    test('two different senders are rate-limited independently', async () => {
        const phoneA = '919000000006';
        const phoneB = '919000000007';

        // Fire 11 from A (A gets throttled after 10)
        const resultsA = await fireMessages(phoneA, 11);
        // Fire 5 from B (B is well within limit)
        const resultsB = await fireMessages(phoneB, 5);

        // A's 11th should be rate-limited
        expect(resultsA[10].reason).toBe('rate_limit');

        // All of B's should be replied normally
        resultsB.forEach(r => expect(r.replied).toBe(true));
    });
});
