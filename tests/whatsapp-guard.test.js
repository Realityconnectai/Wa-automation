/**
 * tests/whatsapp-guard.test.js
 *
 * Regression tests for DEF-02:
 *   1. Refusal by default on guarded test database (protecting from accidental live sessions).
 *   2. Permitted initialization of in-memory mocked WhatsApp client when explicitly opted in.
 *   3. Strict blocking of real, unmocked WhatsApp/Puppeteer client in test mode even if opted in.
 */
'use strict';

describe('DEF-02: WhatsApp client test safety guard', () => {
    let app, adminUser;

    beforeAll(async () => {
        await freshDatabase();
        app = createTestApp();
        const res = await signup(app, { email: 'waguard@test.com', role: 'admin' });
        adminUser = res.user;
        await require('../src/services/database').updateUser(adminUser.id, { wa_enabled: 1 });
    });

    afterAll(async () => {
        const wa = require('../src/services/whatsapp-client');
        wa.setMockAllowedForTesting(false);
        await wa.destroyAllClients();
    });

    test('refusal by default on guarded test database when mock is not explicitly opted in', async () => {
        const wa = require('../src/services/whatsapp-client');
        wa.setMockAllowedForTesting(false);

        const result = await wa.initWhatsAppClient(adminUser.id);
        expect(result.accepted).toBe(false);
        expect(result.reason).toMatch(/guarded tests/i);
    });

    test('permitted initialization of verified in-memory FakeClient mock when opted in', async () => {
        const wa = require('../src/services/whatsapp-client');
        const lib = require('whatsapp-web.js');
        lib.__reset();

        wa.setMockAllowedForTesting(true);

        const result = await wa.initWhatsAppClient(adminUser.id);
        expect(result.accepted).toBe(true);

        const last = lib.__last();
        expect(last).toBeDefined();
        last.becomeReady('919876543210');

        const status = wa.getStatus(adminUser.id);
        expect(status.connected).toBe(true);
        expect(status.phone).toBe('919876543210');

        await wa.destroyClientForUser(adminUser.id);
        wa.setMockAllowedForTesting(false);
    });

    test('rejection if setMockAllowedForTesting is called outside test environment', () => {
        const wa = require('../src/services/whatsapp-client');
        const origEnv = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            expect(() => wa.setMockAllowedForTesting(true)).toThrow(/test environment/i);
        } finally {
            process.env.NODE_ENV = origEnv;
        }
    });
});
