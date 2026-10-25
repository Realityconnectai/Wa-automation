const {
    getChatbotRules, incrementRuleHitCount, getSetting, getConversation,
    logMessage, getUserById, getMonthlyOutgoingCount,
    setContactOptOut, getContactOptOutStatus, isConversationAiPaused,
    cancelScheduledMessagesForPhone
} = require('./database');
const { generateReply } = require('./ai');
const { scheduleAutoAnalysis } = require('./lead-analyzer');
const { safeRegexTest } = require('../utils/validate');
const { conversationQueue } = require('../utils/conversation-queue');
const { tryBrochureDrop } = require('./brochure-drop');

// ─── Anti-Ban Rate Limiting ─────────────────────────────────
const userRateLimits = new Map();

// Configurable via environment. Defaults keep existing behaviour (10/min).
// CHATBOT_RATE_LIMIT_MAX  — max messages per window before throttling
// CHATBOT_RATE_LIMIT_WINDOW_MS — window size in milliseconds
const RATE_LIMIT_MAX       = Math.max(1, parseInt(process.env.CHATBOT_RATE_LIMIT_MAX,       10) || 10);
const RATE_LIMIT_WINDOW_MS = Math.max(5000, parseInt(process.env.CHATBOT_RATE_LIMIT_WINDOW_MS, 10) || 60000);

// Default throttle reply — can be overridden per-tenant via the
// 'chatbot_throttle_reply' setting key.
const DEFAULT_THROTTLE_REPLY =
    process.env.CHATBOT_THROTTLE_REPLY ||
    "You're sending messages very quickly — I'll be right with you! 🙏";

// Tracks whether a throttle reply has already been sent in the current window
// so we send at most one per window per sender.
// key: `${userId}:${phone}` → timestamp of last throttle-reply sent
const throttleReplySentAt = new Map();

// Bounded, time-aware sweep of expired rate limits and throttle replies.
function cleanupExpiredRateLimits(now = Date.now()) {
    for (const [key, data] of userRateLimits) {
        if (now - data.firstMsgTime > RATE_LIMIT_WINDOW_MS) userRateLimits.delete(key);
    }
    for (const [key, sentAt] of throttleReplySentAt) {
        if (now - sentAt > RATE_LIMIT_WINDOW_MS) throttleReplySentAt.delete(key);
    }
}

let _rateLimitCleanup = setInterval(() => {
    cleanupExpiredRateLimits();
}, 60 * 1000);
_rateLimitCleanup.unref?.();

function stopChatbotCleanup() {
    if (_rateLimitCleanup) {
        clearInterval(_rateLimitCleanup);
        _rateLimitCleanup = null;
    }
}

// Hard bound on the map itself. An attacker who can send from many numbers
// (or a spam wave) would otherwise create one entry per sender between
// sweeps; 100k entries is far past any legitimate volume for one server.
const MAX_RATE_LIMIT_KEYS = 100000;

// How much conversation history to load for AI context. The unbounded
// version loaded the *entire* conversation on every inbound message just to
// take the last 10 — so a customer with a 40k-message history caused 40k
// rows to be materialised per message received, on the shared event loop.
const AI_CONTEXT_MESSAGES = 10;

function isRateLimited(userId, phone) {
    const key = `${userId}:${phone}`;
    const now = Date.now();
    const limitData = userRateLimits.get(key) || { count: 0, firstMsgTime: now };

    // Reset window when it has expired
    if (now - limitData.firstMsgTime > RATE_LIMIT_WINDOW_MS) {
        limitData.count = 1;
        limitData.firstMsgTime = now;
    } else {
        limitData.count++;
    }

    if (userRateLimits.size >= MAX_RATE_LIMIT_KEYS && !userRateLimits.has(key)) {
        // Proactively evict expired entries before failing closed
        cleanupExpiredRateLimits(now);
        if (userRateLimits.size >= MAX_RATE_LIMIT_KEYS) {
            // Fail closed: refusing to auto-reply is the safe direction when
            // we're still tracking an implausible number of unexpired senders.
            return true;
        }
    }
    userRateLimits.set(key, limitData);

    return limitData.count > RATE_LIMIT_MAX;
}

/** True if this account has hit its plan's monthly outgoing-message cap (0 = unlimited). */
async function isOverPlanLimit(userId) {
    const account = await getUserById(userId);
    if (!account || !account.message_limit) return false;
    return (await getMonthlyOutgoingCount(userId)) >= account.message_limit;
}

/**
 * Matches one rule against incoming text.
 *
 * Extracted so the live path and the /chatbot/test preview cannot drift
 * apart — a preview that says "this matches" while the real path disagrees
 * is worse than no preview. The regex case goes through safeRegexTest,
 * which bounds input length; the pattern itself was already vetted against
 * catastrophic backtracking when the rule was saved (see
 * validate.assertSafeRegexSource). Rules stored before that check existed
 * still run through the same bounded matcher here.
 */
function ruleMatches(rule, text) {
    const keyword = String(rule.trigger_keyword || '').toLowerCase();
    if (keyword === '') return false;

    switch (rule.match_type) {
        case 'exact':      return text === keyword;
        case 'contains':   return text.includes(keyword);
        case 'startswith': return text.startsWith(keyword);
        case 'regex':      return safeRegexTest(rule.trigger_keyword, text);
        default:           return false;
    }
}

// ─── Human Simulation (Delay & Typing) ──────────────────────
async function safeReply(client, phone, responseText, msg = null, userId = null) {
    // Show typing indicator
    if (msg && client) {
        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch (e) {
            // Typing state is cosmetic only — don't fail the reply over it
            console.log('   ⚠️ Could not send typing state (non-fatal):', e.message?.split('\n')[0]);
        }
    }

    // Random human-like delay between 1.5–3 seconds (skip or minimum if in test)
    const delayMs = process.env.NODE_ENV === 'test' ? 10 : Math.floor(Math.random() * 1500) + 1500;
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Send reply — prefer msg.reply() to avoid WhatsApp LID format issues
    try {
        if (msg && typeof msg.reply === 'function') {
            await msg.reply(responseText);
        } else if (client && typeof client.sendMessage === 'function') {
            const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
            await client.sendMessage(chatId, responseText);
        } else if (userId) {
            const whatsappClient = require('./whatsapp-client');
            if (typeof whatsappClient.sendText === 'function') {
                await whatsappClient.sendText(userId, phone, responseText);
            }
        }
    } catch (sendErr) {
        console.error('   ❌ Primary reply failed, attempting fallback...', sendErr.message?.split('\n')[0]);
        if (client && msg && msg.from && typeof client.sendMessage === 'function') {
            await client.sendMessage(msg.from, responseText);
        } else if (userId) {
            const whatsappClient = require('./whatsapp-client');
            if (typeof whatsappClient.sendText === 'function') {
                await whatsappClient.sendText(userId, phone, responseText);
            }
        } else {
            throw sendErr;
        }
    }
}

// ─── Process an incoming message through chatbot rules (serialized) ──────
function processMessage(userId, arg2, arg3, arg4 = '', arg5 = null, arg6 = null) {
    let phone, messageText, contactName, client, msg;
    if (typeof arg2 === 'object' && arg2 !== null) {
        msg = arg2;
        phone = (msg.from || '').replace(/@.*$/, '');
        messageText = msg.body || '';
        contactName = msg.senderName || msg.contactName || '';
        client = arg3 || null;
    } else {
        phone = arg2;
        messageText = arg3 || '';
        contactName = arg4 || '';
        client = arg5 || null;
        msg = arg6 || null;
    }
    const cleanPhone = String(phone || '').replace(/@.*$/, '');
    const cleanMsg = String(messageText || '');
    return conversationQueue.enqueue(userId, cleanPhone, () =>
        _processMessageInternal(userId, cleanPhone, cleanMsg, contactName, client, msg)
    );
}

async function _processMessageInternal(userId, phone, messageText, contactName = '', client = null, msg = null) {
    messageText = messageText || '';
    phone = String(phone || '').replace(/@.*$/, '');
    // Log without the message body: this runs for every inbound message, and
    // customer message content in stdout ends up in any log aggregator,
    // container log, or terminal scrollback. Phone is partially masked for
    // the same reason.
    console.log(`🤖 processMessage: user ${userId}, ${maskPhone(phone)} (${messageText.length} chars)`);

    // Always log incoming message to database
    try {
        await logMessage(userId, {
            phone,
            contactName,
            direction: 'incoming',
            body: messageText
        });
    } catch (dbErr) {
        console.error('   ⚠️ Failed to log incoming message to DB:', dbErr.message);
    }

    // Queue a debounced AI lead-analysis of this conversation (runs after the chat goes quiet)
    try {
        scheduleAutoAnalysis(userId, phone);
    } catch (analysisErr) {
        console.error('   ⚠️ Could not schedule lead analysis:', analysisErr.message);
    }

    const cleanText = (messageText || '').trim();

    // ── 0a. Compliance: Inbound STOP / UNSUBSCRIBE Keyword Handling ──
    if (/^(stop|unsubscribe|cancel|opt[-_\s]?out|quit|end)$/i.test(cleanText)) {
        console.log(`🛑 [user ${userId}] Inbound opt-out request received from ${maskPhone(phone)}`);
        await setContactOptOut(userId, phone, true, 'Inbound STOP keyword');
        await cancelScheduledMessagesForPhone(userId, phone);
        const optOutReply = "You have been unsubscribed and will not receive further automated messages. Reply START to resubscribe.";
        try {
            await safeReply(client, phone, optOutReply, msg, userId);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: optOutReply });
        } catch (e) {
            console.warn(`   ⚠️ [user ${userId}] Could not send opt-out reply:`, e.message?.split('\n')[0]);
        }
        return { replied: true, reason: 'opt_out' };
    }

    // ── 0b. Compliance: Inbound START / UNSTOP Keyword Handling (Opt back in) ──
    if (/^(start|unstop)$/i.test(cleanText)) {
        console.log(`🟢 [user ${userId}] Inbound opt-in request received from ${maskPhone(phone)}`);
        await setContactOptOut(userId, phone, false, 'Inbound START keyword');
        const optInReply = "You have been resubscribed to messages. How can we help you today?";
        try {
            await safeReply(client, phone, optInReply, msg, userId);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: optInReply });
        } catch (e) {
            console.warn(`   ⚠️ [user ${userId}] Could not send opt-in reply:`, e.message?.split('\n')[0]);
        }
        return { replied: true, reason: 'opt_in' };
    }

    // ── 0c. Compliance: If contact has opted out, suppress all automated replies ──
    const optOutStatus = await getContactOptOutStatus(userId, phone);
    if (optOutStatus && optOutStatus.is_opted_out) {
        console.log(`🔇 [user ${userId}] Message from opted-out contact ${maskPhone(phone)} saved; auto-reply suppressed.`);
        return { replied: false, reason: 'contact_opted_out' };
    }

    // ── 0d. Human Takeover / AI Pause Check ──
    if (await isConversationAiPaused(userId, phone)) {
        console.log(`🧑 [user ${userId}] Human takeover active for ${maskPhone(phone)}: auto-reply paused.`);
        return { replied: false, reason: 'human_takeover' };
    }

    if (isRateLimited(userId, phone)) {
        // Warn-level log with only the last 4 digits — no message body, no full phone.
        console.warn(`⚠️ [user ${userId}] Rate limit exceeded for ****${String(phone).slice(-4)}: message saved, reply suppressed.`);

        // Send at most ONE throttle reply per sender per window.
        // We check and set throttleReplySentAt before the async send to avoid
        // a race where two queued messages both pass the check simultaneously.
        const rlKey = `${userId}:${phone}`;
        const now = Date.now();
        const lastThrottle = throttleReplySentAt.get(rlKey) || 0;
        if (now - lastThrottle > RATE_LIMIT_WINDOW_MS) {
            throttleReplySentAt.set(rlKey, now);
            try {
                // Per-tenant override via settings; fall back to env/default.
                const customReply = await getSetting(userId, 'chatbot_throttle_reply');
                const throttleText = (customReply && customReply.trim()) || DEFAULT_THROTTLE_REPLY;
                await safeReply(client, phone, throttleText, msg);
                await logMessage(userId, { phone, contactName, direction: 'outgoing', body: throttleText });
            } catch (throttleErr) {
                // Non-fatal: the message was already saved; losing the throttle
                // reply is acceptable.
                console.warn(`   ⚠️ [user ${userId}] Could not send throttle reply (non-fatal):`, throttleErr.message?.split('\n')[0]);
            }
        }

        return { replied: false, reason: 'rate_limit' };
    }

    if (await isOverPlanLimit(userId)) {
        console.log(`⚠️ Account ${userId} has hit its monthly message limit — skipping auto-reply.`);
        return { replied: false, reason: 'plan_limit_reached' };
    }

    const chatbotEnabled = await getSetting(userId, 'chatbot_enabled');
    if (chatbotEnabled !== 'true') {
        return { replied: false, reason: 'chatbot_disabled' };
    }

    const aiEnabled = await getSetting(userId, 'ai_enabled');
    const aiMode = (await getSetting(userId, 'ai_mode')) || 'ai_first';

    // ── 0. BROCHURE DROP (rule-based, no AI latency) ──
    // Runs BEFORE AI so real estate asset delivery is near-instant.
    // inboundReceivedAt is Date.now() at the start of this handler (approximate).
    const brochureDropEnabled = await getSetting(userId, 'brochure_drop_enabled');
    if (brochureDropEnabled !== 'false') {
        try {
            const dropResult = await tryBrochureDrop(
                userId, phone, contactName, messageText, client, msg, Date.now()
            );
            if (dropResult.handled) {
                if (dropResult.elapsedMs != null) {
                    console.log(`📦 Brochure drop: ${dropResult.action} for "${dropResult.projectName || 'N/A'}" in ${dropResult.elapsedMs}ms`);
                }
                return { replied: true, rule: 'brochure_drop', ...dropResult };
            }
        } catch (dropErr) {
            // Non-fatal: fall through to normal chatbot/AI path
            console.warn('⚠️ Brochure drop failed (non-fatal):', dropErr.message?.split('\n')[0]);
        }
    }

    // ── 1. AI-FIRST PERSONA MODE ──────
    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        const aiSystemPrompt = await getSetting(userId, 'ai_system_prompt');
        const recentHistory = await getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_persona', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Persona Mode failed (falling back to rules/default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 2. STATIC AWAY MODE ───────
    const awayMode = await getSetting(userId, 'away_mode');
    if (awayMode === 'true') {
        const awayMessage = await getSetting(userId, 'away_message');
        if (awayMessage) {
            await safeReply(client, phone, awayMessage, msg);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: awayMessage });
            return { replied: true, rule: 'away_mode', response: awayMessage };
        }
    }

    // ── 3. KEYWORD RULES ──
    const text = messageText.trim().toLowerCase();
    const rules = await getChatbotRules(userId, true);

    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;

        let response = rule.response_text;
        response = response.replace(/\{name\}/gi, contactName || 'there');
        response = response.replace(/\{phone\}/gi, phone);

        await safeReply(client, phone, response, msg);
        await logMessage(userId, { phone, contactName, direction: 'outgoing', body: response });
        await incrementRuleHitCount(userId, rule.id);

        return {
            replied: true,
            ruleId: rule.id,
            keyword: rule.trigger_keyword,
            matchType: rule.match_type,
            response
        };
    }

    // ── 4. AI Fallback (rules_first mode, nothing matched) ──
    if (aiEnabled === 'true') {
        const aiSystemPrompt = await getSetting(userId, 'ai_system_prompt');
        const recentHistory = await getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_fallback', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Fallback failed (falling back to default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 4b. Conversational appointment intent fallback if AI is disabled or unavailable ──
    const isAppointmentIntent = /\b(appointment|schedule|meeting|slot|visit|booking|book)\b/i.test(cleanText);
    if (isAppointmentIntent) {
        try {
            const { getSettings: getAvailSettings, getAvailableSlots } = require('./availability');
            const availSettings = await getAvailSettings(userId);
            if (availSettings && availSettings.bookingEnabled) {
                const { slots } = await getAvailableSlots(userId, { daysAhead: 7, maxResults: 4 });
                if (slots && slots.length) {
                    const slotOptions = slots.map((s, idx) => `${idx + 1}. ${s.label}`).join('\n');
                    const reply = `We'd love to schedule an appointment with you! 📅 Here are our upcoming available slots:\n\n${slotOptions}\n\nPlease reply with your preferred slot number or time to confirm!`;
                    await safeReply(client, phone, reply, msg, userId);
                    await logMessage(userId, { phone, contactName, direction: 'outgoing', body: reply });
                    return { replied: true, rule: 'appointment_slots_fallback', response: reply };
                }
            }
        } catch (apptErr) {
            console.warn('⚠️ Appointment intent fallback failed (non-fatal):', apptErr.message?.split('\n')[0]);
        }
    }

    // ── 5. Static Default Reply ──
    const defaultReply = await getSetting(userId, 'default_reply');
    if (defaultReply) {
        await safeReply(client, phone, defaultReply, msg);
        await logMessage(userId, { phone, contactName, direction: 'outgoing', body: defaultReply });
        return { replied: true, rule: 'default', response: defaultReply };
    }

    return { replied: false, reason: 'no_match' };
}

/** Masks the middle of a phone number for logs. 919876543210 → 9198****3210 */
function maskPhone(phone) {
    const s = String(phone || '');
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// ─── Test a message against rules without sending ───────────
async function testMessage(userId, messageText) {
    const aiEnabled = await getSetting(userId, 'ai_enabled');
    const aiMode = (await getSetting(userId, 'ai_mode')) || 'ai_first';

    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        return {
            matched: true,
            ruleId: 'ai_persona',
            keyword: 'AI Persona Mode',
            matchType: 'dynamic_ai',
            response: 'Gemini AI will dynamically generate a natural, conversational response acting as you.'
        };
    }

    const text = String(messageText).trim().toLowerCase();
    const rules = await getChatbotRules(userId, true);

    // Same matcher as the live path — see ruleMatches.
    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;
        return {
            matched: true,
            ruleId: rule.id,
            keyword: rule.trigger_keyword,
            matchType: rule.match_type,
            response: rule.response_text
        };
    }

    if (aiEnabled === 'true') {
        return {
            matched: false,
            willSendDefault: false,
            willSendAI: true,
            defaultReply: 'Gemini AI will generate a dynamic response based on your System Prompt.'
        };
    }

    const defaultReply = await getSetting(userId, 'default_reply');
    return {
        matched: false,
        willSendDefault: !!defaultReply,
        willSendAI: false,
        defaultReply: defaultReply || null
    };
}

// ─── Test helper — resets rate-limit state between test runs ─────────────
// Only exported for use in the test suite; not part of the production API.
function __resetRateLimits() {
    userRateLimits.clear();
    throttleReplySentAt.clear();
}

module.exports = {
    processMessage,
    handleIncomingMessage: processMessage,
    testMessage,
    ruleMatches,
    maskPhone,
    __resetRateLimits,
    cleanupExpiredRateLimits,
    stopChatbotCleanup,
    isRateLimited
};



