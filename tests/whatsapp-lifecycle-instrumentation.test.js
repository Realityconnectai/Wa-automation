/**
 * tests/whatsapp-lifecycle-instrumentation.test.js
 *
 * Verifies Phase A instrumentation:
 * 1. getDebugState contract and fields.
 * 2. GET /api/whatsapp/debug route guarding (WA_DEBUG=true) and tenant scoping.
 * 3. scripts/wa-observe.js transition detection and formatting.
 */
'use strict';

const request = require('supertest');
const wa = require('../src/services/whatsapp-client');
const lib = require('whatsapp-web.js');
const { detectTransition, formatSample } = require('../scripts/wa-observe');

describe('Phase A: WhatsApp Lifecycle Instrumentation', () => {
    let app, adminUser, regularUser, adminCookie, regularCookie;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();

        const aRes = await signup(app, { email: 'admin-debug@test.com', role: 'admin' });
        adminUser = aRes.user;
        adminCookie = aRes.cookie;
        await require('../src/services/database').updateUser(adminUser.id, { wa_enabled: 1 });

        const rRes = await signup(app, { email: 'user-debug@test.com', role: 'agent' });
        regularUser = rRes.user;
        regularCookie = rRes.cookie;
    });

    afterAll(async () => {
        wa.setMockAllowedForTesting(false);
        await wa.destroyAllClients();
    });

    beforeEach(() => {
        lib.__reset();
        process.env.WA_DEBUG = 'true';
    });

    afterEach(async () => {
        delete process.env.WA_DEBUG;
        await wa.destroyAllClients();
    });

    test('getDebugState returns all expected lifecycle properties for a disconnected user', async () => {
        const debug = await wa.getDebugState(adminUser.id);
        expect(debug).toHaveProperty('storedState');
        expect(debug.storedState.state).toBe('disconnected');
        expect(debug.storedState.connected).toBe(false);
        expect(debug.liveState).toBeNull();
        expect(debug.readyFired).toBe(false);
        expect(debug.linkedNumber).toBeNull();
        expect(debug.listenerCounts).toEqual({ message: 0, message_ack: 0 });
        expect(debug.activeTimers).toEqual({
            keepAlive: false,
            watchdog: false,
            initWatchdog: false,
            qrTimeout: false,
            restartTimer: false,
            hibernation: false
        });
        expect(debug.userDisconnected).toBe(false);
        expect(debug.isInitializing).toBe(false);
        expect(typeof debug.chromeProcessCount).toBe('number');
    });

    test('getDebugState returns live state, masked phone, and listener counts when connected', async () => {
        wa.setMockAllowedForTesting(true);
        const initRes = await wa.initWhatsAppClient(adminUser.id);
        expect(initRes.accepted).toBe(true);

        const client = lib.__last();
        expect(client).toBeDefined();
        client.becomeReady('919876543210');

        const debug = await wa.getDebugState(adminUser.id);
        expect(debug.storedState.connected).toBe(true);
        expect(debug.liveState).toBe('CONNECTED');
        expect(debug.readyFired).toBe(true);
        expect(debug.linkedNumber).toBe('9198****3210');
        expect(debug.listenerCounts.message).toBe(1);
        expect(debug.listenerCounts.message_ack).toBe(1);
        expect(debug.activeTimers.keepAlive).toBe(true);
        expect(debug.activeTimers.watchdog).toBe(true);
    });

    test('GET /api/whatsapp/debug is forbidden when WA_DEBUG is not set to true', async () => {
        process.env.WA_DEBUG = 'false';
        const res = await request(app)
            .get('/api/whatsapp/debug')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DEBUG_DISABLED');
    });

    test('GET /api/whatsapp/debug returns 200 with tenant-scoped debug data when WA_DEBUG=true', async () => {
        process.env.WA_DEBUG = 'true';
        wa.setMockAllowedForTesting(true);
        await wa.initWhatsAppClient(adminUser.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        const resAdmin = await request(app)
            .get('/api/whatsapp/debug')
            .set('Cookie', adminCookie);

        expect(resAdmin.status).toBe(200);
        expect(resAdmin.body.success).toBe(true);
        expect(resAdmin.body.data.linkedNumber).toBe('9198****3210');
        expect(resAdmin.body.data.liveState).toBe('CONNECTED');

        // Regular user should have distinct tenant state
        const resUser = await request(app)
            .get('/api/whatsapp/debug')
            .set('Cookie', regularCookie);

        expect(resUser.status).toBe(200);
        expect(resUser.body.data.storedState.connected).toBe(false);
        expect(resUser.body.data.linkedNumber).toBeNull();
    });

    test('wa-observe detectTransition properly identifies lifecycle state changes', () => {
        const prev = {
            status: { state: 'connecting', connected: false, phone: null },
            debug: { liveState: null, readyFired: false, chromeProcessCount: 1, activeTimers: { keepAlive: false } }
        };
        const curr = {
            status: { state: 'connected', connected: true, phone: '919876543210' },
            debug: { liveState: 'CONNECTED', readyFired: true, chromeProcessCount: 2, activeTimers: { keepAlive: true } }
        };

        const transition = detectTransition(prev, curr);
        expect(transition).toContain('status.state: connecting -> connected');
        expect(transition).toContain('status.connected: false -> true');
        expect(transition).toContain('liveState: null -> CONNECTED');
        expect(transition).toContain('readyFired: false -> true');
        expect(transition).toContain('chromeCount: 1 -> 2');
        expect(transition).toContain('timers: [none] -> [keepAlive]');
    });

    test('wa-observe formatSample creates valid masked observation string', () => {
        const sampleStr = formatSample('2026-10-28T00:00:00.000Z', { state: 'connected', connected: true, phone: '919876543210' }, {
            liveState: 'CONNECTED',
            readyFired: true,
            listenerCounts: { message: 1, message_ack: 1 },
            chromeProcessCount: 2,
            activeTimers: { keepAlive: true, watchdog: true }
        });

        expect(sampleStr).toContain('[SAMPLE]');
        expect(sampleStr).toContain('state=connected');
        expect(sampleStr).toContain('liveState=CONNECTED');
        expect(sampleStr).toContain('timers=[keepAlive,watchdog]');
    });
});
