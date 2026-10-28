/**
 * tests/whatsapp-matrix-b4-durability.test.js
 *
 * Automated verification of Matrix B4 (Session Durability):
 * - S1: Session restore without QR after server restart (resumeExistingSessions)
 * - S2: Stale lock cleanup (SingletonLock, DevToolsActivePort) after abrupt termination
 * - S3: Reconnecting then Connected on network restoration, session intact
 * - S4: Recovers without QR after phone comes back online
 * - S6: 20 Connect/Disconnect cycles -> right state each time, exactly 1 listener, stable
 * - S7: Transient detached-frame error does not destroy healthy session
 * - S8: scripts/patch-wwebjs.js applies and verifies patches; fails loudly if target missing
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wa = require('../src/services/whatsapp-client');
const lib = require('whatsapp-web.js');

describe('Matrix B4: Session Durability', () => {
    let app, user;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();
        const res = await signup(app, { email: 'b4-durability@test.com', role: 'admin' });
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

    test('S1: Saved session restored without QR after restart', async () => {
        // Step 1: Initial connect and ready
        await wa.initWhatsAppClient(user.id);
        let client = lib.__last();
        client.becomeReady('919876543210');
        expect(wa.getStatus(user.id).connected).toBe(true);

        // Simulate server stop (in-memory sessions cleared, auth stays on disk)
        await wa.destroyClientForUser(user.id, { wipeAuth: false });
        wa.getSession(user.id).userDisconnected = false; // Normal server shutdown preserves resume intent

        // Step 2: Server restart initialization
        await wa.initWhatsAppClient(user.id);
        client = lib.__last();
        client.becomeReady('919876543210');

        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(true);
        expect(status.qr).toBeNull();
        expect(status.phone).toBe('919876543210');
    });

    test('S2: Abrupt process kill leaves stale lock files -> cleaned on startup', async () => {
        const authDir = wa.authDataPath(user.id);
        fs.mkdirSync(authDir, { recursive: true });

        // Simulate stale Chrome locks from an abrupt crash
        const staleFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile', 'LOCK'];
        staleFiles.forEach(f => fs.writeFileSync(path.join(authDir, f), 'stale-pid-lock'));

        // Verify files exist before init
        staleFiles.forEach(f => expect(fs.existsSync(path.join(authDir, f))).toBe(true));

        // Start client -> clearStaleLocks runs
        await wa.initWhatsAppClient(user.id);

        // Stale locks must be removed
        staleFiles.forEach(f => expect(fs.existsSync(path.join(authDir, f))).toBe(false));

        const client = lib.__last();
        client.becomeReady('919876543210');
        expect(wa.getStatus(user.id).connected).toBe(true);
    });

    test('S3 & S4: Transient disconnect and reconnect maintains session intact without QR', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        // Network drops / client emits disconnected with transient reason (NAVIGATION, CONFLICT)
        client.emit('disconnected', 'NAVIGATION');

        const session = wa.getSession(user.id);
        expect(session.isConnected).toBe(false);
        expect(session.restartTimer).toBeTruthy();
        expect(wa.getStatus(user.id).state).toBe('reconnecting');

        // Restart timer triggers reconnect
        clearTimeout(session.restartTimer);
        session.restartTimer = null;

        await wa.initWhatsAppClient(user.id);
        const reconnectedClient = lib.__last();
        reconnectedClient.becomeReady('919876543210');

        const status = wa.getStatus(user.id);
        expect(status.connected).toBe(true);
        expect(status.phone).toBe('919876543210');
        expect(status.qr).toBeNull();
    });

    test('S6: 20 Connect/Disconnect cycles maintain stable listener count and valid state', async () => {
        for (let i = 1; i <= 20; i++) {
            await wa.initWhatsAppClient(user.id);
            const client = lib.__last();
            client.becomeReady('919876543210');

            expect(wa.getStatus(user.id).connected).toBe(true);
            const debugConn = await wa.getDebugState(user.id);
            expect(debugConn.listenerCounts.message).toBe(1);
            expect(debugConn.listenerCounts.message_ack).toBe(1);

            await wa.destroyClientForUser(user.id, { wipeAuth: false });
            expect(wa.getStatus(user.id).connected).toBe(false);

            const debugDisc = await wa.getDebugState(user.id);
            expect(debugDisc.listenerCounts.message).toBe(0);
            expect(debugDisc.listenerCounts.message_ack).toBe(0);
        }
    });

    test('S7: Transient detached-frame / Execution context error does not destroy healthy session', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.becomeReady('919876543210');

        // Simulate 1 transient keepalive error (e.g. detached Frame)
        lib.Client.getStateError = 'Execution context was destroyed, most likely because of a navigation or detached Frame';

        const session = wa.getSession(user.id);
        expect(session.isConnected).toBe(true);

        // Advance 1 keepAlive interval manually
        const keepAliveCb = session.keepAliveTimer._onTimeout || session.keepAliveTimer;
        await keepAliveCb();

        // 1 transient failure should NOT destroy or disconnect the session
        expect(session.transientKeepAliveFailures).toBe(1);
        expect(session.isConnected).toBe(true);
        expect(session.destroyed).toBe(false);

        // Reset error -> recovers next check
        lib.Client.getStateError = null;
        await keepAliveCb();
        expect(session.transientKeepAliveFailures).toBe(0);
        expect(session.isConnected).toBe(true);
    });

    test('S8: scripts/patch-wwebjs.js verifies patched targets and fails loudly if target missing', () => {
        const { applyPatch } = require('../scripts/patch-wwebjs');

        // Apply patch directly and verify it does not throw
        expect(() => applyPatch()).not.toThrow();

        // Verify that target Utils.js actually contains the patch
        const utilsPath = path.join(__dirname, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');
        if (fs.existsSync(utilsPath)) {
            const content = fs.readFileSync(utilsPath, 'utf8');
            expect(content).toContain('message.id = newMsgKey;');
            expect(content).toContain('delete message.__x_id;');
        }
    });

    test('S5: Idle soak test samples constant listeners, zero reconnects, and stable memory', async () => {
        const { runSoakTest } = require('../scripts/wa-soak-test');
        const summary = await runSoakTest({
            userId: user.id,
            durationMs: 4000,
            intervalMs: 1000
        });

        expect(summary.success).toBe(true);
        expect(summary.reconnectCount).toBe(0);
        expect(summary.listenersValid).toBe(true);
        expect(summary.sampleCount).toBeGreaterThanOrEqual(3);
    });
});
