/**
 * tests/appointment-reminders.test.js
 *
 * Verifies 24-hour and 2-hour site visit appointment reminders:
 * 1. Automatic scheduling on booking (24h and 2h jobs created in scheduled_messages).
 * 2. Lead-time thresholds: <24h skips 24h, <2h skips both.
 * 3. Property & location enrichment (project name, address, map_url, notes).
 * 4. Custom template support from tenant settings.
 * 5. Idempotency & duplicate prevention (database unique constraint).
 * 6. Cancellation: cancelling appointment immediately cancels pending reminders.
 * 7. Rescheduling: old reminders cancelled, new reminders created.
 * 8. Scheduler execution: due reminders sent through existing messaging pipeline,
 *    and cancelled appointments are safely skipped by scheduler.
 * 9. Tenant isolation.
 * 10. Timezone formatting in tenant's configured timezone.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/appointment-reminders.test.js --forceExit
 */
'use strict';

describe('Site Visit Appointment Reminders (24h and 2h notifications)', () => {
    let db;
    let userA, userB;
    let appointmentReminders;
    let availability;
    let scheduler;

    beforeEach(async () => {
        db = await freshDatabase();
        appointmentReminders = require('../src/services/appointment-reminders');
        availability = require('../src/services/availability');
        scheduler = require('../src/services/scheduler');

        userA = await db.createUser({
            email: `rem_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            businessName: 'Apex Realty',
            ownerName: 'Alice Agent',
            status: 'active'
        });
        await db.updateUser(userA.id, { wa_enabled: 1 });

        userB = await db.createUser({
            email: `rem_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            businessName: 'Beacon Properties',
            ownerName: 'Bob Broker',
            status: 'active'
        });
        await db.updateUser(userB.id, { wa_enabled: 1 });

        // Set wide open working hours so any slot is valid for availability.bookAppointment
        const openHours = {
            workingDays: [0, 1, 2, 3, 4, 5, 6],
            startTime: '00:00',
            endTime: '23:30',
            slotDurationMinutes: 30,
            bufferMinutes: 0,
            timezone: 'Asia/Kolkata',
            bookingEnabled: true
        };
        await availability.saveSettings(userA.id, openHours);
        await availability.saveSettings(userB.id, openHours);
    });

    afterEach(async () => {
        try {
            const wa = require('../src/services/whatsapp-client');
            await wa.destroyAllClients();
        } catch (_) {}
    });

    test('1. Schedules both 24h and 2h reminders when appointment is >24h away', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543210',
            contactName: 'Rahul Sharma',
            startIso: slotStart.toISOString(),
            notes: 'Looking for 3BHK'
        });

        expect(appt).toBeDefined();
        expect(appt.id).toBeDefined();

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);

        const r24 = reminders.find(r => r.reminder_type === '24h');
        const r2 = reminders.find(r => r.reminder_type === '2h');

        expect(r24).toBeDefined();
        expect(r2).toBeDefined();
        expect(r24.status).toBe('pending');
        expect(r2.status).toBe('pending');
        expect(r24.phone).toBe('919876543210');
        expect(r2.phone).toBe('919876543210');

        // Verify timing: 24h before and 2h before
        const expected24 = new Date(slotStart.getTime() - 24 * 60 * 60 * 1000);
        const expected2 = new Date(slotStart.getTime() - 2 * 60 * 60 * 1000);
        expect(new Date(r24.scheduled_at).getTime()).toBe(expected24.getTime());
        expect(new Date(r2.scheduled_at).getTime()).toBe(expected2.getTime());

        // Verify message content includes contact name and notes
        expect(r24.body).toContain('Rahul Sharma');
        expect(r24.body).toContain('Looking for 3BHK');
        expect(r24.body).toContain('Apex Realty');
        expect(r2.body).toContain('Rahul Sharma');
        expect(r2.body).toContain('in 2 hours');
    });

    test('2. Records 24h reminder as skipped and schedules 2h reminder when booked 10h in advance', async () => {
        const slotStart = new Date(Date.now() + 10 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543211',
            contactName: 'Priya Patel',
            startIso: slotStart.toISOString()
        });

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);

        const r24 = reminders.find(r => r.reminder_type === '24h');
        const r2 = reminders.find(r => r.reminder_type === '2h');

        expect(['skipped', 'skipped_past']).toContain(r24.status);
        expect(r24.error_message).toMatch(/booked less than 24h ahead/i);
        expect(r2.status).toBe('pending');
    });

    test('3. Records both 24h and 2h reminders as skipped when booked 1h in advance (<2h lead time)', async () => {
        const slotStart = new Date(Date.now() + 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543212',
            contactName: 'Amit Verma',
            startIso: slotStart.toISOString()
        });

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);

        const r24 = reminders.find(r => r.reminder_type === '24h');
        const r2 = reminders.find(r => r.reminder_type === '2h');

        expect(['skipped', 'skipped_past']).toContain(r24.status);
        expect(r24.error_message).toMatch(/booked less than 24h ahead/i);
        expect(['skipped', 'skipped_past']).toContain(r2.status);
        expect(r2.error_message).toMatch(/booked less than 2h ahead/i);
    });

    test('4. Includes project property details (name, address, map_url) when project_id is provided', async () => {
        const project = await db.createProject(userA.id, {
            name: 'Grand Orchids',
            address: 'Plot 42, Sector 15',
            locality: 'Whitefield',
            city: 'Bengaluru',
            mapUrl: 'https://maps.google.com/?q=grand-orchids'
        });

        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543213',
            contactName: 'Sunita Rao',
            startIso: slotStart.toISOString(),
            projectId: project.id
        });

        expect(appt.project_id).toBe(project.id);

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);

        const r24 = reminders.find(r => r.reminder_type === '24h');
        expect(r24.body).toContain('Grand Orchids');
        expect(r24.body).toContain('Plot 42, Sector 15, Whitefield, Bengaluru');
        expect(r24.body).toContain('https://maps.google.com/?q=grand-orchids');
    });

    test('5. Enriches from contact CRM deal interested_project_id when project_id is not directly given', async () => {
        const project = await db.createProject(userA.id, {
            name: 'Palm Meadows',
            address: 'Main Road',
            locality: 'Indiranagar',
            city: 'Bengaluru'
        });

        // Create deal for this contact with interested_project_id
        await db.createCrmDeal(userA.id, {
            phone: '919876543214',
            contactName: 'Vikram Singh',
            interested_project_id: project.id
        });

        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543214',
            contactName: 'Vikram Singh',
            startIso: slotStart.toISOString()
        });

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);
        const r24 = reminders.find(r => r.reminder_type === '24h');
        expect(r24.body).toContain('Palm Meadows');
        expect(r24.body).toContain('Indiranagar');
    });

    test('6. Supports custom template overrides from settings', async () => {
        await db.setSetting(
            userA.id,
            'reminder_template_24h',
            'Hello {{name}}! Custom reminder for {{property}} at {{time}}. Business: {{business_name}}'
        );

        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543215',
            contactName: 'Karan Mehra',
            startIso: slotStart.toISOString(),
            notes: 'Villa 10'
        });

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        const r24 = reminders.find(r => r.reminder_type === '24h');
        expect(r24.body).toMatch(/^Hello Karan Mehra! Custom reminder for Villa 10 at .*\. Business: Apex Realty$/);
    });

    test('7. Prevents duplicate reminder creation (idempotent)', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543216',
            contactName: 'Ananya Roy',
            startIso: slotStart.toISOString()
        });

        // Call scheduleAppointmentReminders a second time manually
        const secondRun = await appointmentReminders.scheduleAppointmentReminders(userA.id, appt);
        expect(secondRun).toHaveLength(0); // ON CONFLICT DO NOTHING returns null

        const reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);
    });

    test('8. Cancelling an appointment cancels all pending reminders immediately', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const appt = await availability.bookAppointment(userA.id, {
            phone: '919876543217',
            contactName: 'Deepak Joshi',
            startIso: slotStart.toISOString()
        });

        let reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders.every(r => r.status === 'pending')).toBe(true);

        // Cancel appointment
        const cancelled = await availability.cancelAppointment(userA.id, appt.id);
        expect(cancelled.status).toBe('cancelled');

        reminders = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(reminders).toHaveLength(2);
        expect(reminders.every(r => r.status === 'cancelled')).toBe(true);
    });

    test('9. Rescheduling (cancel + rebook) cancels old reminders and creates new ones', async () => {
        const slot1 = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slot1.setMinutes(0, 0, 0);

        const appt1 = await availability.bookAppointment(userA.id, {
            phone: '919876543218',
            contactName: 'Manish Kumar',
            startIso: slot1.toISOString()
        });

        await availability.cancelAppointment(userA.id, appt1.id);
        const reminders1 = await appointmentReminders.getAppointmentReminders(userA.id, appt1.id);
        expect(reminders1.every(r => r.status === 'cancelled')).toBe(true);

        // Rebook at new time
        const slot2 = new Date(Date.now() + 72 * 60 * 60 * 1000);
        slot2.setMinutes(0, 0, 0);

        const appt2 = await availability.bookAppointment(userA.id, {
            phone: '919876543218',
            contactName: 'Manish Kumar',
            startIso: slot2.toISOString()
        });

        const reminders2 = await appointmentReminders.getAppointmentReminders(userA.id, appt2.id);
        expect(reminders2).toHaveLength(2);
        expect(reminders2.every(r => r.status === 'pending')).toBe(true);

        const expected24 = new Date(slot2.getTime() - 24 * 60 * 60 * 1000);
        const r24 = reminders2.find(r => r.reminder_type === '24h');
        expect(new Date(r24.scheduled_at).getTime()).toBe(expected24.getTime());
    });

    test('10. Scheduler processes due reminders and skips reminders for cancelled appointments', async () => {
        // Create an appointment whose 2h reminder is due NOW
        const slotStart = new Date(Date.now() + 100 * 60 * 1000); // 1h 40m away
        slotStart.setMinutes(0, 0, 0);

        const appt = await db.createAppointment(userA.id, {
            phone: '919876543219',
            contactName: 'Geeta Nair',
            startAt: slotStart,
            endAt: new Date(slotStart.getTime() + 30 * 60 * 1000)
        });

        // Insert a reminder scheduled in the past (due right now)
        const dueAt = new Date(Date.now() - 5000);
        const reminder = await db.createAppointmentReminder(
            userA.id,
            appt.id,
            '919876543219',
            'Your visit is in 2 hours!',
            dueAt,
            '2h'
        );
        expect(reminder).toBeDefined();

        // Mock sendTextMessage so scheduler completes send without live socket
        const wa = require('../src/services/whatsapp-client');
        const sendSpy = jest.spyOn(wa, 'sendTextMessage').mockResolvedValue({ id: { _serialized: 'mock_wa_123' } });

        // Run scheduler tick
        const tick1 = await scheduler.processPendingMessages();
        expect(tick1.sent).toBe(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const updated = await appointmentReminders.getAppointmentReminders(userA.id, appt.id);
        expect(updated[0].status).toBe('sent');

        // Now test defense: another appointment cancelled directly in DB
        const slotStart2 = new Date(slotStart.getTime() + 60 * 60 * 1000);
        const apptCancelled = await db.createAppointment(userA.id, {
            phone: '919876543220',
            contactName: 'Cancelled Lead',
            startAt: slotStart2,
            endAt: new Date(slotStart2.getTime() + 30 * 60 * 1000)
        });
        const { runSql } = require('../src/services/db-pool');
        await runSql("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [apptCancelled.id]);

        // Create pending reminder
        await db.createAppointmentReminder(
            userA.id,
            apptCancelled.id,
            '919876543220',
            'Cancelled visit reminder',
            dueAt,
            '2h'
        );

        // Run scheduler tick — scheduler should catch that appointment is cancelled and cancel the reminder
        const tick2 = await scheduler.processPendingMessages();
        expect(tick2.sent).toBe(0);

        const remCancelled = await appointmentReminders.getAppointmentReminders(userA.id, apptCancelled.id);
        expect(remCancelled[0].status).toBe('cancelled');
    });

    test('11. Tenant isolation: cancelling Tenant A appointment never affects Tenant B reminders', async () => {
        const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
        slotStart.setMinutes(0, 0, 0);

        const apptA = await availability.bookAppointment(userA.id, {
            phone: '919999999999',
            contactName: 'Shared Name',
            startIso: slotStart.toISOString()
        });

        const apptB = await availability.bookAppointment(userB.id, {
            phone: '919999999999',
            contactName: 'Shared Name',
            startIso: slotStart.toISOString()
        });

        // Cancel Tenant A's appointment
        await availability.cancelAppointment(userA.id, apptA.id);

        const remA = await appointmentReminders.getAppointmentReminders(userA.id, apptA.id);
        const remB = await appointmentReminders.getAppointmentReminders(userB.id, apptB.id);

        expect(remA.every(r => r.status === 'cancelled')).toBe(true);
        expect(remB.every(r => r.status === 'pending')).toBe(true);
    });

    test('12. Formats visit time in tenant configured IANA timezone', async () => {
        // Configure Tenant B with Asia/Dubai (+04:00)
        await availability.saveSettings(userB.id, {
            workingDays: [0, 1, 2, 3, 4, 5, 6],
            startTime: '00:00',
            endTime: '23:30',
            slotDurationMinutes: 30,
            bufferMinutes: 0,
            timezone: 'Asia/Dubai',
            bookingEnabled: true
        });

        // Pick a fixed UTC slot: 2026-11-20T10:00:00Z -> In Dubai (UTC+4), this is 2:00 pm (14:00)
        const slotStart = new Date('2026-11-20T10:00:00.000Z');

        const appt = await db.createAppointment(userB.id, {
            phone: '971501234567',
            contactName: 'Farhan',
            startAt: slotStart,
            endAt: new Date(slotStart.getTime() + 30 * 60 * 1000)
        });

        const scheduled = await appointmentReminders.scheduleAppointmentReminders(userB.id, appt, {
            now: new Date('2026-11-18T10:00:00.000Z')
        });

        expect(scheduled).toHaveLength(2);
        const r24 = scheduled.find(r => r.reminder_type === '24h');
        // Dubai time format should contain '2:00 pm' or '14:00'
        expect(r24.body).toContain('2:00 pm');
    });
});
