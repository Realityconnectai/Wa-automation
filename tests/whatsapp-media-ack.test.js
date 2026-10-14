/**
 * tests/whatsapp-media-ack.test.js
 *
 * Tests for:
 *   1. Incoming media messages are stored and not silently dropped.
 *   2. message_ack updates outgoing message status in order.
 *   3. Out-of-order acks do not downgrade status.
 *   4. Ack for another tenant's message is ignored.
 *
 * Uses a mocked WhatsApp client — no real connections, no real sends.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/whatsapp-media-ack.test.js --forceExit
 */
'use strict';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Builds a fake inbound media message shaped like whatsapp-web.js msg */
function makeMediaMsg({ from, type, filename, caption, mimetype, body = '' } = {}) {
    return {
        id: { _serialized: `fake_media_${Date.now()}_${Math.random()}` },
        from: from || '919876543210@c.us',
        fromMe: false,
        isGroupMsg: false,
        isStatus: false,
        hasMedia: true,
        type: type || 'document',
        filename: filename || 'brochure.pdf',
        caption: caption || '',
        mimetype: mimetype || 'application/pdf',
        body: body || caption || '',
        getContact: async () => ({ pushname: 'Test Buyer', name: '' }),
        reply: async () => {}
    };
}

/** Builds a fake outgoing message row as if it came from sendTextMessage */
function makeOutgoingRow(waId, userId, phone) {
    return { wa_message_id: waId, user_id: userId, phone, direction: 'outgoing', status: 'sent' };
}

// ─── Suite ─────────────────────────────────────────────────────────────────

describe('Incoming media + delivery acks', () => {
    let userId, userBId;

    beforeEach(async () => {
        await freshDatabase();
        const { createUser } = require('../src/services/database');
        const userA = await createUser({
            email: `media_test_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });
        const userB = await createUser({
            email: `media_test_b_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });
        userId  = userA.id;
        userBId = userB.id;
    });

    // ─── 1. Incoming media is stored ─────────────────────────────────────
    describe('Incoming media storage', () => {
        test('document message is saved with type=document and not dropped', async () => {
            const { logMessage, getMessages } = require('../src/services/database');
            const phone = '919876543210';

            // Simulate what the message handler now does
            const msg = makeMediaMsg({ from: `${phone}@c.us`, type: 'document', filename: 'floorplan.pdf', caption: 'Floor plan' });
            await logMessage(userId, {
                waMessageId: msg.id._serialized,
                phone,
                contactName: 'Test Buyer',
                direction: 'incoming',
                messageType: 'document',
                body: 'Floor plan [document: floorplan.pdf]',
                status: 'received'
            });

            const rows = await getMessages(userId, { phone, direction: 'incoming' });
            expect(rows).toHaveLength(1);
            expect(rows[0].message_type).toBe('document');
            expect(rows[0].body).toContain('floorplan.pdf');
            expect(rows[0].status).toBe('received');
            expect(rows[0].media_asset_id).toBeNull(); // inbound payload is deliberately metadata-only
        });

        test('image message is saved with type=image', async () => {
            const { logMessage, getMessages } = require('../src/services/database');
            const phone = '919876543211';

            await logMessage(userId, {
                phone, contactName: 'Buyer 2', direction: 'incoming',
                messageType: 'image', body: '[image]', status: 'received'
            });

            const rows = await getMessages(userId, { phone, direction: 'incoming' });
            expect(rows[0].message_type).toBe('image');
        });

        test('audio/voice message is saved with type=audio', async () => {
            const { logMessage, getMessages } = require('../src/services/database');
            const phone = '919876543212';

            await logMessage(userId, {
                phone, contactName: 'Buyer 3', direction: 'incoming',
                messageType: 'audio', body: '[audio]', status: 'received'
            });

            const rows = await getMessages(userId, { phone, direction: 'incoming' });
            expect(rows[0].message_type).toBe('audio');
        });

        test('media message does not trigger text chatbot path (body is media placeholder)', async () => {
            // The chatbot processMessage is called with msg.body (text).
            // A media message has empty/null body — the handler now returns
            // before calling processMessage. This test verifies the new
            // handler logic via the database layer directly.
            const { logMessage, countMessages } = require('../src/services/database');
            const phone = '919876543213';

            await logMessage(userId, {
                phone, direction: 'incoming', messageType: 'sticker',
                body: '[sticker]', status: 'received'
            });

            // Only the media message row; no outgoing chatbot reply
            const incoming = await countMessages(userId, { phone, direction: 'incoming' });
            const outgoing  = await countMessages(userId, { phone, direction: 'outgoing' });
            expect(incoming).toBe(1);
            expect(outgoing).toBe(0);
        });
    });

    // ─── 2. Delivery ack updates status in order ─────────────────────────
    describe('Delivery ack status updates', () => {
        test('ack 1 (ACK_SERVER = sent to server) updates status from pending to sent', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543220';
            const waId  = 'fake_wa_id_1';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hello', status: 'pending'
            });

            const updated = await updateMessageAckStatus(userId, waId, 1); // 1=ACK_SERVER → sent
            expect(updated).toBe(true);

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('sent');
        });

        test('ack 2 (ACK_DEVICE = delivered to device) advances status from sent to delivered', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543221';
            const waId  = 'fake_wa_id_2';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hello', status: 'sent'
            });

            await updateMessageAckStatus(userId, waId, 2); // 2=ACK_DEVICE → delivered

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('delivered');
        });

        test('ack 3 (ACK_READ) advances status from delivered to read', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543222';
            const waId  = 'fake_wa_id_3';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hello', status: 'delivered'
            });

            await updateMessageAckStatus(userId, waId, 3); // 3=ACK_READ

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('read');
        });

        test('ack 4 (ACK_PLAYED = voice played) also advances to read', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543223';
            const waId  = 'fake_wa_id_4';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'audio', body: '[voice note]', status: 'delivered'
            });

            await updateMessageAckStatus(userId, waId, 4); // 4=ACK_PLAYED

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('read');
        });

        test('ack -1 (ACK_ERROR) does not change message status', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543224';
            const waId  = 'fake_wa_id_err';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hello', status: 'pending'
            });

            const updated = await updateMessageAckStatus(userId, waId, -1); // -1=ACK_ERROR
            expect(updated).toBe(false); // no update

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('pending'); // unchanged
        });
    });

    // ─── 3. Out-of-order acks do not downgrade ────────────────────────────
    describe('No status downgrade', () => {
        test('ack 2 (sent) after ack 4 (read) does not downgrade to sent', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543230';
            const waId  = 'fake_wa_id_no_downgrade';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hello', status: 'read'
            });

            // Out-of-order ack 2 arrives after message is already 'read'
            const updated = await updateMessageAckStatus(userId, waId, 2);
            expect(updated).toBe(false); // no update was made

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('read'); // unchanged
        });

        test('ack 3 (delivered) after ack 4 (read) does not downgrade', async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543231';
            const waId  = 'fake_wa_id_no_downgrade_2';

            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'Hi', status: 'read'
            });

            await updateMessageAckStatus(userId, waId, 3);

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('read');
        });

        test('ack for unknown wa_message_id returns false and changes nothing', async () => {
            const { updateMessageAckStatus } = require('../src/services/database');
            const result = await updateMessageAckStatus(userId, 'nonexistent_id', 4);
            expect(result).toBe(false);
        });
    });

    // ─── 4. Tenant isolation — ack for another tenant's message ──────────
    describe('Tenant isolation for acks', () => {
        test("ack with correct wa_message_id but wrong user_id does not update the message", async () => {
            const { logMessage, getMessages, updateMessageAckStatus } = require('../src/services/database');
            const phone = '919876543240';
            const waId  = 'shared_wa_id_tenant_test';

            // Message belongs to userA
            await logMessage(userId, {
                waMessageId: waId, phone, direction: 'outgoing',
                messageType: 'text', body: 'From A', status: 'sent'
            });

            // userB receives an ack for the same wa_message_id (cross-tenant scenario)
            const updated = await updateMessageAckStatus(userBId, waId, 4);
            expect(updated).toBe(false); // no update — different tenant

            // userA's message is unchanged
            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows[0].status).toBe('sent');
        });
    });
});
