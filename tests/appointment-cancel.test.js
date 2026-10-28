/**
 * tests/appointment-cancel.test.js
 *
 * Verifies appointment cancellation requirements:
 * 1. Cancelling confirmed appointment -> status cancelled, audit recorded, pending reminders cancelled.
 * 2. Cancelling already-cancelled appointment -> idempotent 200 OK with alreadyCancelled: true.
 * 3. Tenant scoping -> other tenant's appointment returns 404.
 * 4. Failing Google Calendar event delete -> non-fatal, appointment still cancelled locally.
 * 5. Button double-click / in-flight protection.
 */
'use strict';

const request = require('supertest');

describe('Appointment Cancellation & Idempotency', () => {
    let app;
    let alice, bob;
    let db;
    let availability;
    let appointmentReminders;
    let googleCalendar;

    beforeAll(() => {
        require('../src/services/whatsapp-client').setMockAllowedForTesting(true);
    });

    afterAll(() => {
        require('../src/services/whatsapp-client').setMockAllowedForTesting(false);
    });

    beforeEach(async () => {
        db = await freshDatabase();
        app = createTestApp();
        availability = require('../src/services/availability');
        appointmentReminders = require('../src/services/appointment-reminders');
        googleCalendar = require('../src/services/google-calendar');

        alice = await signup(app, { email: `alice_${Date.now()}@cancel.test` });
        bob   = await signup(app, { email: `bob_${Date.now()}@cancel.test` });

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

    test('1. Cancelling a confirmed appointment sets status cancelled, records audit, and cancels pending reminders', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543210',
            contactName: 'Alice Client',
            startIso: slotStart.toISOString(),
            source: 'dashboard'
        });

        expect(appt).toBeDefined();
        expect(appt.status).toBe('confirmed');

        // Verify reminder rows exist and are pending
        const remindersBefore = await db.getAppointmentReminders(alice.user.id, appt.id);
        expect(remindersBefore.length).toBeGreaterThanOrEqual(1);
        const pendingBefore = remindersBefore.filter(r => r.status === 'pending');
        expect(pendingBefore.length).toBeGreaterThanOrEqual(1);

        // Cancel via API
        const res = await request(app)
            .delete(`/api/appointments/${appt.id}`)
            .set('Cookie', alice.cookie);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alreadyCancelled).toBeFalsy();

        // Check appointment in database
        const updatedAppt = await db.getAppointmentById(alice.user.id, appt.id);
        expect(updatedAppt.status).toBe('cancelled');
        expect(updatedAppt.cancelled_at).toBeDefined();
        expect(updatedAppt.cancelled_by).toBe(alice.user.email);

        // Verify all pending reminders are now cancelled
        const remindersAfter = await db.getAppointmentReminders(alice.user.id, appt.id);
        const pendingAfter = remindersAfter.filter(r => r.status === 'pending');
        expect(pendingAfter).toHaveLength(0);
        const cancelledReminders = remindersAfter.filter(r => r.status === 'cancelled');
        expect(cancelledReminders.length).toBeGreaterThanOrEqual(1);
    });

    test('2. Cancelling an already-cancelled appointment is idempotent (returns 200 with alreadyCancelled: true)', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543211',
            contactName: 'Idempotent Test',
            startIso: slotStart.toISOString(),
            source: 'dashboard'
        });

        // First cancel
        const res1 = await request(app)
            .delete(`/api/appointments/${appt.id}`)
            .set('Cookie', alice.cookie);
        expect(res1.status).toBe(200);
        expect(res1.body.success).toBe(true);

        // Second cancel
        const res2 = await request(app)
            .delete(`/api/appointments/${appt.id}`)
            .set('Cookie', alice.cookie);
        expect(res2.status).toBe(200);
        expect(res2.body.success).toBe(true);
        expect(res2.body.alreadyCancelled).toBe(true);
        expect(res2.body.message).toContain('already cancelled');
    });

    test("3. Tenant scoping: another tenant cannot cancel an appointment (returns 404)", async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543212',
            contactName: 'Alice Private',
            startIso: slotStart.toISOString(),
            source: 'dashboard'
        });

        // Bob tries to delete Alice's appointment
        const res = await request(app)
            .delete(`/api/appointments/${appt.id}`)
            .set('Cookie', bob.cookie);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);

        // Verify Alice's appointment is still confirmed
        const stillConfirmed = await db.getAppointmentById(alice.user.id, appt.id);
        expect(stillConfirmed.status).toBe('confirmed');
    });

    test('4. Google Calendar delete failure does not abort local cancellation (non-fatal, local cancel succeeds)', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543213',
            contactName: 'Calendar Failure Client',
            startIso: slotStart.toISOString(),
            source: 'dashboard'
        });

        // Attach a mock calendar_event_id
        await db.runSql("UPDATE appointments SET calendar_event_id = 'mock_cal_event_123' WHERE id = $1", [appt.id]);

        // Mock cancelAppointmentEvent to throw
        const origCancelEvent = googleCalendar.cancelAppointmentEvent;
        googleCalendar.cancelAppointmentEvent = jest.fn().mockRejectedValue(new Error('Google API 503 Service Unavailable'));

        try {
            const res = await request(app)
                .delete(`/api/appointments/${appt.id}`)
                .set('Cookie', alice.cookie);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            // Appointment must still be cancelled in DB
            const checkAppt = await db.getAppointmentById(alice.user.id, appt.id);
            expect(checkAppt.status).toBe('cancelled');

            // Reminders must still be cancelled
            const reminders = await db.getAppointmentReminders(alice.user.id, appt.id);
            const pending = reminders.filter(r => r.status === 'pending');
            expect(pending).toHaveLength(0);
        } finally {
            googleCalendar.cancelAppointmentEvent = origCancelEvent;
        }
    });

    test('5. Non-existent appointment ID returns 404', async () => {
        const res = await request(app)
            .delete('/api/appointments/999999')
            .set('Cookie', alice.cookie);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('6. Concurrent cancel requests (double submit) both resolve with 200 without 409 crash', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(alice.user.id, {
            phone: '919876543214',
            contactName: 'Concurrent Client',
            startIso: slotStart.toISOString(),
            source: 'dashboard'
        });

        const [res1, res2] = await Promise.all([
            request(app).delete(`/api/appointments/${appt.id}`).set('Cookie', alice.cookie),
            request(app).delete(`/api/appointments/${appt.id}`).set('Cookie', alice.cookie)
        ]);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res1.body.success).toBe(true);
        expect(res2.body.success).toBe(true);

        const oneCancelled = res1.body.alreadyCancelled || res2.body.alreadyCancelled;
        expect(oneCancelled).toBe(true);
    });
});
