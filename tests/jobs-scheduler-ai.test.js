const { initDatabase, getDb, stopPersistence, createUser, createScheduledMessage, claimScheduledMessage, updateScheduledMessageStatus, createOutreachJob, getOutreachJob: getStoredOutreachJob, recoverInterruptedOutreachJobs } = require('../src/services/database');
const { concurrencyGate } = require('../src/middleware/rateLimit');
const { isCircuitOpen, recordFailure, recordSuccess, resetCircuits } = require('../src/services/gemini-client');
const { startOutreachJob, cancelOutreachJob } = require('../src/services/outreach');
const { runSql } = require('../src/services/db-pool');

describe('Priority 2: Background Jobs, Scheduler & AI Protections', () => {
    let db;
    let testUser;

    beforeAll(async () => {
        process.env.PERSIST_ROOT = require('path').join(__dirname, '..', 'data', 'test_p2');
        db = await initDatabase();
        testUser = await createUser({
            email: `p2_tester_${Date.now()}@example.com`,
            passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
            businessName: 'Test Biz',
            ownerName: 'Test Owner',
            status: 'active'
        });
    });

    afterAll(async () => {
        await stopPersistence();
    });

    beforeEach(() => {
        resetCircuits();
    });

    describe('2.1 Scheduler Atomic Job Claiming', () => {
        test('atomic claim prevents duplicate job execution by parallel workers', async () => {
            const res = await createScheduledMessage(testUser.id, '919876543210', 'Test atomic claim', '2020-01-01 10:00:00');
            const msgId = res.id;

            // Worker 1 claims
            const claimed1 = await claimScheduledMessage(msgId);
            expect(claimed1).toBe(true);

            // Worker 2 attempts to claim same job -> fails
            const claimed2 = await claimScheduledMessage(msgId);
            expect(claimed2).toBe(false);

            // Mark as sent
            await updateScheduledMessageStatus(msgId, 'sent');
        });
    });

    describe('2.2 Bulk Outreach Rate Limiting & Safety', () => {
        test('rejects batch larger than maximum recipients per job', async () => {
            const contacts = Array.from({ length: 30 }, (_, i) => ({
                phone: `9198765432${i.toString().padStart(2, '0')}`,
                name: `User ${i}`
            }));

            await expect(startOutreachJob(testUser, contacts, 'Hello {{name}}')).rejects.toThrow(/capped at 25/);
        });

        test('persists jobs and prevents multiple simultaneous jobs per tenant', async () => {
            const contacts = [{ phone: '919876543210', name: 'Test' }];

            // Create the first durable job without starting its asynchronous
            // sender. A real one-recipient job can complete before the second
            // request is scheduled, which would not exercise the concurrency
            // guard at all.
            const job = await createOutreachJob(testUser.id, `active-${Date.now()}`, 'Hello {{name}}', contacts);
            expect(job.status).toBe('running');
            await expect(startOutreachJob(testUser, contacts, 'Hello again {{name}}')).rejects.toThrow(/already have an outreach send in progress/);
            await cancelOutreachJob(job.id, testUser.id);
        });

        test('restart recovery marks unfinished recipients without resending', async () => {
            const job = await createOutreachJob(testUser.id, `recovery-${Date.now()}`, 'Hello', [
                { phone: '919876543210', name: 'Sending' },
                { phone: '919876543211', name: 'Pending' }
            ]);
            await runSql("UPDATE outreach_recipients SET status='sending' WHERE job_id=$1 AND contact_name='Sending'", [job.id]);
            await recoverInterruptedOutreachJobs();
            const recovered = await getStoredOutreachJob(testUser.id, job.id);
            expect(recovered.status).toBe('interrupted');
            expect(recovered.results).toEqual(expect.arrayContaining([
                expect.objectContaining({ name: 'Sending', status: 'unknown' }),
                expect.objectContaining({ name: 'Pending', status: 'skipped' })
            ]));
        });
    });

    describe('2.3 AI Concurrency Gate & Circuit Breaker', () => {
        test('concurrency gate enforces global and per-user limits', () => {
            const gate = concurrencyGate({ maxGlobal: 3, maxPerUser: 2 });

            // User 1 acquires slot 1 & 2
            expect(gate.tryAcquire(1)).toEqual({ ok: true });
            expect(gate.tryAcquire(1)).toEqual({ ok: true });
            // User 1 attempts slot 3 -> rejected by user limit
            expect(gate.tryAcquire(1)).toEqual({ ok: false, reason: 'user' });

            // User 2 acquires slot 3 -> ok
            expect(gate.tryAcquire(2)).toEqual({ ok: true });
            // User 2 attempts slot 4 -> rejected by global limit
            expect(gate.tryAcquire(2)).toEqual({ ok: false, reason: 'global' });

            // User 1 releases slot 1
            gate.release(1);
            // Now User 2 can acquire
            expect(gate.tryAcquire(2)).toEqual({ ok: true });

            // Clean up
            gate.release(1);
            gate.release(2);
            gate.release(2);
        });

        test('circuit breaker trips after consecutive failures and recovers on success', () => {
            const apiKey = 'test_key_ai_12345';

            expect(isCircuitOpen(apiKey)).toBe(false);

            // Record 4 failures -> still closed
            for (let i = 0; i < 4; i++) recordFailure(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(false);

            // 5th failure -> trips open
            recordFailure(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(true);

            // Successful call restores
            recordSuccess(apiKey);
            expect(isCircuitOpen(apiKey)).toBe(false);
        });
    });
});
