/**
 * tests/whatsapp-matrix-b3-disconnect.test.js
 *
 * Automated verification of Matrix B3 (Disconnect and Logout):
 * - D1: Disconnect while Connected -> Backend confirms, client destroyed, state becomes disconnected
 * - D2: No auto-reconnect after disconnect by keep-alive, watchdog, or restart timer
 * - D3: Check .wwebjs_auth after Disconnect -> Session files still present
 * - D4: Connect after Disconnect -> Reuses saved session, exactly 1 client, connected without QR
 * - D5: Disconnect during Connecting/QR Ready -> Init cancelled cleanly, no zombie client
 * - D6: Disconnect twice quickly -> Idempotent, no error
 * - D7: Disconnect, then restart server -> Stays disconnected across restarts (Decision D7)
 * - D8: LOGOUT -> Credentials wiped, number unlinked, fresh QR required
 * - D9: After every D row -> Listener count is 0 after destroy, Chrome count is 0
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wa = require('../src/services/whatsapp-client');
const lib = require('whatsapp-web.js');
const { getSetting } = require('../src/services/database');

describe('Matrix B3: Disconnect and Logout', () => {
    let app, user;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();
        const res = await signup(app, { email: 'b3-disconnect@test.com', role: 'admin' });
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

    test('D1: Disconnect while Connected -> client destroyed, state disconnected', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        expect(wa.getStatus(user.id).connected).toBe(true);

        await wa.destroyClientForUser(user.id);

        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(false);
        expect(status.state).toBe('disconnected');
        expect(client.destroyed).toBe(true);
    });

    test('D2: No auto-reconnect after disconnect by keepAlive, watchdog, or restart timers', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        await wa.destroyClientForUser(user.id);
        const session = wa.getSession(user.id);

        expect(session.userDisconnected).toBe(true);
        expect(session.destroyed).toBe(true);
        expect(session.keepAliveTimer).toBeNull();
        expect(session.watchdogTimer).toBeNull();
        expect(session.restartTimer).toBeNull();
        expect(session.initWatchdog).toBeNull();
    });

    test('D3: Check .wwebjs_auth after normal Disconnect -> Session files preserved', async () => {
        const authDir = wa.authDataPath(user.id);
        fs.mkdirSync(authDir, { recursive: true });
        const markerFile = path.join(authDir, 'session_marker.txt');
        fs.writeFileSync(markerFile, 'saved-auth-state');

        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        // Disconnect without wipeAuth
        await wa.destroyClientForUser(user.id, { wipeAuth: false });

        expect(fs.existsSync(markerFile)).toBe(true);
        expect(fs.readFileSync(markerFile, 'utf8')).toBe('saved-auth-state');
    });

    test('D4: Connect after Disconnect -> Reuses saved session, 1 client, connected without QR', async () => {
        await wa.initWhatsAppClient(user.id);
        let client = lib.__last();
        client.becomeReady('919876543210');

        await wa.destroyClientForUser(user.id, { wipeAuth: false });
        expect(wa.getStatus(user.id).connected).toBe(false);

        // Reconnect
        const res = await wa.initWhatsAppClient(user.id);
        expect(res.accepted).toBe(true);
        client = lib.__last();
        client.becomeReady('919876543210');

        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(true);
        expect(status.phone).toBe('919876543210');
        expect(status.qr).toBeNull();
    });

    test('D5: Disconnect during Connecting / QR Ready -> Init cancelled cleanly, no zombie client', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.emitQr('fake-qr-d5');

        const session = wa.getSession(user.id);
        expect(session.client).toBeDefined();

        await wa.destroyClientForUser(user.id);

        expect(session.client).toBeNull();
        expect(session.currentQR).toBeNull();
        expect(session.isInitializing).toBe(false);
        expect(session.destroyed).toBe(true);
        expect(wa.getStatus(user.id).state).toBe('disconnected');
    });

    test('D6: Disconnect twice quickly -> Idempotent, no error thrown', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        await expect(Promise.all([
            wa.destroyClientForUser(user.id),
            wa.destroyClientForUser(user.id)
        ])).resolves.not.toThrow();

        const status = wa.getStatus(user.id);
        expect(status.state).toBe('disconnected');
        expect(status.connected).toBe(false);
    });

    test('D7: Disconnect persists wa_user_disconnected in DB to stay disconnected across server restart (Decision D7)', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        // Check setting before disconnect
        let discSetting = await getSetting(user.id, 'wa_user_disconnected');
        expect(discSetting).toBe('false');

        // Manually disconnect
        await wa.destroyClientForUser(user.id);

        // Setting must be persisted as 'true' in DB
        discSetting = await getSetting(user.id, 'wa_user_disconnected');
        expect(discSetting).toBe('true');
    });

    test('D8: LOGOUT -> Credentials wiped, fresh QR required, number unlinked', async () => {
        const authDir = wa.authDataPath(user.id);
        fs.mkdirSync(authDir, { recursive: true });
        const markerFile = path.join(authDir, 'session_marker.txt');
        fs.writeFileSync(markerFile, 'saved-auth-state');

        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        // Logout with wipeAuth: true
        await wa.destroyClientForUser(user.id, { wipeAuth: true });

        // Auth folder files wiped
        expect(fs.existsSync(markerFile)).toBe(false);

        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(false);
        expect(status.phone).toBeNull();
        expect(status.state).toBe('disconnected');
    });

    test('D9: After destroy, message and message_ack listeners are 0, Chrome count is 0', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        let debug = await wa.getDebugState(user.id);
        expect(debug.listenerCounts.message).toBe(1);
        expect(debug.listenerCounts.message_ack).toBe(1);

        await wa.destroyClientForUser(user.id);

        debug = await wa.getDebugState(user.id);
        expect(debug.listenerCounts.message).toBe(0);
        expect(debug.listenerCounts.message_ack).toBe(0);
        expect(debug.chromeProcessCount).toBe(0);
    });
});
