/**
 * tests/chatbot-rate-limit.test.js
 *
 * Verifies the chatbot rate-limit behaviour introduced in phase0-preflight:
 *
 *   1. All messages (allowed + throttled) are saved to the DB.
 *   2. Messages within the limit each trigger a normal reply.
 *   3. Messages over the limit do NOT get a normal reply (reason: rate_limit).
 *   4. Exactly ONE throttle reply is sent to the sender per window.
 *   5. Two senders are rate-limited independently.
 *   6. The throttle reply text comes from chatbot_throttle_reply setting when set.
 *
 * Uses the real DB stack with a low rate limit (RATE_MAX=3) to keep test
 * duration short — the human-sim delay in safeReply is 1.5-3s per message,
 * so we test 4 messages rather than 11.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/chatbot-rate-limit.test.js --forceExit
 */
'use strict';

// Set a low rate limit BEFORE any module loads so chatbot.js picks it up.
// resetModules:true in jest.config.js ensures each test file gets a fresh
// module registry, so this env var takes effect cleanly.
const RATE_MAX = 3;
process.env.CHATBOT_RATE_LIMIT_MAX       = String(RATE_MAX);
process.env.CHATBOT_RATE_LIMIT_WINDOW_MS = '60000';

describe('Chatbot rate-limit — lead-drop fix', () => {
    let db, userId;
    const sentMessages = [];

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
            fromMe: false,
            // Skip the typing state and delay — reply is what we need.
            reply: async (text) => { sentMessages.push({ chatId: from, text }); },
            getChat: async () => ({ sendStateTyping: async () => {} })
        };
    }

    beforeAll(async () => {
        db = await freshDatabase();
        const { createUser, setSetting } = require('../src/services/database');
        const user = await createUser({
            email: `rl_test_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });
        userId = user.id;

        // Enable chatbot with a static default reply (no AI, no delays).
        await setSetting(userId, 'chatbot_enabled', 'true');
        await setSetting(userId, 'ai_enabled', 'false');
        await setSetting(userId, 'default_reply', 'Bot reply');
    });

    beforeEach(() => {
        sentMessages.length = 0;
        const chatbot = require('../src/services/chatbot');
        if (typeof chatbot.__resetRateLimits === 'function') {
            chatbot.__resetRateLimits();
        }
    });

    async function fireMessages(phone, count, body) {
        const { processMessage } = require('../src/services/chatbot');
        const client = makeFakeClient();
        const results = [];
        for (let i = 0; i < count; i++) {
            const msgBody = body || `Message ${i + 1}`;
            const msg = makeFakeMsg(`${phone}@c.us`, msgBody);
            const result = await processMessage(userId, phone, msgBody, `Test sender`, client, msg);
            results.push(result);
        }
        return results;
    }

    // ─── 1. All messages are stored (including throttled ones) ─────────────
    test('all messages saved to DB regardless of rate limit (RATE_MAX+1 messages)', async () => {
        const phone = '919000000001';
        await fireMessages(phone, RATE_MAX + 1);

        const { countMessages } = require('../src/services/database');
        const stored = await countMessages(userId, { phone, direction: 'incoming' });
        expect(stored).toBe(RATE_MAX + 1);
    }, 30000);

    // ─── 2. Messages within the limit get normal replies ────────────────────
    test(`first ${RATE_MAX} messages each get a normal reply`, async () => {
        const phone = '919000000002';
        const results = await fireMessages(phone, RATE_MAX);
        results.forEach(r => expect(r.replied).toBe(true));

        const { countMessages } = require('../src/services/database');
        const outgoing = await countMessages(userId, { phone, direction: 'outgoing' });
        expect(outgoing).toBe(RATE_MAX);
    }, 30000);

    // ─── 3. Message RATE_MAX+1 is rate-limited ─────────────────────────────
    test(`message ${RATE_MAX + 1} is rate-limited (reason: rate_limit)`, async () => {
        const phone = '919000000003';
        const results = await fireMessages(phone, RATE_MAX + 1);
        const last = results[RATE_MAX];
        expect(last.replied).toBe(false);
        expect(last.reason).toBe('rate_limit');
    }, 30000);

    // ─── 4. Exactly one throttle reply per window ───────────────────────────
    test('exactly ONE throttle reply sent for RATE_MAX+1 message', async () => {
        const phone = '919000000004';
        await fireMessages(phone, RATE_MAX + 1);

        // RATE_MAX normal replies + 1 throttle = RATE_MAX+1 outgoing
        const { countMessages } = require('../src/services/database');
        const outgoing = await countMessages(userId, { phone, direction: 'outgoing' });
        expect(outgoing).toBe(RATE_MAX + 1);
    }, 30000);

    // ─── 5. Per-tenant custom throttle reply ───────────────────────────────
    test('throttle reply uses chatbot_throttle_reply setting when set', async () => {
        const phone = '919000000005';
        const customText = 'Please slow down!';
        const { setSetting } = require('../src/services/database');
        await setSetting(userId, 'chatbot_throttle_reply', customText);

        await fireMessages(phone, RATE_MAX + 1);

        expect(sentMessages.some(m => m.text === customText)).toBe(true);
        await setSetting(userId, 'chatbot_throttle_reply', '');
    }, 30000);

    // ─── 6. Two senders are rate-limited independently ─────────────────────
    test('two senders are rate-limited independently', async () => {
        const phoneA = '919000000006';
        const phoneB = '919000000007';

        // A exceeds limit
        const resultsA = await fireMessages(phoneA, RATE_MAX + 1);
        // B is within limit
        const resultsB = await fireMessages(phoneB, RATE_MAX);

        expect(resultsA[RATE_MAX].reason).toBe('rate_limit');
        resultsB.forEach(r => expect(r.replied).toBe(true));
    }, 60000);
});
