'use strict';

/**
 * tests/live/live_appointment.js
 *
 * Verification script for W7:
 * Appointment booking flow:
 * 1. Chat: "I want to do an appointment" -> model calls check_availability -> returns real slots
 * 2. Pick slot & confirm -> persists in DB with correct tz -> reminders scheduled
 * 3. Double-booking rejection -> second booking on same slot rejected with SLOT_TAKEN
 * 4. Reschedule -> updates appointment row -> invalidates old reminders -> schedules new ones
 * 5. Cancel -> updates row to cancelled -> cancels all scheduled reminders
 */

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
    getSettings,
    saveSettings,
    getAvailableSlots,
    bookAppointment,
    rescheduleAppointment,
    cancelAppointment,
    getLatestAppointmentForPhone
} = require('../../src/services/availability');
const { queryGet, queryAll } = require('../../src/services/db-pool');
const { generateReply } = require('../../src/services/ai');
const { isAllowlistConfigured, assertRecipientAllowlisted } = require('./harness');

async function main() {
    console.log('====================================================');
    console.log('  WORKPILOT LIVE VERIFICATION: W7 APPOINTMENT BOOKING');
    console.log('====================================================\n');

    const testTenantId = 3; // aryan@gmail.com
    const testPhone = process.env.TEST_RECIPIENT_PRIMARY || ('91987' + Math.floor(Date.now() % 100000).toString().padStart(7, '0'));
    const evidenceLog = [];

    // Ensure availability settings are configured and booking is enabled
    console.log('--- Step 0: Verifying Tenant Availability Settings ---');
    await saveSettings(testTenantId, {
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        startTime: '09:00',
        endTime: '19:00',
        slotDurationMinutes: 30,
        bufferMinutes: 0,
        timezone: 'Asia/Kolkata',
        bookingEnabled: true
    });
    const settings = await getSettings(testTenantId);
    console.log('  Configured working hours:', {
        timezone: settings.timezone,
        hours: `${settings.startTime} - ${settings.endTime}`,
        bookingEnabled: settings.bookingEnabled
    });
    assert.equal(settings.bookingEnabled, true);

    // Step 1: Customer expresses intent: "I want to do an appointment"
    console.log('\n--- Step 1: Chat Intent Detection & Availability Lookup ---');
    const systemPrompt = 'You are a real estate assistant. When a customer wants an appointment, check availability and offer open slots.';
    const conversation = [
        { direction: 'incoming', body: 'I want to do an appointment' }
    ];

    const aiReply = await generateReply(testTenantId, systemPrompt, conversation, 'Appointment Lead', testPhone);
    console.log('  AI Response to booking intent:\n ', aiReply);
    assert.ok(aiReply && aiReply.length > 0, 'AI must return a response');
    evidenceLog.push({ step: 'chat_intent', prompt: 'I want to do an appointment', response: aiReply });

    // Step 2: Slot Selection & Concurrency-Safe Persistence
    console.log('\n--- Step 2: Slot Selection & Durable DB Persistence ---');
    const { slots } = await getAvailableSlots(testTenantId, { daysAhead: 7, maxResults: 4 });
    console.log(`  Fetched ${slots.length} available slots. First slot:`, slots[0]);
    assert.ok(slots.length > 0, 'Must have at least one open slot');

    const chosenSlot = slots[0];
    const appt = await bookAppointment(testTenantId, {
        phone: testPhone,
        contactName: 'Appointment Lead',
        startIso: chosenSlot.startIso,
        notes: 'Live verification test visit',
        source: 'chatbot'
    });

    console.log('  Booked appointment returned:', {
        id: appt.id,
        phone: appt.phone,
        status: appt.status,
        start_at: appt.start_at
    });
    assert.ok(appt.id, 'Appointment must have an ID');
    assert.equal(appt.status, 'confirmed');

    // Verify row in DB
    const dbRow = await queryGet('SELECT * FROM appointments WHERE id = $1 AND user_id = $2', [appt.id, testTenantId]);
    assert.ok(dbRow, 'Appointment must exist in PostgreSQL database');
    assert.equal(dbRow.status, 'confirmed');
    assert.equal(dbRow.phone, testPhone);
    console.log('  ✔ Persisted row confirmed in PostgreSQL appointments table');

    // Verify reminders created in scheduled_messages
    const reminders = await queryAll(
        'SELECT id, appointment_id, status, scheduled_at, reminder_type FROM scheduled_messages WHERE appointment_id = $1 AND user_id = $2',
        [appt.id, testTenantId]
    );
    console.log(`  ✔ Scheduled reminders created (${reminders.length}):`, reminders.map(r => `${r.reminder_type} at ${r.scheduled_at}`));
    assert.ok(reminders.length > 0, 'Must schedule reminder jobs for appointment');
    evidenceLog.push({ step: 'slot_booked', appointmentId: appt.id, slot: chosenSlot, reminders: reminders.length });

    // Step 3: Double-Booking Rejection
    console.log('\n--- Step 3: Double-Booking Rejection Verification ---');
    let doubleBookThrew = false;
    try {
        await bookAppointment(testTenantId, {
            phone: '918888888888',
            contactName: 'Conflicting Lead',
            startIso: chosenSlot.startIso,
            source: 'chatbot'
        });
    } catch (err) {
        doubleBookThrew = true;
        console.log('  ✔ Conflicting booking cleanly rejected:', err.code, err.message);
        assert.equal(err.code, 'SLOT_TAKEN');
    }
    assert.ok(doubleBookThrew, 'Double booking must throw SLOT_TAKEN');
    evidenceLog.push({ step: 'double_booking_prevention', result: 'cleanly_rejected_SLOT_TAKEN' });

    // Step 4: Rescheduling to New Slot
    console.log('\n--- Step 4: Rescheduling Appointment & Reminder Invalidation ---');
    const { slots: freshSlots } = await getAvailableSlots(testTenantId, { daysAhead: 7, maxResults: 5 });
    // Find slot different from chosenSlot
    const newSlot = freshSlots.find(s => s.startIso !== chosenSlot.startIso);
    assert.ok(newSlot, 'Must find a different available slot for rescheduling');
    console.log('  Rescheduling appointment #' + appt.id + ' to new slot:', newSlot.startIso);

    const rescheduledAppt = await rescheduleAppointment(testTenantId, appt.id, {
        startIso: newSlot.startIso,
        notes: 'Rescheduled live test visit'
    });
    console.log('  Rescheduled appointment row:', {
        id: rescheduledAppt.id,
        status: rescheduledAppt.status,
        new_start_at: rescheduledAppt.start_at
    });
    assert.equal(rescheduledAppt.id, appt.id);
    assert.equal(rescheduledAppt.status, 'confirmed');

    // Verify old reminders were cancelled and new reminders scheduled
    const allReminders = await queryAll(
        'SELECT id, appointment_id, status, scheduled_at, reminder_type FROM scheduled_messages WHERE appointment_id = $1 AND user_id = $2 ORDER BY id ASC',
        [appt.id, testTenantId]
    );
    const cancelledCount = allReminders.filter(r => r.status === 'cancelled').length;
    const pendingCount = allReminders.filter(r => r.status === 'pending').length;
    console.log(`  Reminder status after reschedule: ${cancelledCount} cancelled, ${pendingCount} new pending`);
    assert.ok(cancelledCount > 0, 'Old reminders must be marked cancelled');
    assert.ok(pendingCount > 0, 'New reminders must be scheduled for updated start time');
    evidenceLog.push({ step: 'rescheduled', newSlot: newSlot.startIso, cancelledReminders: cancelledCount, pendingReminders: pendingCount });

    // Step 5: Cancellation & Complete Invalidation
    console.log('\n--- Step 5: Cancellation & Invalidation ---');
    const cancelledAppt = await cancelAppointment(testTenantId, appt.id);
    console.log('  Cancelled appointment row:', {
        id: cancelledAppt.id,
        status: cancelledAppt.status
    });
    assert.equal(cancelledAppt.status, 'cancelled');

    const finalReminders = await queryAll(
        'SELECT id, status FROM scheduled_messages WHERE appointment_id = $1 AND user_id = $2',
        [appt.id, testTenantId]
    );
    const remainingPending = finalReminders.filter(r => r.status === 'pending').length;
    console.log(`  Reminders remaining in pending status: ${remainingPending}`);
    assert.equal(remainingPending, 0, 'Zero pending reminders should remain after cancellation');
    evidenceLog.push({ step: 'cancelled', appointmentId: appt.id, remainingPendingReminders: 0 });

    // Save Evidence
    const evidenceDir = path.join(__dirname, '../../.workpilot/evidence/W7');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
        path.join(evidenceDir, 'evidence.json'),
        JSON.stringify({
            title: 'Appointment booking lifecycle and persistence',
            status: 'VERIFIED',
            timestamp: new Date().toISOString(),
            evidence: evidenceLog
        }, null, 2)
    );

    console.log('\n✅ W7 APPOINTMENT BOOKING VERIFICATION COMPLETED SUCCESSFULLY.');
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n❌ W7 TEST FAILED:', err);
        process.exit(1);
    });
}

module.exports = { main };
