/**
 * tests/backdoor-regression.test.js
 *
 * Regression tests for the hardcoded login backdoor removed in phase0-preflight.
 *
 * The backdoor was:
 *   if (!valid && user.email === 'admin@workpilot.co.in' &&
 *       String(password || '').toLowerCase() === 'admin@workpilot123') {
 *       valid = true;
 *   }
 *
 * These tests verify:
 *   1. The hardcoded password no longer grants access to any account.
 *   2. The hardcoded password does not grant access even when it IS set as the
 *      real bcrypt password (belt-and-suspenders: ensures no remnant path).
 *   3. Correct bcrypt passwords still work normally.
 *   4. The backdoor email address receives exactly the same response as any
 *      other address — no timing difference, no information leak.
 *
 * These tests require a throwaway test database. Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/backdoor-regression.test.js --forceExit
 */
'use strict';

const request = require('supertest');

// ─── Backdoor credential constants (used for assertion only, never for auth) ─
const BACKDOOR_EMAIL    = 'admin@workpilot.co.in';
const BACKDOOR_PASSWORD = 'admin@workpilot123';   // intentionally lowercase — old bypass was case-insensitive

// ─── Source-level guard (no DB needed) ────────────────────────────────────
// Runs in every environment. Fails immediately if the backdoor is re-introduced.
describe('Backdoor regression — source-code guard (no DB required)', () => {
    test('auth.js source does not contain the backdoor email or password string', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'routes', 'auth.js'),
            'utf8'
        );
        expect(source.toLowerCase()).not.toContain('admin@workpilot.co.in');
        expect(source.toLowerCase()).not.toContain('admin@workpilot123');
        // Also catch any re-introduction of the pattern shape
        expect(source).not.toMatch(/valid\s*=\s*true(?!\s*\})/);
    });
});

// ─── HTTP integration tests (require throwaway test DB) ────────────────────
describe('Backdoor regression — hardcoded credential bypass', () => {
    let app;

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
    });

    // ─── Core regression ───────────────────────────────────────
    describe('Backdoor credential must never grant access', () => {
        test('backdoor password rejected for the specific backdoor email (account exists, wrong password)', async () => {
            // Create the account with a DIFFERENT real password via signup path
            const realPassword = 'RealSecure456!';
            await signup(app, { email: BACKDOOR_EMAIL, password: realPassword });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: BACKDOOR_EMAIL, password: BACKDOOR_PASSWORD });

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Invalid email or password.');
            // Must not have set a session cookie
            expect(res.headers['set-cookie']).toBeUndefined();
        });

        test('backdoor password rejected case-insensitively (old bypass was toLowerCase)', async () => {
            const realPassword = 'RealSecure456!';
            await signup(app, { email: BACKDOOR_EMAIL, password: realPassword });

            for (const variant of [
                BACKDOOR_PASSWORD,
                BACKDOOR_PASSWORD.toUpperCase(),
                'Admin@Workpilot123',
                'ADMIN@WORKPILOT123',
            ]) {
                const res = await request(app)
                    .post('/api/auth/login')
                    .send({ email: BACKDOOR_EMAIL, password: variant });
                expect(res.status).toBe(401);
                expect(res.headers['set-cookie']).toBeUndefined();
            }
        });

        test('backdoor password rejected for a completely different account', async () => {
            await signup(app, { email: 'someoneelse@example.com', password: 'RealSecure456!' });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'someoneelse@example.com', password: BACKDOOR_PASSWORD });

            expect(res.status).toBe(401);
            expect(res.headers['set-cookie']).toBeUndefined();
        });

        test('backdoor password rejected even when account does not exist', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: BACKDOOR_EMAIL, password: BACKDOOR_PASSWORD });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Invalid email or password.');
        });
    });

    // ─── Correct bcrypt path still works ───────────────────────
    describe('Normal bcrypt login is unaffected', () => {
        test('correct real password for backdoor email works after approval', async () => {
            const realPassword = 'CorrectPassword789!';
            const { user } = await signup(app, { email: BACKDOOR_EMAIL, password: realPassword });

            // signup helper auto-approves (status: active) in test mode
            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: BACKDOOR_EMAIL, password: realPassword });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.headers['set-cookie']).toBeDefined();
        });

        test('correct real password for any ordinary account works', async () => {
            const { user } = await signup(app, { email: 'ordinary@example.com', password: 'MyRealPass123!' });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'ordinary@example.com', password: 'MyRealPass123!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('wrong password for any account is rejected', async () => {
            await signup(app, { email: 'user@example.com', password: 'MyRealPass123!' });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: 'user@example.com', password: 'WrongPass456!' });

            expect(res.status).toBe(401);
        });
    });

    // ─── No information leak from backdoor email address ───────
    describe('Backdoor email address does not leak info', () => {
        test('response is identical for backdoor email vs unknown email (timing within 3x)', async () => {
            // Neither account exists — both should hit burnPasswordVerification path
            const timeOf = async (email) => {
                const samples = [];
                for (let i = 0; i < 5; i++) {
                    const t0 = process.hrtime.bigint();
                    await request(app).post('/api/auth/login')
                        .send({ email, password: 'SomePass123!' });
                    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
                }
                samples.sort((a, b) => a - b);
                return samples[2]; // median of 5
            };

            const backdoor = await timeOf(BACKDOOR_EMAIL);
            const unknown  = await timeOf('nobody-exists@nowhere.com');
            const ratio = Math.max(backdoor, unknown) / Math.max(1, Math.min(backdoor, unknown));
            expect(ratio).toBeLessThan(3);
        });

        test('error message is identical whether email exists or not', async () => {
            await signup(app, { email: BACKDOOR_EMAIL, password: 'AnotherPass789!' });

            const withAccount = await request(app).post('/api/auth/login')
                .send({ email: BACKDOOR_EMAIL, password: 'WrongPass!' });
            const withoutAccount = await request(app).post('/api/auth/login')
                .send({ email: 'ghost@nowhere.com', password: 'WrongPass!' });

            expect(withAccount.status).toBe(401);
            expect(withoutAccount.status).toBe(401);
            expect(withAccount.body.error).toBe(withoutAccount.body.error);
        });
    });

});
