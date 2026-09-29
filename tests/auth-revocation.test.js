/**
 * tests/auth-revocation.test.js — Password-change revocation and auth_version regression tests.
 *
 * Verifies:
 *   1. Existing token issued before password change is rejected.
 *   2. Password changed partway through a second.
 *   3. Fresh login and token issued after that change within the SAME second works immediately.
 *   4. No artificial delays or future-dated iat values needed.
 *   5. Legacy tokens without auth_version claim: work before password change, voided immediately after.
 *   6. Profile/user updates cannot tamper with auth_version fields.
 *   7. incrementAuthVersion invalidates all active sessions.
 */

const request = require('supertest');
const { createTestApp, freshDatabase, createUserDirect } = require('./setup');
const { createSessionToken } = require('../src/config/auth');
const { updateUser, getUserById, incrementAuthVersion } = require('../src/services/database');

describe('Password-Change Revocation & Auth Version Semantics', () => {
    let app;

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
    });

    test('reproduces same-second password change: old token fails, fresh token works immediately', async () => {
        const email = 'revocation-test@example.com';
        const initialPassword = 'InitialPassword123!';
        const newPassword = 'NewPassword456!';

        // 1. Create active user directly
        const { user } = await createUserDirect({
            email,
            password: initialPassword,
            status: 'active'
        });

        // 2. User logs in at timestamp T, receiving initial token (auth_version: 1)
        const loginRes1 = await request(app)
            .post('/api/auth/login')
            .send({ email, password: initialPassword });
        expect(loginRes1.status).toBe(200);

        const oldCookie = loginRes1.headers['set-cookie'][0].split(';')[0];

        // Verify old cookie works on /api/auth/me
        const meRes1 = await request(app)
            .get('/api/auth/me')
            .set('Cookie', oldCookie);
        expect(meRes1.status).toBe(200);
        expect(meRes1.body.data.email).toBe(email);

        // 3. User changes password via /api/auth/change-password
        // This atomically increments auth_version from 1 to 2
        const changeRes = await request(app)
            .post('/api/auth/change-password')
            .set('Cookie', oldCookie)
            .send({
                currentPassword: initialPassword,
                newPassword: newPassword
            });
        expect(changeRes.status).toBe(200);

        // 4. In the SAME second (immediately, no sleep/delay), user logs in with new password
        const loginRes2 = await request(app)
            .post('/api/auth/login')
            .send({ email, password: newPassword });
        expect(loginRes2.status).toBe(200);

        const freshCookie = loginRes2.headers['set-cookie'][0].split(';')[0];

        // 5. Old token MUST FAIL with 401
        const meResOld = await request(app)
            .get('/api/auth/me')
            .set('Cookie', oldCookie);
        expect(meResOld.status).toBe(401);
        expect(meResOld.body.code).toBe('AUTH_REQUIRED');

        // 6. Fresh token MUST WORK immediately with 200
        const meResFresh = await request(app)
            .get('/api/auth/me')
            .set('Cookie', freshCookie);
        expect(meResFresh.status).toBe(200);
        expect(meResFresh.body.data.email).toBe(email);

        // Verify database state: auth_version is 2
        const dbUser = await getUserById(user.id);
        expect(dbUser.auth_version).toBe(2);
    });

    test('handles legacy tokens without auth_version claim correctly', async () => {
        const email = 'legacy-token@example.com';
        const password = 'LegacyPass123!';

        const { user } = await createUserDirect({
            email,
            password,
            status: 'active'
        });

        // Mint a synthetic legacy token that lacks auth_version (simulating pre-migration token)
        const crypto = require('crypto');
        const { SECRET_PATH } = require('../src/config/paths');
        const fs = require('fs');
        const secret = (process.env.SESSION_SECRET || '').trim() || (fs.existsSync(SECRET_PATH) ? fs.readFileSync(SECRET_PATH, 'utf8').trim() : '');

        function mintLegacyToken(u) {
            const now = Date.now();
            const payload = {
                id: u.id,
                role: u.role,
                iat: now,
                exp: now + 7 * 24 * 60 * 60 * 1000
                // NOTE: No auth_version claim!
            };
            const b64 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
            return `${b64}.${sig}`;
        }

        const legacyToken = mintLegacyToken(user);
        const legacyCookie = `wa_session=${encodeURIComponent(legacyToken)}`;

        // Before password change (user.auth_version === 1): legacy token is accepted
        const resBefore = await request(app)
            .get('/api/auth/me')
            .set('Cookie', legacyCookie);
        expect(resBefore.status).toBe(200);
        expect(resBefore.body.data.email).toBe(email);

        // Password change occurs: auth_version increments to 2
        await updateUser(user.id, { password_hash: 'new_hash_123' });

        // After password change (user.auth_version === 2): legacy token is voided immediately
        const resAfter = await request(app)
            .get('/api/auth/me')
            .set('Cookie', legacyCookie);
        expect(resAfter.status).toBe(401);
        expect(resAfter.body.code).toBe('AUTH_REQUIRED');
    });

    test('public profile updates cannot tamper with auth_version', async () => {
        const { user } = await createUserDirect({
            email: 'profile-tamper@example.com',
            status: 'active'
        });

        expect(user.auth_version || 1).toBe(1);

        // Attempt to maliciously modify auth_version via updateUser
        await updateUser(user.id, {
            business_name: 'Legit Business',
            auth_version: 999,
            token_version: 999
        });

        const reloaded = await getUserById(user.id);
        expect(reloaded.business_name).toBe('Legit Business');
        // auth_version must remain untouched at 1
        expect(reloaded.auth_version).toBe(1);
    });

    test('incrementAuthVersion invalidates all active sessions immediately', async () => {
        const email = 'admin-revocation@example.com';
        const password = 'AdminPass123!';

        const { user } = await createUserDirect({
            email,
            password,
            status: 'active'
        });

        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ email, password });
        expect(loginRes.status).toBe(200);
        const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

        // Active session works
        const check1 = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(check1.status).toBe(200);

        // Admin or security action triggers incrementAuthVersion
        await incrementAuthVersion(user.id);

        // Active session is invalidated immediately
        const check2 = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(check2.status).toBe(401);
        expect(check2.body.code).toBe('AUTH_REQUIRED');
    });
});
