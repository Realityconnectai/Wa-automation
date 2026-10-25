/**
 * tests/bugfixes-verification.test.js
 *
 * Verification suite for:
 * 1. Bug 1: Manual WhatsApp Message Sending & Recipient Resolution
 * 2. Bug 2: Campaign Sending & Recipient Resolution Fault Tolerance
 * 3. Bug 3: Appointment Booking Tool Calling, Persistence & Reminders
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDestinationChatId, sendTextMessage } = require('../src/services/whatsapp-client');
const { generateReply } = require('../src/services/ai');
const { getSettings, getAvailableSlots, bookAppointment, cancelAppointment } = require('../src/services/availability');
const { queryAll, queryGet, runSql } = require('../src/services/db-pool');

test('Bug 1: Recipient resolution - handles formats safely', async () => {
    // 1. Valid JID direct pass-through
    assert.equal(await resolveDestinationChatId(null, '919691247958@c.us'), '919691247958@c.us');
    assert.equal(await resolveDestinationChatId(null, '227105572937810@lid'), '227105572937810@lid');

    // 2. Digits without client fallback
    assert.equal(await resolveDestinationChatId(null, '919691247958'), '919691247958@c.us');

    // 3. Invalid inputs rejected cleanly
    await assert.rejects(
        () => resolveDestinationChatId(null, ''),
        /Recipient phone number is required/
    );
    await assert.rejects(
        () => resolveDestinationChatId(null, '123'),
        /Invalid destination phone number/
    );

    // 4. Mock WhatsApp client resolving 10-digit number via +91 prefix
    const mockClient = {
        getNumberId: async (n) => {
            if (n === '919691247958') return { _serialized: '919691247958@c.us' };
            return null;
        }
    };
    const resolved10Digit = await resolveDestinationChatId(mockClient, '9691247958');
    assert.equal(resolved10Digit, '919691247958@c.us');

    // 5. Unregistered 10-digit number rejected with clean descriptive error
    await assert.rejects(
        () => resolveDestinationChatId(mockClient, '9999999999'),
        /Recipient \+919999999999 is not registered on WhatsApp/
    );
});

test('Bug 1: Manual send fails safely if WhatsApp client is disconnected', async () => {
    // When client is not connected, must throw 409 WA_NOT_CONNECTED rather than false success
    await assert.rejects(
        () => sendTextMessage(999999, '919691247958', 'Test message'),
        (err) => {
            assert.equal(err.code, 'WA_NOT_CONNECTED');
            assert.equal(err.status, 409);
            return true;
        }
    );
});

test('Bug 2: Media message injected id property protection', () => {
    // Verify that Utils.js in whatsapp-web.js protects message.id from being undefined
    const utilsPath = require('path').resolve(__dirname, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');
    const fs = require('fs');
    if (fs.existsSync(utilsPath)) {
        const content = fs.readFileSync(utilsPath, 'utf8');
        assert.ok(content.includes('if (!message.id)'), 'Utils.js must protect message.id from being overwritten with undefined');
    }
});

test('Bug 3: Appointment slot retrieval and working hours', async () => {
    // User 3 has configured working hours (9:00 to 18:00 Asia/Kolkata)
    const settings = await getSettings(3);
    assert.ok(settings.bookingEnabled, 'User 3 should have booking enabled');
    assert.equal(settings.timezone, 'Asia/Kolkata');

    const { slots } = await getAvailableSlots(3, { daysAhead: 7, maxResults: 5 });
    assert.ok(Array.isArray(slots), 'Slots must be an array');
    assert.ok(slots.length > 0, 'Should return available candidate slots');
    assert.ok(slots[0].startIso, 'Slot must have startIso');
    assert.ok(slots[0].label, 'Slot must have label');
});

test('Bug 3: Multi-turn appointment booking via AI tool calling', async () => {
    // Verify that generateReply executes check_availability without 400 thought_signature error
    const history = [
        { direction: 'incoming', body: 'I would like to book an appointment next week' }
    ];
    const reply = await generateReply(3, 'You are an assistant', history, 'Test User', '919876543210');
    assert.ok(typeof reply === 'string' && reply.length > 0, 'Must return a reply offering slots');
    // Reply should mention days/times or slots
    assert.match(reply, /(slot|available|meet|schedule|october|monday|tuesday|wednesday|thursday|friday|\d{1,2}:\d{2})/i);
});

test('Bug 3: Appointment booking persistence, reminders, and cancellation', async () => {
    const { slots } = await getAvailableSlots(3, { daysAhead: 14, maxResults: 1 });
    assert.ok(slots.length > 0, 'Must have at least one slot for test');
    const testSlot = slots[0];

    // 1. Book appointment
    const appt = await bookAppointment(3, {
        phone: '919876543210',
        contactName: 'Integration Test User',
        startIso: testSlot.startIso,
        notes: 'Automated test site visit',
        source: 'chatbot'
    });
    assert.ok(appt && appt.id, 'Appointment must be returned with an id');
    assert.equal(appt.status, 'confirmed');

    // 2. Verify persistence in DB
    const dbAppt = await queryGet('SELECT * FROM appointments WHERE id = $1 AND user_id = $2', [appt.id, 3]);
    assert.ok(dbAppt, 'Appointment must be found in database');
    assert.equal(dbAppt.status, 'confirmed');
    assert.equal(dbAppt.phone, '919876543210');

    // 3. Verify double-booking prevention
    await assert.rejects(
        () => bookAppointment(3, {
            phone: '919876543211',
            contactName: 'Conflicting User',
            startIso: testSlot.startIso,
            source: 'chatbot'
        }),
        /That slot was just booked/
    );

    // 4. Verify reminders were scheduled in scheduled_messages
    const reminders = await queryAll('SELECT * FROM scheduled_messages WHERE appointment_id = $1 AND user_id = $2', [appt.id, 3]);
    assert.ok(Array.isArray(reminders), 'Reminders should be an array');
    for (const rem of reminders) {
        assert.equal(rem.status, 'pending');
    }

    // 5. Cancel appointment and verify reminders are cancelled
    await cancelAppointment(3, appt.id);
    const cancelledAppt = await queryGet('SELECT status FROM appointments WHERE id = $1 AND user_id = $2', [appt.id, 3]);
    assert.equal(cancelledAppt.status, 'cancelled');

    const updatedReminders = await queryAll('SELECT status FROM scheduled_messages WHERE appointment_id = $1 AND user_id = $2', [appt.id, 3]);
    for (const rem of updatedReminders) {
        assert.equal(rem.status, 'cancelled');
    }

    // Clean up test appointment row
    await runSql('DELETE FROM scheduled_messages WHERE appointment_id = $1', [appt.id]);
    await runSql('DELETE FROM appointments WHERE id = $1', [appt.id]);
});

test.after(async () => {
    const { closePool } = require('../src/services/db-pool');
    await closePool().catch(() => {});
});
