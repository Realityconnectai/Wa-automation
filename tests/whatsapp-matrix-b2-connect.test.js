/**
 * tests/whatsapp-matrix-b2-connect.test.js
 *
 * Automated verification of Matrix B2 (Connect and Status Truthfulness):
 * - C1: Saved session, Connect -> Connecting, then Connected only after `ready`; no QR
 * - C2: Credentials on disk but no running client -> UI must not show Connected
 * - C3: Linked number -> Matches active client
 * - C4: Failed or timed-out init -> Connection Error or Reconnecting; failed instance cleaned up; UI reflects it
 * - C5: Late response from an older request -> Cannot overwrite newer state
 * - C6: Stale Connected threshold -> Stops saying Connected within <= 35s via cached check (Decision C6)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wa = require('../src/services/whatsapp-client');
const lib = require('whatsapp-web.js');

describe('Matrix B2: Connect and Status Truthfulness', () => {
    let app, user;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();
        const res = await signup(app, { email: 'b2-connect@test.com', role: 'admin' });
        user = res.user;
        await require('../src/services/database').updateUser(user.id, { wa_enabled: 1 });
    });

    beforeEach(() => {
        lib.__reset();
        wa.setMockAllowedForTesting(true);
    });

    afterEach(async () => {
        await wa.destroyClientForUser(user.id);
        wa.setMockAllowedForTesting(false);
    });

    afterAll(async () => {
        const { closePool } = require('../src/services/db-pool');
        await closePool().catch(() => {});
    });

    test('C1: Connect with saved session -> transitions connecting to connected only after ready, without QR', async () => {
        // Start client
        await wa.initWhatsAppClient(user.id);
        const statusDuringInit = wa.getStatus(user.id);
        expect(statusDuringInit.state).toBe('connecting');
        expect(statusDuringInit.connected).toBe(false);
        expect(statusDuringInit.qr).toBeNull();

        // Client becomes ready
        const client = lib.__last();
        client.becomeReady('919876543210');

        const statusAfterReady = wa.getStatus(user.id);
        expect(statusAfterReady.state).toBe('connected');
        expect(statusAfterReady.connected).toBe(true);
        expect(statusAfterReady.phone).toBe('919876543210');
        expect(statusAfterReady.qr).toBeNull();
    });

    test('C2: Credentials on disk but no running client -> UI must NOT show Connected', () => {
        // Create fake auth folder on disk
        const authDir = wa.authDataPath(user.id);
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(path.join(authDir, 'session-test.json'), '{"data":"saved"}');

        // Status without running client
        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(false);
        expect(status.state).toBe('disconnected');
        expect(status.phone).toBeNull();
    });

    test('C3: Linked number matches active client', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        const testPhone = '919876543210';
        client.becomeReady(testPhone);

        const status = wa.getStatus(user.id);
        expect(status.phone).toBe(testPhone);

        const debug = await wa.getDebugState(user.id);
        expect(debug.linkedNumber).toBe('9198****3210');
    });

    test('C4: Failed client initialization cleans up instance and sets error state', async () => {
        // Simulate client.initialize failure
        const origInit = lib.Client.prototype.initialize;
        lib.Client.prototype.initialize = async function () {
            throw new Error('Chromium launch failed');
        };

        try {
            await wa.initWhatsAppClient(user.id);
            // Allow async queue processing
            await new Promise(r => setTimeout(r, 100));

            const status = wa.getStatus(user.id);
            expect(status.connected).toBe(false);
            expect(['error', 'reconnecting']).toContain(status.state);
            expect(status.error).toContain('Chromium launch failed');

            const session = wa.getSession(user.id);
            expect(session.client).toBeNull();
        } finally {
            lib.Client.prototype.initialize = origInit;
        }
    });

    test('C5: Destroyed session cannot be overwritten by older late async responses', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();

        // User disconnects
        await wa.destroyClientForUser(user.id);
        const statusAfterDestroy = wa.getStatus(user.id);
        expect(statusAfterDestroy.state).toBe('disconnected');
        expect(statusAfterDestroy.connected).toBe(false);

        // A late event arrives from old client
        client.becomeReady('919876543210');

        // State remains disconnected
        const statusLate = wa.getStatus(user.id);
        expect(statusLate.state).toBe('disconnected');
        expect(statusLate.connected).toBe(false);
    });

    test('C6: UI stops reporting Connected within <= 35s when client connection drops (Decision C6)', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        let status = wa.getStatus(user.id);
        expect(status.connected).toBe(true);

        // Network drops / client state changes to DISCONNECTED
        client.state = 'DISCONNECTED';

        const session = wa.getSession(user.id);
        // Simulate stale connection exceeding 35s
        session.staleConnectedSince = Date.now() - 36000;

        // getStatus immediately detects stale connection and stops reporting connected
        status = wa.getStatus(user.id);
        expect(status.connected).toBe(false);
        expect(status.state).not.toBe('connected');
    });
});
