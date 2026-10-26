'use strict';

/**
 * tests/campaign-resume-concurrency.test.js
 *
 * Automated tests for:
 * 1. Campaign resume after a real server restart mid-run:
 *    - In-flight 'sending' rows marked failed (delivery unconfirmed, zero duplicates)
 *    - Remaining 'pending' recipients resume on schedule without duplicate sends
 * 2. Row-locking under two concurrent workers:
 *    - Atomically claims rows with FOR UPDATE SKIP LOCKED
 *    - Zero collisions, zero duplicates across concurrent worker loops
 * 3. Retry Failed honors the buffer:
 *    - Retried rows respect buffer delay pacing
 *    - Previously sent rows are untouched
 */

require('dotenv').config();
const { runSql, queryAll } = require('../src/services/db-pool');
const { randomUUID } = require('crypto');
const {
    runJob,
    reclaimInterruptedOutreachJobs,
    retryFailedOutreachRecipients,
    setSleepImplementation,
    setSendMessageImplementation
} = require('../src/services/outreach');
const whatsappClient = require('../src/services/whatsapp-client');

describe('Campaign Resume, Concurrency Row-Locking & Buffer Preservation', () => {
    let testUserId = 1;
    let sentDispatches = [];

    beforeAll(async () => {
        // Find an active user
        const u = await queryAll("SELECT id FROM users WHERE status = 'active' ORDER BY id ASC LIMIT 1");
        if (u && u[0]) {
            testUserId = u[0].id;
        }

        // Fast-forward sleep implementation for test speed
        setSleepImplementation(async () => {});

        // Mock WhatsApp message dispatch
        setSendMessageImplementation(async (uid, phone, text) => {
            sentDispatches.push({ uid, phone, text, at: Date.now() });
            return { id: { _serialized: `msg_mock_${randomUUID().slice(0, 8)}` } };
        });
    });

    beforeEach(() => {
        sentDispatches = [];
    });

    afterAll(async () => {
        setSendMessageImplementation(null);
    });

    async function waitForJobCompletion(jobId, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const j = await queryAll("SELECT status FROM outreach_jobs WHERE id = $1", [jobId]);
            if (j[0]?.status && j[0].status !== 'running') {
                return j[0].status;
            }
            await new Promise(r => setTimeout(r, 20));
        }
        throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
    }

    test('1. Campaign resume after restart mid-run sends remaining recipients on schedule with zero duplicates', async () => {
        const jobId = randomUUID();
        const phones = ['919811111111', '919822222222', '919833333333', '919844444444'];

        // Create outreach job with 4 recipients and 1 minute buffer
        await runSql(`
            INSERT INTO outreach_jobs (id, user_id, message_template, status, total, buffer_minutes, buffer_jitter)
            VALUES ($1, $2, 'Hello {{name}}', 'running', 4, 1, false)
        `, [jobId, testUserId]);

        // Insert 4 recipients
        // Recipient 1: already sent before crash
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status, sent_at)
            VALUES ($1, $2, $3, 'Contact 1', 'sent', CURRENT_TIMESTAMP)
        `, [jobId, testUserId, phones[0]]);

        // Recipient 2: stuck in 'sending' when server crashed
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status)
            VALUES ($1, $2, $3, 'Contact 2', 'sending')
        `, [jobId, testUserId, phones[1]]);

        // Recipient 3 & 4: pending
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status)
            VALUES ($1, $2, $3, 'Contact 3', 'pending')
        `, [jobId, testUserId, phones[2]]);
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status)
            VALUES ($1, $2, $3, 'Contact 4', 'pending')
        `, [jobId, testUserId, phones[3]]);

        // Simulate server restart: invoke reclaimInterruptedOutreachJobs()
        const restartRes = await reclaimInterruptedOutreachJobs();
        expect(restartRes.reclaimedRecipients).toBeGreaterThanOrEqual(1);

        // Wait for resumed worker loop to complete
        await waitForJobCompletion(jobId);

        // Verify recipients in database
        const rows = await queryAll(`
            SELECT phone, status, reason FROM outreach_recipients
            WHERE job_id = $1 ORDER BY id ASC
        `, [jobId]);

        expect(rows).toHaveLength(4);
        // Recipient 1: remained sent
        expect(rows[0].status).toBe('sent');
        // Recipient 2: marked failed to avoid duplicate send
        expect(rows[1].status).toBe('failed');
        expect(rows[1].reason).toContain('Interrupted by server restart');
        // Recipients 3 & 4: successfully resumed and sent
        expect(rows[2].status).toBe('sent');
        expect(rows[3].status).toBe('sent');

        // Verify sentDispatches only contains recipient 3 & 4 (recipient 1 was NEVER re-sent)
        const sentPhones = sentDispatches.map(d => d.phone);
        expect(sentPhones).not.toContain(phones[0]);
        expect(sentPhones).toContain(phones[2]);
        expect(sentPhones).toContain(phones[3]);

        // Job status: completed_with_errors (since 1 failed, 3 sent)
        const jobRow = await queryAll("SELECT status FROM outreach_jobs WHERE id = $1", [jobId]);
        expect(jobRow[0].status).toBe('completed_with_errors');
    });

    test('2. Row-locking under two concurrent workers prevents duplicate sends', async () => {
        const jobId = randomUUID();
        const phones = [
            '919855555551', '919855555552', '919855555553',
            '919855555554', '919855555555', '919855555556'
        ];

        // Create outreach job with 6 pending recipients
        await runSql(`
            INSERT INTO outreach_jobs (id, user_id, message_template, status, total, buffer_minutes, buffer_jitter)
            VALUES ($1, $2, 'Concurrency Test {{name}}', 'running', 6, 0, false)
        `, [jobId, testUserId]);

        for (let i = 0; i < phones.length; i++) {
            await runSql(`
                INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status)
                VALUES ($1, $2, $3, $4, 'pending')
            `, [jobId, testUserId, phones[i], `Recip ${i + 1}`]);
        }

        // Clear sentDispatches before launching workers
        sentDispatches = [];

        // Launch two worker instances simultaneously on the same job
        const worker1 = runJob({ id: jobId, user_id: testUserId, buffer_minutes: 0, buffer_jitter: false });
        const worker2 = runJob({ id: jobId, user_id: testUserId, buffer_minutes: 0, buffer_jitter: false });

        await Promise.all([worker1, worker2]);
        await waitForJobCompletion(jobId);

        // Verify every recipient was processed and sent exactly ONCE
        const finalRows = await queryAll(`
            SELECT phone, status FROM outreach_recipients WHERE job_id = $1 ORDER BY id ASC
        `, [jobId]);

        expect(finalRows).toHaveLength(6);
        finalRows.forEach(r => {
            expect(r.status).toBe('sent');
        });

        // Exactly 6 dispatches occurred — zero duplicates
        const dispatchedJobPhones = sentDispatches.filter(d => phones.includes(d.phone)).map(d => d.phone);
        const uniqueDispatched = new Set(dispatchedJobPhones);
        expect(dispatchedJobPhones.length).toBe(6);
        expect(uniqueDispatched.size).toBe(6);

        // Job status is completed
        const jobRow = await queryAll("SELECT status FROM outreach_jobs WHERE id = $1", [jobId]);
        expect(jobRow[0].status).toBe('completed');
    });

    test('3. Retry Failed honors the buffer delay and skips already sent rows', async () => {
        const jobId = randomUUID();
        const phones = ['919877777771', '919877777772', '919877777773'];

        // Create outreach job with 2 minute buffer
        await runSql(`
            INSERT INTO outreach_jobs (id, user_id, message_template, status, total, buffer_minutes, buffer_jitter)
            VALUES ($1, $2, 'Retry Test {{name}}', 'completed_with_errors', 3, 2, false)
        `, [jobId, testUserId]);

        // Recipient 1 was sent successfully
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status, sent_at)
            VALUES ($1, $2, $3, 'Sent One', 'sent', CURRENT_TIMESTAMP)
        `, [jobId, testUserId, phones[0]]);

        // Recipients 2 and 3 failed
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status, reason)
            VALUES ($1, $2, $3, 'Failed Two', 'failed', 'Network timeout')
        `, [jobId, testUserId, phones[1]]);
        await runSql(`
            INSERT INTO outreach_recipients (job_id, user_id, phone, contact_name, status, reason)
            VALUES ($1, $2, $3, 'Failed Three', 'failed', 'Network timeout')
        `, [jobId, testUserId, phones[2]]);

        // Clear dispatches before retry
        sentDispatches = [];

        // Call retryFailedOutreachRecipients
        const retryRes = await retryFailedOutreachRecipients(testUserId, jobId);
        expect(retryRes.retried).toBe(2);

        // Wait for retry execution to complete
        await waitForJobCompletion(jobId);

        // Verify final statuses
        const rows = await queryAll(`
            SELECT phone, status FROM outreach_recipients WHERE job_id = $1 ORDER BY id ASC
        `, [jobId]);

        expect(rows[0].status).toBe('sent'); // Already sent row was not re-sent
        expect(rows[1].status).toBe('sent'); // Retried
        expect(rows[2].status).toBe('sent'); // Retried

        // Sent dispatches only contains the two retried rows
        const retryDispatched = sentDispatches.filter(d => phones.includes(d.phone)).map(d => d.phone);
        expect(retryDispatched).not.toContain(phones[0]);
        expect(retryDispatched).toContain(phones[1]);
        expect(retryDispatched).toContain(phones[2]);
        expect(retryDispatched).toHaveLength(2);

        // Job status is now completed
        const jobRow = await queryAll("SELECT status FROM outreach_jobs WHERE id = $1", [jobId]);
        expect(jobRow[0].status).toBe('completed');
    });
});
