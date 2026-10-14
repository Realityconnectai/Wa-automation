'use strict';

describe('guarded test database WhatsApp safety', () => {
    test('admin client initialization is refused before a client is created', async () => {
        const wa = require('../src/services/whatsapp-client');
        const whatsapp = require('whatsapp-web.js');
        const result = await wa.initWhatsAppClient(1);

        expect(result).toEqual(expect.objectContaining({ accepted: false }));
        expect(result.reason).toMatch(/guarded tests/i);
        expect(whatsapp.__instances).toHaveLength(0);
    });
});
