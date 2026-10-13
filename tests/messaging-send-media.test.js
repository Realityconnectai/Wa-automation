/**
 * tests/messaging-send-media.test.js
 *
 * Tests for src/services/messaging.js — sendMedia / validateMediaFile.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/messaging-send-media.test.js --forceExit
 */
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ─── Magic bytes ──────────────────────────────────────────────────────────
const MAGIC = {
    pdf:  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]),   // %PDF-
    jpg:  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    png:  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    mp4:  Buffer.concat([
              Buffer.from([0x00, 0x00, 0x00, 0x18]),
              Buffer.from('ftyp'),
              Buffer.from('isom'),
              Buffer.alloc(100)
          ]),
    exe:  Buffer.from([0x4D, 0x5A]),                      // MZ
};

function writeTmp(name, buf) {
    const p = path.join(os.tmpdir(), `wa_test_${Date.now()}_${name}`);
    fs.writeFileSync(p, buf);
    return p;
}

// ─── Pure validation tests — no DB needed ─────────────────────────────────
describe('validateMediaFile — type + signature checks', () => {
    // Grab function reference once (before any tests run)
    let validateMediaFile;
    beforeAll(() => {
        ({ validateMediaFile } = require('../src/services/messaging'));
    });

    test('accepts a valid PDF (correct magic bytes)', () => {
        const p = writeTmp('ok.pdf', Buffer.concat([MAGIC.pdf, Buffer.alloc(100)]));
        try   { expect(validateMediaFile(p, 'application/pdf').ok).toBe(true); }
        finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('accepts a valid PNG', () => {
        const p = writeTmp('ok.png', Buffer.concat([MAGIC.png, Buffer.alloc(50)]));
        try   { expect(validateMediaFile(p, 'image/png').ok).toBe(true); }
        finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('accepts a valid JPG', () => {
        const p = writeTmp('ok.jpg', Buffer.concat([MAGIC.jpg, Buffer.alloc(50)]));
        try   { expect(validateMediaFile(p, 'image/jpeg').ok).toBe(true); }
        finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('accepts a valid MP4 (ftyp box at offset 4)', () => {
        const p = writeTmp('ok.mp4', MAGIC.mp4);
        try   { expect(validateMediaFile(p, 'video/mp4').ok).toBe(true); }
        finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('rejects a disallowed MIME type', () => {
        const p = writeTmp('doc.txt', Buffer.from('hello world'));
        try {
            const r = validateMediaFile(p, 'text/plain');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('rejects an executable disguised as PDF (wrong magic bytes)', () => {
        const p = writeTmp('evil.pdf', Buffer.concat([MAGIC.exe, Buffer.alloc(100)]));
        try {
            const r = validateMediaFile(p, 'application/pdf');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('MEDIA_INVALID_SIGNATURE');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('rejects a non-existent file', () => {
        const r = validateMediaFile('/tmp/no_such_file_xyz_99.pdf', 'application/pdf');
        expect(r.ok).toBe(false);
        expect(r.code).toBe('MEDIA_FILE_NOT_FOUND');
    });

    test('rejects an empty file', () => {
        const p = writeTmp('empty.pdf', Buffer.alloc(0));
        try {
            const r = validateMediaFile(p, 'application/pdf');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('MEDIA_EMPTY');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('rejects an oversized PDF — writes a real 11 MB file', () => {
        // Default limit is 10 MB for PDF/images. This writes an actual
        // 11 MB file with valid magic bytes, no env manipulation needed.
        const elevenMb = 11 * 1024 * 1024;
        const buf = Buffer.concat([MAGIC.pdf, Buffer.alloc(elevenMb)]);
        const p = writeTmp('big.pdf', buf);
        try {
            const r = validateMediaFile(p, 'application/pdf');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('MEDIA_TOO_LARGE');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    });

    test('rejects an oversized MP4 — writes a real 17 MB file', () => {
        const seventeenMb = 17 * 1024 * 1024;
        const buf = Buffer.concat([MAGIC.mp4, Buffer.alloc(seventeenMb)]);
        const p = writeTmp('big.mp4', buf);
        try {
            const r = validateMediaFile(p, 'video/mp4');
            expect(r.ok).toBe(false);
            expect(r.code).toBe('MEDIA_TOO_LARGE');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    });
});

// ─── sendMedia + ack — DB-dependent tests ─────────────────────────────────
describe('sendMedia via mocked WA session (DB)', () => {
    let userId;

    beforeEach(async () => {
        await freshDatabase();
        const { createUser } = require('../src/services/database');
        const user = await createUser({
            email: `media_send_${Date.now()}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            status: 'active',
            waEnabled: 1
        });
        userId = user.id;

        // Boot a fake connected WA session
        const wa   = require('../src/services/whatsapp-client');
        const wwjs = require('whatsapp-web.js');
        wwjs.__reset();
        await wa.initWhatsAppClient(userId);
        wwjs.__last()?.becomeReady?.('919999999999');
        await new Promise(r => setTimeout(r, 60));
    });

    afterEach(async () => {
        const wa = require('../src/services/whatsapp-client');
        await wa.destroyClientForUser(userId).catch(() => {});
    });

    test('successful send logs a message row — status=sent, type=document', async () => {
        // Defensive: ensure no lingering size-limit override from other tests
        delete process.env.MAX_MEDIA_IMAGE_PDF_MB;
        delete process.env.MAX_MEDIA_VIDEO_MB;
        const { sendMedia }   = require('../src/services/messaging');
        const { getMessages } = require('../src/services/database');
        const phone = '919876500001';

        const p = writeTmp('brochure.pdf', Buffer.concat([MAGIC.pdf, Buffer.alloc(200)]));
        try {
            const result = await sendMedia(userId, phone, {
                filePath: p, mimeType: 'application/pdf', caption: 'Sunrise brochure'
            });
            expect(result.waMessageId).toBeTruthy();
            expect(result.fileName).toMatch(/\.pdf$/);

            const rows = await getMessages(userId, { phone, direction: 'outgoing' });
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('sent');
            expect(rows[0].message_type).toBe('document');
            expect(rows[0].body).toContain('.pdf');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    }, 15000);

    test('a durable idempotency key prevents a retry from sending media twice', async () => {
        const { sendMedia } = require('../src/services/messaging');
        const { getMessages } = require('../src/services/database');
        const wwjs = require('whatsapp-web.js');
        const phone = '919876500009';
        const key = 'asset-retry-key';
        const p = writeTmp('retry.pdf', Buffer.concat([MAGIC.pdf, Buffer.alloc(200)]));
        try {
            const first = await sendMedia(userId, phone, {
                filePath: p, mimeType: 'application/pdf', idempotencyKey: key
            });
            const second = await sendMedia(userId, phone, {
                filePath: p, mimeType: 'application/pdf', idempotencyKey: key
            });

            expect(first.duplicate).not.toBe(true);
            expect(second.duplicate).toBe(true);
            expect(second.waMessageId).toBe(first.waMessageId);
            expect(wwjs.__last().sent).toHaveLength(1);
            expect(await getMessages(userId, { phone, direction: 'outgoing' })).toHaveLength(1);
        } finally { try { fs.unlinkSync(p); } catch (_) {} }
    }, 15000);

    test('rejected MIME type throws MEDIA_TYPE_NOT_ALLOWED — nothing logged', async () => {
        delete process.env.MAX_MEDIA_IMAGE_PDF_MB;
        const { sendMedia }     = require('../src/services/messaging');
        const { countMessages } = require('../src/services/database');
        const phone = '919876500002';

        const p = writeTmp('bad.exe', Buffer.concat([MAGIC.exe, Buffer.alloc(50)]));
        try {
            await expect(
                sendMedia(userId, phone, { filePath: p, mimeType: 'application/octet-stream' })
            ).rejects.toMatchObject({ code: 'MEDIA_TYPE_NOT_ALLOWED' });
        } finally { try { fs.unlinkSync(p); } catch (_) {} }

        expect(await countMessages(userId, { phone: '919876500002' })).toBe(0);
    }, 15000);

    test('failed WA send records status=failed in the log row', async () => {
        delete process.env.MAX_MEDIA_IMAGE_PDF_MB;
        const wwjs = require('whatsapp-web.js');
        wwjs.__setSendError('Simulated timeout');

        const { sendMedia }   = require('../src/services/messaging');
        const { getMessages } = require('../src/services/database');
        const phone = '919876500003';

        const p = writeTmp('brochure2.pdf', Buffer.concat([MAGIC.pdf, Buffer.alloc(200)]));
        try {
            await expect(
                sendMedia(userId, phone, {
                    filePath: p, mimeType: 'application/pdf',
                    idempotencyKey: `idem_${Date.now()}`
                })
            ).rejects.toThrow('Simulated timeout');
        } finally { try { fs.unlinkSync(p); } catch (_) {} }

        const rows = await getMessages(userId, { phone, direction: 'outgoing' });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');

        wwjs.__setSendError(null);
    }, 15000);

    test('acks advance status: sent → delivered → read (no downgrade)', async () => {
        delete process.env.MAX_MEDIA_IMAGE_PDF_MB;
        const { sendMedia }              = require('../src/services/messaging');
        const { getMessages,
                updateMessageAckStatus } = require('../src/services/database');
        const phone = '919876500004';

        const p = writeTmp('floor.pdf', Buffer.concat([MAGIC.pdf, Buffer.alloc(200)]));
        let waMessageId;
        try {
            ({ waMessageId } = await sendMedia(userId, phone, {
                filePath: p, mimeType: 'application/pdf'
            }));
        } finally { try { fs.unlinkSync(p); } catch (_) {} }

        // ACK_DEVICE (2) → delivered
        await updateMessageAckStatus(userId, waMessageId, 2);
        expect((await getMessages(userId, { phone, direction: 'outgoing' }))[0].status).toBe('delivered');

        // ACK_READ (3) → read
        await updateMessageAckStatus(userId, waMessageId, 3);
        expect((await getMessages(userId, { phone, direction: 'outgoing' }))[0].status).toBe('read');

        // Out-of-order ACK_SERVER (1) → must not downgrade from read
        const updated = await updateMessageAckStatus(userId, waMessageId, 1);
        expect(updated).toBe(false);
        expect((await getMessages(userId, { phone, direction: 'outgoing' }))[0].status).toBe('read');
    }, 15000);
});
