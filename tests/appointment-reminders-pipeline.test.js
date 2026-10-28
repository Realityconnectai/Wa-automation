/**
 * tests/appointment-reminders-pipeline.test.js
 *
 * Verifies appointment reminders pipeline fixes:
 * 1. Reminder rows created on booking for dashboard and chatbot paths.
 * 2. Unique constraint / idempotency prevents duplicates on retry.
 * 3. Short notice (<24h / <2h) reminders stored as skipped_past.
 * 4. Unreachable LID without resolvable chat stored as skipped_unreachable with reason.
 * 5. Rescheduling cancels old rows and schedules new ones.
 * 6. Cancellation cancels all reminder rows.
 * 7. Scheduler worker never claims or sends cancelled or skipped rows.
 * 8. Timezone and DST boundary formatting.
 */
'use strict';

const request = require('supertest');

describe('Appointment Reminders Pipeline & Status Handling', () => {
    let app;
    let alice, bob;
    let db;
    let availability;
    let appointmentReminders;
    let scheduler;
    let whatsappClient;

    beforeAll(() => {
        whatsappClient = require('../src/services/whatsapp-client');
        whatsappClient.setMockAllowedForTesting(true);
    });

    afterAll(() => {
        whatsappClient.setMockAllowedForTesting(false);
    });

    beforeEach(async () => {
        db = await freshDatabase();
        app = createTestApp();
        availability = require('../src/services/availability');
        appointmentReminders = require('../src/services/appointment-reminders');
        scheduler = require('../src/services/scheduler');

        alice = await signup(app, { email: `alice_${Date.now()}@reminders.test` });
        bob   = await signup(app, { email: `bob_${Date.now()}@reminders.test` });

        await db.updateUser(alice.user.id, { wa_enabled: 1 });
        await db.updateUser(bob.user.id, { wa_enabled: 1 });

        const openHours = {
            workingDays: [0, 1, 2, 3, 4, 5, 6],
            startTime: '00:00',
            endTime: '23:30',
            slotDurationMinutes: 30,
            bufferMinutes: 0,
            timezone: 'Asia/Kolkata',
            bookingEnabled: true
        };
        await availability.saveSettings(alice.user.id, openHours);
        await availability.saveSettings(bob.user.id, openHours);
    });

    test('1. Reminder rows created on create for both dashboard and chatbot paths', async () => {
        const slot1 = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot1.setMinutes(0, 0, 0);

        // Dashboard path
        const dashAppt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543210',
            contactName: 'Dash Lead',
            startIso: slot1.toISOString(),
            source: 'dashboard'
        });

        const dashReminders = await db.getAppointmentReminders(alice.user.id, dashAppt.id);
        expect(dashReminders).toHaveLength(2);
        expect(dashReminders.some(r => r.reminder_type === '24h')).toBe(true);
        expect(dashReminders.some(r => r.reminder_type === '2h')).toBe(true);

        // Chatbot path
        const slot2 = new Date(Date.now() + 50 * 60 * 60 * 1000);
        slot2.setMinutes(0, 0, 0);

        const botAppt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543211',
            contactName: 'Bot Lead',
            startIso: slot2.toISOString(),
            source: 'chatbot'
        });

        const botReminders = await db.getAppointmentReminders(alice.user.id, botAppt.id);
        expect(botReminders).toHaveLength(2);
        expect(botReminders.some(r => r.reminder_type === '24h')).toBe(true);
        expect(botReminders.some(r => r.reminder_type === '2h')).toBe(true);
    });

    test('2. Unique constraint prevents duplicate reminder rows on retry', async () => {
        const slot = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543212',
            contactName: 'Retry Lead',
            startIso: slot.toISOString(),
            source: 'dashboard'
        });

        // Call scheduleAppointmentReminders a second and third time (simulating worker/hook retry)
        await appointmentReminders.scheduleAppointmentReminders(alice.user.id, appt);
        await appointmentReminders.scheduleAppointmentReminders(alice.user.id, appt);

        const reminders = await db.getAppointmentReminders(alice.user.id, appt.id);
        // Must still have exactly 2 rows (one 24h, one 2h)
        expect(reminders).toHaveLength(2);
        const r24 = reminders.filter(r => r.reminder_type === '24h');
        const r2 = reminders.filter(r => r.reminder_type === '2h');
        expect(r24).toHaveLength(1);
        expect(r2).toHaveLength(1);
    });

    test('3. Past-time reminder stored with status skipped_past', async () => {
        // Booked 5 hours in advance: 24h reminder trigger was 19 hours in the past!
        const slot = new Date(Date.now() + 5 * 60 * 60 * 1000);
        slot.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543213',
            contactName: 'Short Notice Lead',
            startIso: slot.toISOString(),
            source: 'dashboard'
        });

        const reminders = await db.getAppointmentReminders(alice.user.id, appt.id);
        expect(reminders).toHaveLength(2);

        const r24 = reminders.find(r => r.reminder_type === '24h');
        const r2 = reminders.find(r => r.reminder_type === '2h');

        expect(r24.status).toBe('skipped_past');
        expect(r24.error_message).toMatch(/time already passed/i);

        // 2h reminder is still in future (5h > 2h), so it should be pending
        expect(r2.status).toBe('pending');
    });

    test('4. Unreachable LID without resolvable chat stored with status skipped_unreachable', async () => {
        const slot = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot.setMinutes(0, 0, 0);

        // Raw 15-digit multi-device LID starting with 2 that has no WhatsApp chat or contact
        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '249344947167452',
            contactName: 'LID Client',
            startIso: slot.toISOString(),
            source: 'chatbot'
        });

        const reminders = await db.getAppointmentReminders(alice.user.id, appt.id);
        expect(reminders).toHaveLength(2);

        for (const r of reminders) {
            expect(r.status).toBe('skipped_unreachable');
            expect(r.error_message).toContain('LID identifier has no resolvable chat');
        }
    });

    test('5. Rescheduling cancels old reminder rows and creates new ones', async () => {
        const slot1 = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot1.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543215',
            contactName: 'Reschedule Lead',
            startIso: slot1.toISOString(),
            source: 'dashboard'
        });

        const slot2 = new Date(Date.now() + 72 * 60 * 60 * 1000);
        slot2.setMinutes(0, 0, 0);

        await availability.rescheduleAppointment(alice.user.id, appt.id, {
            startIso: slot2.toISOString(),
            notes: 'Postponed visit'
        });

        const allReminders = await db.queryAll(
            'SELECT * FROM scheduled_messages WHERE appointment_id = $1 ORDER BY id ASC',
            [appt.id]
        );

        // Old reminders must be cancelled
        const cancelled = allReminders.filter(r => r.status === 'cancelled');
        expect(cancelled.length).toBeGreaterThanOrEqual(2);

        // New active reminders must exist for the new time
        const pending = allReminders.filter(r => r.status === 'pending');
        expect(pending).toHaveLength(2);
    });

    test('6. Cancel cancels all reminder rows', async () => {
        const slot = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543216',
            contactName: 'Cancel Reminders Lead',
            startIso: slot.toISOString(),
            source: 'dashboard'
        });

        await availability.cancelAppointment(alice.user.id, appt.id);

        const reminders = await db.queryAll(
            'SELECT * FROM scheduled_messages WHERE appointment_id = $1',
            [appt.id]
        );
        expect(reminders.length).toBeGreaterThanOrEqual(2);
        for (const r of reminders) {
            expect(r.status).toBe('cancelled');
        }
    });

    test('7. Scheduler worker never claims or sends cancelled, skipped_past, or skipped_unreachable rows', async () => {
        const duePast = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago

        // Insert rows with various statuses
        await db.runSql(`
            INSERT INTO scheduled_messages (user_id, phone, body, scheduled_at, status, reminder_type)
            VALUES 
                ($1, '919876543217', 'Cancelled body', $2, 'cancelled', '24h'),
                ($1, '919876543217', 'Skipped past body', $2, 'skipped_past', '24h'),
                ($1, '919876543217', 'Skipped unreachable body', $2, 'skipped_unreachable', '2h'),
                ($1, '919876543217', 'Generic skipped body', $2, 'skipped', '2h')
        `, [alice.user.id, duePast]);

        const sentMessages = [];
        const originalSend = whatsappClient.sendTextMessage;
        whatsappClient.sendTextMessage = async (userId, phone, body) => {
            sentMessages.push({ userId, phone, body });
            return { id: { _serialized: `mock_wa_${Date.now()}` } };
        };

        try {
            const summary = await scheduler.processPendingMessages();
            // Worker should claim 0 and send 0
            expect(summary.claimed).toBe(0);
            expect(summary.sent).toBe(0);
            expect(sentMessages).toHaveLength(0);
        } finally {
            whatsappClient.sendTextMessage = originalSend;
        }
    });

    test('8. Timezone and DST boundary cases render correct formatted time in tenant timezone', async () => {
        // Change Alice's timezone to Europe/London (which has BST/GMT DST shifts)
        await availability.saveSettings(alice.user.id, {
            workingDays: [0, 1, 2, 3, 4, 5, 6],
            startTime: '00:00',
            endTime: '23:30',
            slotDurationMinutes: 30,
            bufferMinutes: 0,
            timezone: 'Europe/London',
            bookingEnabled: true
        });

        // Set appointment in July (BST = UTC+1) at 10:00 UTC (which is 11:00 BST)
        const summerDate = new Date('2027-07-15T10:00:00.000Z');
        const appt = await db.queryGet(`
            INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
            VALUES ($1, '919876543218', 'Summer Visit', $2, $3, 'confirmed', 'dashboard')
            RETURNING *
        `, [alice.user.id, summerDate, new Date(summerDate.getTime() + 30 * 60 * 1000)]);

        const reminders = await appointmentReminders.scheduleAppointmentReminders(alice.user.id, appt, {
            now: new Date('2027-07-10T10:00:00.000Z')
        });

        expect(reminders).toHaveLength(2);
        // In London BST, 10:00 UTC is 11:00 AM
        expect(reminders[0].body).toContain('11:00');
        expect(reminders[1].body).toContain('11:00');
    });
});
