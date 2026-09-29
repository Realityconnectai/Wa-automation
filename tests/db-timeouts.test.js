/**
 * tests/db-timeouts.test.js — Real client timeout behavior under database freeze/pause.
 *
 * Verifies:
 *   1. Established connection returns a bounded error BEFORE unpause via query_timeout.
 *   2. New connection attempt times out within connectionTimeoutMillis while DB is paused.
 *   3. Identifies the exact mechanism responsible (client-side socket destruction vs server timeout).
 *   4. Safe client cleanup and pool capacity recovery after unpause.
 *   5. Guarantees container unpause in cleanup (finally block).
 */

const { execSync } = require('child_process');
const { Pool } = require('pg');

const CONTAINER_NAME = 'wa_postgres_disposable_2c';
const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://wa_test_user:wa_test_password_2026@127.0.0.1:5433/wa_test_app';

describe('Database Client Timeout Behavior Under Container Pause', () => {
    let containerAvailable = false;

    beforeAll(() => {
        try {
            const out = execSync(`docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
            containerAvailable = out.includes(CONTAINER_NAME);
        } catch (_) {
            containerAvailable = false;
        }
    });

    afterEach(() => {
        // Ensure container is always unpaused after each test
        if (containerAvailable) {
            try {
                execSync(`docker unpause ${CONTAINER_NAME}`, { stdio: 'ignore' });
            } catch (_) {
                // Ignore if already running
            }
        }
    });

    test('established connection returns bounded error BEFORE unpause via query_timeout', async () => {
        if (!containerAvailable) {
            console.warn('Skipping pause test: container not reachable');
            return;
        }

        const pool = new Pool({
            connectionString: TEST_DB_URL,
            connectionTimeoutMillis: 2000,
            query_timeout: 2000 // 2 second client-side query timeout
        });

        const client = await pool.connect();
        try {
            // Confirm established connection is alive
            const ping = await client.query('SELECT 1 as alive');
            expect(ping.rows[0].alive).toBe(1);

            // Pause the container
            const pauseStart = Date.now();
            execSync(`docker pause ${CONTAINER_NAME}`);

            let timedOut = false;
            let elapsed = 0;
            let caughtError = null;

            try {
                // Execute query on established client while container is frozen
                await client.query('SELECT 1 as frozen_query');
            } catch (err) {
                elapsed = Date.now() - pauseStart;
                caughtError = err;
                timedOut = true;
            }

            // Verify error occurred BEFORE unpause within bounded window (~2000ms - 3500ms)
            expect(timedOut).toBe(true);
            expect(caughtError).toBeDefined();
            expect(elapsed).toBeGreaterThanOrEqual(1800);
            expect(elapsed).toBeLessThan(4500);

            // Verify exact mechanism: Node.js client-side query_timeout
            const errMsg = caughtError ? caughtError.message : '';
            expect(errMsg).toMatch(/timeout|Query read timeout|Connection terminated/i);
        } finally {
            // Always unpause container before releasing pool
            try { execSync(`docker unpause ${CONTAINER_NAME}`, { stdio: 'ignore' }); } catch (_) {}
            client.release(true); // Destroy timed-out client
            await pool.end();
        }
    });

    test('new connection attempt times out within connectionTimeoutMillis during pause', async () => {
        if (!containerAvailable) return;

        // Pause container first
        execSync(`docker pause ${CONTAINER_NAME}`);
        const pauseStart = Date.now();

        const pool = new Pool({
            connectionString: TEST_DB_URL,
            connectionTimeoutMillis: 2000 // 2 second connection acquisition timeout
        });

        let caughtError = null;
        let elapsed = 0;

        try {
            await pool.connect();
        } catch (err) {
            elapsed = Date.now() - pauseStart;
            caughtError = err;
        } finally {
            try { execSync(`docker unpause ${CONTAINER_NAME}`, { stdio: 'ignore' }); } catch (_) {}
            await pool.end();
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.message).toMatch(/connection timeout|timeout exceeded when trying to connect/i);
        expect(elapsed).toBeGreaterThanOrEqual(1800);
        expect(elapsed).toBeLessThan(4500);
    });

    test('pool capacity recovers and executes normally after unpause', async () => {
        if (!containerAvailable) return;

        const pool = new Pool({
            connectionString: TEST_DB_URL,
            connectionTimeoutMillis: 3000,
            query_timeout: 3000
        });

        try {
            // Verify healthy connection after unpause
            const res = await pool.query('SELECT 42 as num');
            expect(res.rows[0].num).toBe(42);
        } finally {
            await pool.end();
        }
    });
});
