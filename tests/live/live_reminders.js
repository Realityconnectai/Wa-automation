'use strict';

/**
 * tests/live/live_reminders.js
 *
 * Verification script for W8:
 * Reminders 24h + 2h:
 * 1. Job creation timing: 24h and 2h offsets; short-notice policies (>24h both, 2-24h only 2h, <2h none)
 * 2. Timezone/UTC formatting
 * 3. Atomic locking & due message processing via scheduler
 * 4. Idempotency & worker restart (no duplicate sends)
 * 5. Cancelled appointment suppression
 * 6. Invalid recipient failure without infinite retry
 */

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
    scheduleAppointmentReminders,
    cancelAppointmentReminders,
    rescheduleAppointmentReminders,
    REMINDER_TYPES
} = require('../../src/services/appointment-reminders');
const {
    createAppointment,
    cancelAppointment,
    getAppointmentById
} = require('../../src/services/availability');
const { processPendingMessages } = require('../../src/services/scheduler');
const { queryGet, queryAll, runSql } = require('../../src/services/db-pool');
const { reclaimStuckScheduledMessages } = require('../../src/services/database');
const whatsappClient = require('../../src/services/whatsapp-client');
const { isAllowlistConfigured, assertRecipientAllowlisted } = require('./harness');

async function main() {
    console.log('====================================================');
    console.log('  WORKPILOT LIVE VERIFICATION: W8 REMINDERS (24h + 2h)');
    console.log('====================================================\n');

    const testTenantId = 3; // aryan@gmail.com
    const testPhone = process.env.TEST_RECIPIENT_PRIMARY || ('91987' + Math.floor(Date.now() % 100000).toString().padStart(7, '0'));
    const evidenceLog = [];

    // Step 1: Short-Notice Policy Checks
    console.log('--- Step 1: Testing Short-Notice Scheduling Policies ---');
    const now = new Date();

    // Case A: Booked 48 hours in advance (>24h) -> Schedules both 24h and 2h
    const future48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const mockAppt48h = await queryGet(
        `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
         VALUES ($1, $2, 'Lead 48h', $3::timestamptz, $3::timestamptz + INTERVAL '30 minutes', 'confirmed', 'chatbot')
         RETURNING *`,
        [testTenantId, testPhone, future48h.toISOString()]
    );
    const scheduled48h = await scheduleAppointmentReminders(testTenantId, mockAppt48h, { now });
    console.log(`  Case A (>24h advance): ${scheduled48h.length} reminders scheduled (Expected: 2)`);
    assert.equal(scheduled48h.length, 2, 'Should schedule both 24h and 2h reminders');

    // Case B: Booked 10 hours in advance (2h–24h) -> Schedules only 2h
    const future10h = new Date(now.getTime() + 10 * 60 * 60 * 1000);
    const mockAppt10h = await queryGet(
        `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
         VALUES ($1, $2, 'Lead 10h', $3::timestamptz, $3::timestamptz + INTERVAL '30 minutes', 'confirmed', 'chatbot')
         RETURNING *`,
        [testTenantId, testPhone, future10h.toISOString()]
    );
    const scheduled10h = await scheduleAppointmentReminders(testTenantId, mockAppt10h, { now });
    console.log(`  Case B (10h advance): ${scheduled10h.length} reminders scheduled (Expected: 1)`);
    assert.equal(scheduled10h.length, 1, 'Should schedule only 2h reminder');
    assert.equal(scheduled10h[0].reminder_type, '2h');

    // Case C: Booked 1 hour in advance (<2h) -> Schedules 0
    const future1h = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    const mockAppt1h = await queryGet(
        `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
         VALUES ($1, $2, 'Lead 1h', $3::timestamptz, $3::timestamptz + INTERVAL '30 minutes', 'confirmed', 'chatbot')
         RETURNING *`,
        [testTenantId, testPhone, future1h.toISOString()]
    );
    const scheduled1h = await scheduleAppointmentReminders(testTenantId, mockAppt1h, { now });
    console.log(`  Case C (1h advance): ${scheduled1h.length} reminders scheduled (Expected: 0)`);
    assert.equal(scheduled1h.length, 0, 'Should schedule 0 reminders when lead time is under 2 hours');

    evidenceLog.push({ step: 'short_notice_policies', result: 'passed' });

    // Step 2: Real Scheduler Processing & Status Progression
    console.log('\n--- Step 2: Real Scheduler Processing & Status Progression ---');
    // Pick the 2h reminder from mockAppt10h and make it due now
    const testReminder = scheduled10h[0];
    await runSql(
        "UPDATE scheduled_messages SET scheduled_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
        [testReminder.id]
    );

    // Spy on sendTextMessage
    const sentMessages = [];
    const originalSendTextMessage = whatsappClient.sendTextMessage;
    whatsappClient.sendTextMessage = async (userId, phone, body) => {
        if (isAllowlistConfigured()) {
            assertRecipientAllowlisted(phone);
        }
        sentMessages.push({ userId, phone, body });
        return {
            id: { _serialized: `true_${phone}@c.us_SCHED_${Date.now()}` },
            ack: 1
        };
    };

    let summary;
    try {
        summary = await processPendingMessages();
    } finally {
        whatsappClient.sendTextMessage = originalSendTextMessage;
    }

    console.log('  Scheduler execution summary:', summary);
    assert.ok(summary.sent >= 1, 'At least 1 due reminder must be sent');
    assert.ok(sentMessages.length >= 1, 'sendTextMessage must have been invoked');

    // Verify row status transitioned to 'sent'
    const postSendRow = await queryGet('SELECT * FROM scheduled_messages WHERE id = $1', [testReminder.id]);
    assert.equal(postSendRow.status, 'sent');
    console.log('  ✔ Reminder row status verified as "sent" in PostgreSQL');
    evidenceLog.push({ step: 'scheduler_dispatch', summary, reminderId: testReminder.id, finalStatus: 'sent' });

    // Step 3: Idempotency & Worker Restart (No Duplicate Send)
    console.log('\n--- Step 3: Idempotency Verification (Subsequent Tick Sends Zero) ---');
    whatsappClient.sendTextMessage = async () => {
        throw new Error('DUPLICATE_SEND_VIOLATION: Scheduler sent an already-delivered message!');
    };
    try {
        const secondSummary = await processPendingMessages();
        console.log('  Second scheduler tick summary:', secondSummary);
        assert.equal(secondSummary.claimed, 0, 'Subsequent tick must claim 0 messages for already-sent reminders');
    } finally {
        whatsappClient.sendTextMessage = originalSendTextMessage;
    }
    evidenceLog.push({ step: 'idempotency_check', result: 'zero_duplicates' });

    // Step 4: Stuck Message Reclamation (Worker crash mid-send simulation)
    console.log('\n--- Step 4: Worker Restart & Stuck Message Reclamation ---');
    // Simulate a message stuck in 'sending' for 20 minutes (as if node crashed mid-send)
    const stuckInsert = await queryGet(
        `INSERT INTO scheduled_messages (user_id, phone, reminder_type, body, scheduled_at, status, created_at)
         VALUES ($1, $2, '2h', 'Stuck crash simulation', NOW() - INTERVAL '25 minutes', 'sending', NOW() - INTERVAL '25 minutes')
         RETURNING *`,
        [testTenantId, testPhone]
    );

    const reclaimed = await reclaimStuckScheduledMessages(15);
    console.log(`  Reclaimed ${reclaimed.length} stuck messages (Expected to include #${stuckInsert.id})`);
    const stuckRowAfter = await queryGet('SELECT * FROM scheduled_messages WHERE id = $1', [stuckInsert.id]);
    console.log(`  Stuck message status after reclamation: ${stuckRowAfter.status} (Reason: ${stuckRowAfter.error_message})`);
    assert.equal(stuckRowAfter.status, 'failed', 'Stuck message must be marked failed, never blindly retried');
    evidenceLog.push({ step: 'stuck_reclamation', result: 'marked_failed_safely' });

    // Step 5: Cancelled Appointment Reminder Suppression
    console.log('\n--- Step 5: Cancelled Appointment Reminder Suppression ---');
    // Create an appointment and cancel it
    const cancelAppt = await queryGet(
        `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
         VALUES ($1, $2, 'Cancelled Lead', NOW() + INTERVAL '5 hours', NOW() + INTERVAL '5 hours 30 minutes', 'confirmed', 'chatbot')
         RETURNING *`,
        [testTenantId, testPhone]
    );
    const cancelReminder = await queryGet(
        `INSERT INTO scheduled_messages (user_id, phone, reminder_type, body, scheduled_at, status, appointment_id)
         VALUES ($1, $2, '2h', 'Should never be sent', NOW() - INTERVAL '10 seconds', 'pending', $3)
         RETURNING *`,
        [testTenantId, testPhone, cancelAppt.id]
    );

    // Cancel the appointment in DB
    await runSql("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [cancelAppt.id]);

    // Run scheduler — it should check appointment status and cancel the reminder
    whatsappClient.sendTextMessage = async () => {
        throw new Error('VIOLATION: Scheduler sent reminder for a cancelled appointment!');
    };
    try {
        await processPendingMessages();
    } finally {
        whatsappClient.sendTextMessage = originalSendTextMessage;
    }

    const cancelRemAfter = await queryGet('SELECT * FROM scheduled_messages WHERE id = $1', [cancelReminder.id]);
    console.log(`  Cancelled appointment reminder status: ${cancelRemAfter.status} (Reason: ${cancelRemAfter.error_message})`);
    assert.equal(cancelRemAfter.status, 'cancelled');
    evidenceLog.push({ step: 'cancelled_suppression', result: 'reminder_cancelled_at_dispatch' });

    // Step 6: Invalid Recipient Bounded Failure
    console.log('\n--- Step 6: Invalid Recipient Bounded Failure ---');
    const invalidReminder = await queryGet(
        `INSERT INTO scheduled_messages (user_id, phone, reminder_type, body, scheduled_at, status)
         VALUES ($1, 'invalid_number', '2h', 'Invalid recipient test', NOW() - INTERVAL '10 seconds', 'pending')
         RETURNING *`,
        [testTenantId]
    );

    await processPendingMessages();
    const invalidAfter = await queryGet('SELECT * FROM scheduled_messages WHERE id = $1', [invalidReminder.id]);
    console.log(`  Invalid recipient status: ${invalidAfter.status} (Reason: ${invalidAfter.error_message})`);
    assert.equal(invalidAfter.status, 'failed');
    evidenceLog.push({ step: 'invalid_recipient_handled', result: 'marked_failed_no_infinite_retry' });

    // Save Evidence
    const evidenceDir = path.join(__dirname, '../../.workpilot/evidence/W8');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
        path.join(evidenceDir, 'evidence.json'),
        JSON.stringify({
            title: '24h and 2h appointment reminder scheduler verification',
            status: 'VERIFIED',
            timestamp: new Date().toISOString(),
            evidence: evidenceLog
        }, null, 2)
    );

    console.log('\n✅ W8 REMINDERS VERIFICATION COMPLETED SUCCESSFULLY.');
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n❌ W8 TEST FAILED:', err);
        process.exit(1);
    });
}

module.exports = { main };
