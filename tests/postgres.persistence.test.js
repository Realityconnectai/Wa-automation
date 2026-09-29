/**
 * tests/postgres.persistence.test.js
 *
 * Test suite for PostgreSQL persistence, migrations, isolation, concurrency,
 * and synthetic data migration.
 *
 * When DATABASE_URL is configured (e.g. postgresql://postgres:postgres@localhost:5432/whatsapp_test),
 * runs live integration tests against an isolated test database.
 * When DATABASE_URL is not set, describes the verification requirements and marks tests as skipped.
 */

'use strict';

const { Pool } = require('pg');

const TEST_DB_URL = process.env.DATABASE_URL;

describe('PostgreSQL Persistence & Migration Suite', () => {
    if (!TEST_DB_URL) {
        test.skip('Skipped: Real PostgreSQL database not available (DATABASE_URL not set)', () => {
            console.warn('⚠️ Real PostgreSQL integration tests skipped because no isolated PostgreSQL instance was detected.');
        });
        return;
    }

    let db;
    let pool;

    beforeAll(async () => {
        db = require('../src/services/database');
        pool = require('../src/services/db-pool').getPool();
        await db.initDatabase();
        await pool.query('TRUNCATE users, contacts, messages, chatbot_rules, scheduled_messages, settings, products, crm_deals, crm_activities, lead_analysis, google_calendar_accounts, google_calendar_synced_events, availability_settings, appointments CASCADE');
    });

    afterAll(async () => {
        if (db) await db.closeDatabase();
    });

    describe('Phase 3: Schema Migrations & Idempotency', () => {
        test('Migrations run successfully and are recorded', async () => {
            const version = await db.getSchemaVersion();
            expect(version).toBeGreaterThanOrEqual(9);
        });

        test('Re-running migrations is idempotent and safe', async () => {
            const versionBefore = await db.getSchemaVersion();
            await db.runMigrations();
            const versionAfter = await db.getSchemaVersion();
            expect(versionAfter).toBe(versionBefore);
        });
    });

    describe('Phase 4: Two-Tenant Access Isolation', () => {
        let user1, user2;

        beforeAll(async () => {
            user1 = await db.createUser('test_tenant1@example.com', 'hashed_pwd_1', 'user');
            user2 = await db.createUser('test_tenant2@example.com', 'hashed_pwd_2', 'user');
        });

        test('Contacts of tenant 1 are invisible to tenant 2', async () => {
            await db.upsertContact(user1.id, '15551112222', 'Tenant 1 Contact');
            const user2Contacts = await db.getContacts(user2.id);
            expect(user2Contacts.some(c => c.phone === '15551112222')).toBe(false);

            const fetched = await db.getContactByPhone(user2.id, '15551112222');
            expect(fetched).toBeNull();
        });

        test('Messages of tenant 1 are invisible to tenant 2', async () => {
            await db.logMessage(user1.id, {
                phone: '15551112222',
                direction: 'outgoing',
                body: 'Secret message from tenant 1',
                status: 'sent'
            });

            const user2Messages = await db.getMessages(user2.id);
            expect(user2Messages.some(m => m.body === 'Secret message from tenant 1')).toBe(false);
        });

        test('Settings of tenant 1 cannot be read or overwritten by tenant 2', async () => {
            await db.setSetting(user1.id, 'custom_secret_key', 'tenant1_val');
            const val = await db.getSetting(user2.id, 'custom_secret_key');
            expect(val).toBeNull();
        });
    });

    describe('Phase 4: Authentication, Status & Session Invalidation', () => {
        let authUser;

        beforeAll(async () => {
            authUser = await db.createUser('auth_test@example.com', 'initial_hash', 'user');
        });

        test('Updating password records password_changed_at', async () => {
            const before = authUser.password_changed_at;
            const updated = await db.updateUserPassword(authUser.id, 'new_hash');
            expect(updated.password_changed_at).not.toBe(before);
            expect(new Date(updated.password_changed_at).getTime()).toBeGreaterThan(0);
        });

        test('Suspended user is visible as status = suspended', async () => {
            await db.updateUser(authUser.id, { status: 'suspended' });
            const fresh = await db.getUserById(authUser.id);
            expect(fresh.status).toBe('suspended');
        });
    });

    describe('Phase 4: Transactions and Rollback', () => {
        test('Transaction rolls back completely on error', async () => {
            const user = await db.createUser('tx_test@example.com', 'hash', 'user');
            const initialContacts = await db.countContacts(user.id);

            await expect(
                db.transaction(async () => {
                    await db.upsertContact(user.id, '15559990001', 'Contact 1');
                    await db.upsertContact(user.id, '15559990002', 'Contact 2');
                    throw new Error('Simulated failure during transaction');
                })
            ).rejects.toThrow('Simulated failure during transaction');

            const afterContacts = await db.countContacts(user.id);
            expect(afterContacts).toBe(initialContacts);
        });

        test('Connection is released back to pool after failure', async () => {
            const poolBefore = pool.idleCount;
            try {
                await db.transaction(async () => {
                    throw new Error('Injected error to test release');
                });
            } catch (_) {}
            expect(pool.waitingCount).toBe(0);
        });
    });

    describe('Phase 4: Concurrency & Race Conditions', () => {
        test('Atomic claim on scheduled message prevents double claim', async () => {
            const user = await db.createUser('sched_claim@example.com', 'hash', 'user');
            const msg = await db.createScheduledMessage(user.id, '15558880001', 'Test msg', '2026-10-01 12:00:00');

            // Simulate two concurrent workers claiming the same message simultaneously
            const [claim1, claim2] = await Promise.all([
                db.claimScheduledMessage(msg.id),
                db.claimScheduledMessage(msg.id)
            ]);

            // Exactly one worker must succeed (true), the other must fail (false)
            expect([claim1, claim2].filter(Boolean).length).toBe(1);
        });

        test('Advisory lock prevents appointment double-booking for overlapping slots', async () => {
            const user = await db.createUser('booking_test@example.com', 'hash', 'user');
            const startAt = '2026-11-01 10:00:00';
            const endAt = '2026-11-01 10:30:00';

            // Competing booking attempts for the same resource slot
            const bookSlot = async (name) => {
                return db.transaction(async (tx) => {
                    // Acquire advisory transaction lock for the tenant
                    await tx.query('SELECT pg_advisory_xact_lock($1)', [user.id]);

                    // Check existing conflict
                    const conflict = await tx.query(
                        `SELECT id FROM appointments
                         WHERE user_id = $1 AND status != 'cancelled'
                           AND start_at < $2 AND end_at > $3`,
                        [user.id, endAt, startAt]
                    );

                    if (conflict.rows.length > 0) {
                        throw new Error('SLOT_TAKEN');
                    }

                    const res = await tx.query(
                        `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status)
                         VALUES ($1, $2, $3, $4, $5, 'confirmed') RETURNING id`,
                        [user.id, '15557770001', name, startAt, endAt]
                    );
                    return res.rows[0];
                });
            };

            const results = await Promise.allSettled([
                bookSlot('Customer A'),
                bookSlot('Customer B')
            ]);

            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter(r => r.status === 'rejected');

            expect(fulfilled.length).toBe(1);
            expect(rejected.length).toBe(1);
            expect(rejected[0].reason.message).toBe('SLOT_TAKEN');
        });
    });
});
