/**
 * tests/whatsapp-matrix-b1-qr.test.js
 *
 * Automated verification of Matrix B1 (QR Lifecycle):
 * - Q1: Fresh user, no saved session -> QR generated & visible through SSE/REST
 * - Q2: Connect after QR already emitted -> currentQR delivered immediately, never blank
 * - Q3: Reconnect/reload while QR is showing -> QR returns, exactly 1 client instance
 * - Q4: QR rotation and 180s idle timeout -> clean teardown with retry state, not frozen
 * - Q5: Two browser tabs -> same status and QR in both, 1 client
 * - Q6: SSE drops and reconnects -> recovers without manual refresh
 * - Q8: Double connect click -> exactly one init, no duplicate client
 * - Q9: Frontend loading state transitions immediately on qr event
 */
'use strict';

const wa = require('../src/services/whatsapp-client');
const lib = require('whatsapp-web.js');

describe('Matrix B1: QR Lifecycle Verification', () => {
    let app, user;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();
        const res = await signup(app, { email: 'b1-qr@test.com', role: 'admin' });
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

    async function waitForQR(userId, timeoutMs = 2000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const status = wa.getStatus(userId);
            if (status.qr) return status;
            await new Promise(r => setTimeout(r, 20));
        }
        return wa.getStatus(userId);
    }

    test('Q1: Fresh user, Connect -> QR generated within seconds and visible in REST/SSE', async () => {
        const initRes = await wa.initWhatsAppClient(user.id);
        expect(initRes.accepted).toBe(true);

        const client = lib.__last();
        expect(client).toBeDefined();

        client.emitQr('test-qr-payload-q1');
        const status = await waitForQR(user.id);

        expect(status.state).toBe('qr_ready');
        expect(status.qr).toMatch(/^data:image\/png;base64,/);
    });

    test('Q2: Open status / connect SSE after QR already emitted -> currentQR shown immediately', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.emitQr('test-qr-payload-q2');
        const status = await waitForQR(user.id);

        expect(status.qr).toBeTruthy();
        expect(status.state).toBe('qr_ready');

        // Test SSE late arrival receives QR immediately
        let sseDelivered = null;
        const fakeReq = { on: jest.fn(), headers: {} };
        const fakeRes = {
            setHeader: jest.fn(),
            write: jest.fn(data => {
                if (data.includes('"type":"qr"')) sseDelivered = JSON.parse(data.replace('data: ', '').trim());
            }),
            on: jest.fn(),
            end: jest.fn()
        };

        wa.addSSEClient(user.id, fakeReq, fakeRes);
        expect(sseDelivered).toBeDefined();
        expect(sseDelivered.type).toBe('qr');
        expect(sseDelivered.data).toBe(status.qr);
    });

    test('Q3: Page reload while QR is showing -> QR returns, exactly 1 client instance', async () => {
        await wa.initWhatsAppClient(user.id);
        const client1 = lib.__last();
        client1.emitQr('test-qr-payload-q3');
        await waitForQR(user.id);

        expect(lib.__instances.length).toBe(1);

        // Simulated reload: second initWhatsAppClient call
        const secondInit = await wa.initWhatsAppClient(user.id);
        expect(secondInit.alreadyStarting).toBe(true);
        expect(lib.__instances.length).toBe(1);

        const status = wa.getStatus(user.id);
        expect(status.qr).toMatch(/^data:image\/png;base64,/);
    });

    test('Q4: QR timeout after 180s -> tears down idle client and clears QR', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.emitQr('test-qr-payload-q4');

        const session = wa.getSession(user.id);
        expect(session.qrTimeout).toBeTruthy();

        // Advance 180 seconds manually by firing the timer callback
        const timerCallback = session.qrTimeout._onTimeout || session.qrTimeout;
        clearTimeout(session.qrTimeout);
        session.qrTimeout = null;

        // Manually invoke timeout teardown
        await timerCallback();

        const status = wa.getStatus(user.id);
        expect(status.qr).toBeNull();
        expect(session.client).toBeNull();
    });

    test('Q5: Two browser tabs -> same status and QR in both, backed by one client', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.emitQr('test-qr-payload-q5');
        await waitForQR(user.id);

        const tab1Events = [];
        const tab2Events = [];

        const tab1Res = { setHeader: jest.fn(), write: jest.fn(d => tab1Events.push(d)), on: jest.fn(), end: jest.fn() };
        const tab2Res = { setHeader: jest.fn(), write: jest.fn(d => tab2Events.push(d)), on: jest.fn(), end: jest.fn() };

        wa.addSSEClient(user.id, { on: jest.fn(), headers: {} }, tab1Res);
        wa.addSSEClient(user.id, { on: jest.fn(), headers: {} }, tab2Res);

        expect(lib.__instances.length).toBe(1);
        expect(tab1Events.some(e => e.includes('"type":"qr"'))).toBe(true);
        expect(tab2Events.some(e => e.includes('"type":"qr"'))).toBe(true);
    });

    test('Q6: SSE drops and reconnects -> recovers state cleanly', async () => {
        await wa.initWhatsAppClient(user.id);
        const client = lib.__last();
        client.emitQr('test-qr-payload-q6');
        await waitForQR(user.id);

        let closeHandler;
        const fakeReq = {
            on: jest.fn((evt, cb) => { if (evt === 'close') closeHandler = cb; }),
            headers: {}
        };
        const fakeRes = { setHeader: jest.fn(), write: jest.fn(), on: jest.fn(), end: jest.fn() };

        wa.addSSEClient(user.id, fakeReq, fakeRes);
        const session = wa.getSession(user.id);
        expect(session.sseClients.length).toBe(1);

        // Simulate connection drop
        closeHandler();
        expect(session.sseClients.length).toBe(0);

        // Reconnect
        const tab2Events = [];
        wa.addSSEClient(user.id, { on: jest.fn(), headers: {} }, {
            setHeader: jest.fn(),
            write: jest.fn(d => tab2Events.push(d)),
            on: jest.fn(),
            end: jest.fn()
        });
        expect(session.sseClients.length).toBe(1);
        expect(tab2Events.some(e => e.includes('"type":"qr"'))).toBe(true);
    });

    test('Q8: Click Connect twice quickly -> exactly one init, no duplicate client', async () => {
        const [res1, res2] = await Promise.all([
            wa.initWhatsAppClient(user.id),
            wa.initWhatsAppClient(user.id)
        ]);

        expect(res1.accepted).toBe(true);
        expect(res2.accepted).toBe(true);
        expect(res2.alreadyStarting).toBe(true);
        expect(lib.__instances.length).toBe(1);
    });

    test('Q9: Frontend loading state transitions immediately on qr event', async () => {
        await wa.initWhatsAppClient(user.id);
        const statusBefore = wa.getStatus(user.id);
        expect(statusBefore.state).toBe('connecting');

        const client = lib.__last();
        client.emitQr('test-payload-q9');
        const statusAfter = await waitForQR(user.id);

        expect(statusAfter.state).toBe('qr_ready');
        expect(statusAfter.qr).toBeTruthy();
    });
});
