/**
 * tests/setup.js — shared test environment.
 *
 * Two rules this file exists to enforce:
 *
 *  1. Tests must never touch the developer's real database, WhatsApp
 *     sessions, or session secret. PERSIST_ROOT is redirected to a
 *     throwaway directory before any module that reads it is loaded.
 *  2. Tests must exercise the real application. helpers here build the app
 *     via src/app.js — the same middleware order, headers and error handler
 *     that ship — rather than assembling a simplified Express app that could
 *     pass while production is broken.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Scrub production-only env vars before any module load ──────────────────
delete process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;

process.env.NODE_ENV = 'test';

// A unique directory per worker so `jest --maxWorkers` doesn't have two
// processes fighting over one SQLite file.
const TEST_ROOT = path.join(
    os.tmpdir(),
    `wa-tests-${process.pid}-${process.env.JEST_WORKER_ID || '1'}`
);

process.env.PERSIST_ROOT = TEST_ROOT;
process.env.SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(88);
process.env.GEMINI_API_KEY = '';
process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS = '5';
process.env.DISABLE_RATE_LIMITS = 'true';
process.env.BCRYPT_ROUNDS = '4';

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function rmrf(dir) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            return;
        } catch (e) {
            if (attempt === 4) {
                console.warn(`⚠️ Could not remove test directory ${dir}: ${e.message}`);
            }
        }
    }
}

let dbGeneration = 0;

/** Wipes all test state and returns a fresh, initialised database. */
async function freshDatabase() {
    try {
        require('../src/services/database').stopPersistence();
    } catch (e) { /* not loaded yet */ }

    // Tear down anything holding a timer, a socket, or a Chrome stub.
    try { require('../src/services/whatsapp-client').destroyAllClients(); } catch (e) {}
    try { await require('../src/services/outreach').cancelAllOutreachJobs(); } catch (e) {}
    try { require('../src/services/lead-analyzer').clearPendingAutoAnalyses(); } catch (e) {}
    try { require('../src/services/scheduler').stopScheduler(); } catch (e) {}
    try { require('whatsapp-web.js').__reset(); } catch (e) {}

    dbGeneration++;
    const root = path.join(TEST_ROOT, `gen${dbGeneration}`);
    ensureDir(path.join(root, 'data'));
    process.env.PERSIST_ROOT = root;

    for (const mod of [
        '../src/services/database',
        '../src/config/auth',
        '../src/utils/validate',
        '../src/middleware/auth',
        '../src/middleware/rateLimit',
        '../src/utils/errors',
        '../src/routes/auth',
        '../src/routes/api',
        '../src/routes/admin',
        '../src/routes/calendar',
        '../src/routes/appointments',
        '../src/services/whatsapp-client',
        '../src/services/chatbot',
        '../src/services/scheduler',
        '../src/services/outreach',
        '../src/services/lead-analyzer',
        '../src/services/business',
        '../src/services/ai',
        '../src/services/gemini-client',
        '../src/services/appointment-reminders',
        '../src/services/availability',
        '../src/services/calendar-sync',
        '../src/services/google-calendar',
        '../src/utils/metrics',
        '../src/utils/conversation-queue',
        '../src/utils/logger',
        '../src/config/app',
        '../src/config/paths'
    ]) {
        try { delete require.cache[require.resolve(mod)]; } catch (_) { /* not loaded yet — safe to ignore */ }
    }

    const db = require('../src/services/database');
    await db.initDatabase();

    if (process.env.DATABASE_URL) {
        const { validateTestDatabaseTarget, verifyConnectedDatabase } = require('../src/utils/test-db-guard');
        const { dbName } = validateTestDatabaseTarget({
            connectionString: process.env.DATABASE_URL,
            env: process.env,
            requireDestructiveOptIn: true
        });

        const { getPool } = require('../src/services/db-pool');
        const p = getPool();
        if (p) {
            // Verify connected database identity matches the authorized test database
            await verifyConnectedDatabase(p, dbName);

            await p.query('DELETE FROM users');

            // Verify no orphaned rows remain in any application table
            const appTables = [
                'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
                'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
                'google_calendar_accounts', 'google_calendar_synced_events',
                'availability_settings', 'appointments'
            ];
            for (const table of appTables) {
                const check = await p.query(`SELECT COUNT(*) as count FROM ${table}`);
                const count = Number(check.rows[0]?.count || 0);
                if (count !== 0) {
                    throw new Error(`Test isolation broken: table "${table}" has ${count} non-user-owned or orphaned row(s) after reset.`);
                }
            }
        }
    }

    const existing = await db.countUsers();
    if (existing !== 0) {
        throw new Error(`Test isolation broken: fresh database already contains ${existing} user(s) at ${root}`);
    }

    return db;
}

/** Builds the real Express app. */
function createTestApp() {
    const { createApp } = require('../src/config/app');
    return createApp();
}

/** Signs up a user through the real HTTP route and returns their cookie. */
async function signup(agentOrApp, { email, password = 'ValidPass123!', businessName, ownerName, autoApprove = true } = {}) {
    const request = require('supertest');
    const res = await request(agentOrApp)
        .post('/api/auth/signup')
        .send({ email, password, businessName, ownerName });
    if (res.status !== 200) {
        throw new Error(`signup failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    let user = res.body.data;
    let cookie = null;

    if (res.headers['set-cookie'] && res.headers['set-cookie'][0]) {
        cookie = res.headers['set-cookie'][0].split(';')[0];
    } else if (autoApprove && user) {
        const { updateUser, getUserById } = require('../src/services/database');
        const { createSessionToken } = require('../src/config/auth');
        await updateUser(user.id, { status: 'active', wa_enabled: 1 });
        user = await getUserById(user.id);
        cookie = `wa_session=${encodeURIComponent(createSessionToken(user))}`;
    }

    return {
        user,
        cookie,
        password,
        rawResponse: res
    };
}

/** Creates a user directly in the database (faster; no HTTP round-trip). */
async function createUserDirect(overrides = {}) {
    const { createUser } = require('../src/services/database');
    const { hashPassword, createSessionToken } = require('../src/config/auth');
    const email = overrides.email || `u${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = overrides.password || 'ValidPass123!';
    const user = await createUser({
        email,
        passwordHash: await hashPassword(password),
        businessName: overrides.businessName || 'Test Business',
        ownerName: overrides.ownerName || 'Test Owner',
        status: overrides.status || 'active'
    });
    return {
        user,
        password,
        cookie: `wa_session=${encodeURIComponent(createSessionToken(user))}`
    };
}

/** Runs `fn` with the rate limiters actually enabled, then restores. */
async function withRateLimits(fn) {
    const previous = process.env.DISABLE_RATE_LIMITS;
    process.env.DISABLE_RATE_LIMITS = 'false';
    try {
        require('../src/middleware/rateLimit').clearBuckets();
        return await fn();
    } finally {
        process.env.DISABLE_RATE_LIMITS = previous;
        require('../src/middleware/rateLimit').clearBuckets();
    }
}

global.TEST_ROOT = TEST_ROOT;
global.freshDatabase = freshDatabase;
global.createTestApp = createTestApp;
global.signup = signup;
global.createUserDirect = createUserDirect;
global.withRateLimits = withRateLimits;

module.exports = {
    TEST_ROOT,
    freshDatabase,
    createTestApp,
    signup,
    createUserDirect,
    withRateLimits
};

if (typeof afterAll === 'function') {
    afterAll(async () => {
        try { require('../src/services/database').stopPersistence(); } catch (e) {}
        try { await require('../src/services/whatsapp-client').destroyAllClients(); } catch (e) {}
        try { await require('../src/services/outreach').cancelAllOutreachJobs(); } catch (e) {}
        try { require('../src/services/lead-analyzer').clearPendingAutoAnalyses(); } catch (e) {}
        try { require('../src/services/scheduler').stopScheduler(); } catch (e) {}
        try { require('../src/services/db-pool').closePool().catch(() => {}); } catch (e) {}
        rmrf(TEST_ROOT);
    });
}

if (typeof jest !== 'undefined' && typeof jest.setTimeout === 'function') {
    jest.setTimeout(30000);
}
