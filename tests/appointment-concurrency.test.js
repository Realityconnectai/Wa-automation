/**
 * tests/appointment-concurrency.test.js
 *
 * Verifies createAppointment's concurrency safety.
 *
 * Two scenarios per the spec:
 *
 * Scenario A — same tenant, same slot, two concurrent bookings:
 *   The advisory lock (pg_advisory_xact_lock) serialises both calls.
 *   Exactly one succeeds; the other gets SLOT_TAKEN.
 *
 * Scenario B — different tenants, same slot time:
 *   Different user_ids → different advisory locks → both run concurrently.
 *   Both succeed because the overlap check is per-tenant (WHERE user_id = $1).
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/appointment-concurrency.test.js --forceExit
 */
'use strict';

describe('createAppointment — concurrency safety', () => {
    let userA, userB;

    // A fixed future slot: far enough ahead that MIN_LEAD_MINUTES never
    // causes SLOT_IN_PAST flakiness on slow CI, but valid.
    const SLOT_START = new Date(Date.now() + 72 * 60 * 60 * 1000); // 3 days from now
    SLOT_START.setMinutes(0, 0, 0); // round to whole hour for slot boundary

    // Slot duration matches default (30 min)
    const SLOT_END = new Date(SLOT_START.getTime() + 30 * 60 * 1000);

    beforeEach(async () => {
        await freshDatabase();
        const { createUser, saveAvailabilitySettings } = require('../src/services/database');

        // Create two tenants
        userA = await createUser({
            email: `appt_a_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });
        userB = await createUser({
            email: `appt_b_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active'
        });

        // Configure availability for both: Mon-Sun, 00:00-23:30, 30-min slots
        // so the test slot is always valid regardless of day.
        const availConfig = {
            workingDays: '0,1,2,3,4,5,6',
            startTime: '00:00',
            endTime: '23:30',
            slotDurationMinutes: 30,
            bufferMinutes: 0,
            timezone: 'UTC',
            bookingEnabled: true
        };
        await saveAvailabilitySettings(userA.id, availConfig);
        await saveAvailabilitySettings(userB.id, availConfig);
    });

    // ─────────────────────────────────────────────────────────────
    // Scenario A: same tenant, same slot
    // ─────────────────────────────────────────────────────────────
    test('Scenario A: two concurrent bookings of the same slot for the same tenant — exactly one succeeds', async () => {
        const { createAppointment } = require('../src/services/database');

        const apptArgs = {
            phone: '919876543210',
            contactName: 'Test Lead',
            startAt: SLOT_START.toISOString(),
            endAt: SLOT_END.toISOString(),
            source: 'chatbot'
        };

        // Fire both concurrently — do NOT await separately
        const [result1, result2] = await Promise.all([
            createAppointment(userA.id, apptArgs),
            createAppointment(userA.id, apptArgs)
        ]);

        // One must be an appointment row, the other must be null (slot taken)
        const successes = [result1, result2].filter(r => r !== null);
        const failures  = [result1, result2].filter(r => r === null);

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);

        // The successful row must have the correct data
        const appt = successes[0];
        expect(appt.user_id).toBe(userA.id);
        expect(appt.phone).toBe('919876543210');
        expect(appt.status).toBe('confirmed');

        // Database confirms exactly one row
        const { listAppointments } = require('../src/services/database');
        const rows = await listAppointments(userA.id);
        expect(rows).toHaveLength(1);
    });

    // ─────────────────────────────────────────────────────────────
    // Scenario B: different tenants, same slot time
    // ─────────────────────────────────────────────────────────────
    test('Scenario B: concurrent bookings of the same slot time by different tenants — both succeed', async () => {
        const { createAppointment, listAppointments } = require('../src/services/database');

        const args = (userId, phone) => ({
            phone,
            contactName: 'Test Lead',
            startAt: SLOT_START.toISOString(),
            endAt: SLOT_END.toISOString(),
            source: 'chatbot'
        });

        const [resultA, resultB] = await Promise.all([
            createAppointment(userA.id, args(userA.id, '919111111111')),
            createAppointment(userB.id, args(userB.id, '919222222222'))
        ]);

        // Both must succeed — different tenants, different locks, no shared state
        expect(resultA).not.toBeNull();
        expect(resultB).not.toBeNull();
        expect(resultA.user_id).toBe(userA.id);
        expect(resultB.user_id).toBe(userB.id);

        // Each tenant has exactly one appointment
        const rowsA = await listAppointments(userA.id);
        const rowsB = await listAppointments(userB.id);
        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);

        // Tenant isolation: A's appointment is not visible to B and vice versa
        expect(rowsA[0].phone).toBe('919111111111');
        expect(rowsB[0].phone).toBe('919222222222');
    });

    // ─────────────────────────────────────────────────────────────
    // Scenario C: same tenant, different non-overlapping slots
    // ─────────────────────────────────────────────────────────────
    test('Scenario C: two concurrent bookings of different slots for the same tenant — both succeed', async () => {
        const { createAppointment, listAppointments } = require('../src/services/database');

        const slot2Start = new Date(SLOT_START.getTime() + 30 * 60 * 1000); // +30min
        const slot2End   = new Date(slot2Start.getTime()  + 30 * 60 * 1000);

        const [r1, r2] = await Promise.all([
            createAppointment(userA.id, {
                phone: '919111111111', contactName: 'Lead 1',
                startAt: SLOT_START.toISOString(), endAt: SLOT_END.toISOString(), source: 'dashboard'
            }),
            createAppointment(userA.id, {
                phone: '919222222222', contactName: 'Lead 2',
                startAt: slot2Start.toISOString(), endAt: slot2End.toISOString(), source: 'dashboard'
            })
        ]);

        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();

        const rows = await listAppointments(userA.id);
        expect(rows).toHaveLength(2);
    });

    // ─────────────────────────────────────────────────────────────
    // Scenario D: same tenant, two DIFFERENT contacts, OVERLAPPING slots
    // (e.g. 10:00-10:30 and 10:15-10:45), booked concurrently
    // ─────────────────────────────────────────────────────────────
    test('Scenario D: same tenant, different contacts, overlapping slots — exactly one succeeds', async () => {
        const { createAppointment, listAppointments } = require('../src/services/database');

        // slot1: SLOT_START → SLOT_START+30min
        // slot2: SLOT_START+15min → SLOT_START+45min  (overlaps slot1 by 15 min)
        const slot1Start = SLOT_START;
        const slot1End   = SLOT_END; // +30min
        const slot2Start = new Date(SLOT_START.getTime() + 15 * 60 * 1000);
        const slot2End   = new Date(SLOT_START.getTime() + 45 * 60 * 1000);

        const [r1, r2] = await Promise.all([
            createAppointment(userA.id, {
                phone: '919111111111', contactName: 'Contact 1',
                startAt: slot1Start.toISOString(), endAt: slot1End.toISOString(), source: 'chatbot'
            }),
            createAppointment(userA.id, {
                phone: '919222222222', contactName: 'Contact 2',
                startAt: slot2Start.toISOString(), endAt: slot2End.toISOString(), source: 'chatbot'
            })
        ]);

        // The advisory lock on userId serialises both calls. The overlap check
        // (WHERE start_at < $endAt AND end_at > $startAt) is scoped by
        // user_id only — it does NOT distinguish between contacts or "agents".
        // One succeeds; the overlapping booking is rejected (returns null).
        const successes = [r1, r2].filter(r => r !== null);
        const failures  = [r1, r2].filter(r => r === null);

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);

        const rows = await listAppointments(userA.id);
        expect(rows).toHaveLength(1);
    });
    // ─── Overlap-check scope analysis (report-only, not a test) ───────────────
    // countOverlappingAppointments(userId, startAt, endAt) queries:
    //   WHERE user_id = $1 AND status = 'confirmed' AND start_at < $endAt AND end_at > $startAt
    // The check is scoped by TENANT only. There is NO concept of per-agent or
    // per-property scoping. In a multi-agent real estate product where two
    // agents should be able to run site visits simultaneously at different
    // properties, this causes false conflicts.
    //
    // Proposed minimal change (Phase 1, additive):
    //   ALTER TABLE appointments ADD COLUMN property_id INTEGER REFERENCES properties(id);
    //   ALTER TABLE appointments ADD COLUMN agent_id INTEGER REFERENCES users(id);
    // Then add an optional agentId parameter to createAppointment and
    // countOverlappingAppointments:
    //   if (agentId) sql += ' AND (agent_id IS NULL OR agent_id = $N)'
    // This preserves existing single-agent behaviour (agentId=null = tenant-wide)
    // while allowing per-agent scoping when agent_id is supplied.
});
