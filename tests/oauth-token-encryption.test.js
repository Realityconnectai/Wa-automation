'use strict';

const crypto = require('crypto');
const {
    encryptToken,
    decryptToken,
    isEncrypted,
    parseKey,
    getEncryptionKey,
    DEV_FALLBACK_KEY_HEX
} = require('../src/utils/token-crypto');

const db = require('../src/services/database');
const { runSql, queryGet, queryAll } = require('../src/services/db-pool');

const TEST_KEY_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ALT_KEY_HEX  = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

describe('AES-256-GCM Token Encryption (src/utils/token-crypto.js)', () => {
    describe('Key Management & Parsing', () => {
        test('accepts valid 64-character hexadecimal keys', () => {
            const parsed = parseKey(TEST_KEY_HEX);
            expect(Buffer.isBuffer(parsed)).toBe(true);
            expect(parsed.length).toBe(32);
            expect(parsed.toString('hex')).toBe(TEST_KEY_HEX);
        });

        test('accepts valid 32-byte Base64 keys', () => {
            const raw32 = crypto.randomBytes(32);
            const b64 = raw32.toString('base64');
            const parsed = parseKey(b64);
            expect(Buffer.isBuffer(parsed)).toBe(true);
            expect(parsed.length).toBe(32);
            expect(parsed.equals(raw32)).toBe(true);
        });

        test('rejects arbitrary 44-character non-base64 strings or wrong lengths', () => {
            expect(() => parseKey('not-a-valid-hex-or-base64-key-this-is-garbage')).toThrow(/Invalid token encryption key format/);
            expect(() => parseKey('12345')).toThrow(/Invalid token encryption key format/);
            // 63 hex chars (1 character short)
            expect(() => parseKey(TEST_KEY_HEX.slice(0, 63))).toThrow(/Invalid token encryption key format/);
            // 65 hex chars (1 character too long)
            expect(() => parseKey(TEST_KEY_HEX + 'a')).toThrow(/Invalid token encryption key format/);
        });

        test('throws explicitly in production if TOKEN_ENCRYPTION_KEY is missing', () => {
            const origEnv = process.env.NODE_ENV;
            const origKey = process.env.TOKEN_ENCRYPTION_KEY;
            const origTestKey = process.env.TEST_TOKEN_ENCRYPTION_KEY;

            try {
                process.env.NODE_ENV = 'production';
                delete process.env.TOKEN_ENCRYPTION_KEY;
                delete process.env.TEST_TOKEN_ENCRYPTION_KEY;

                expect(() => getEncryptionKey()).toThrow(/TOKEN_ENCRYPTION_KEY is required in production/);
            } finally {
                process.env.NODE_ENV = origEnv;
                if (origKey !== undefined) process.env.TOKEN_ENCRYPTION_KEY = origKey;
                if (origTestKey !== undefined) process.env.TEST_TOKEN_ENCRYPTION_KEY = origTestKey;
            }
        });

        test('uses test/dev fallback key with warning in non-production when unset', () => {
            const origEnv = process.env.NODE_ENV;
            const origKey = process.env.TOKEN_ENCRYPTION_KEY;
            const origTestKey = process.env.TEST_TOKEN_ENCRYPTION_KEY;

            try {
                process.env.NODE_ENV = 'test';
                delete process.env.TOKEN_ENCRYPTION_KEY;
                delete process.env.TEST_TOKEN_ENCRYPTION_KEY;

                const key = getEncryptionKey();
                expect(Buffer.isBuffer(key)).toBe(true);
                expect(key.length).toBe(32);
                expect(key.toString('hex')).toBe(DEV_FALLBACK_KEY_HEX);
            } finally {
                process.env.NODE_ENV = origEnv;
                if (origKey !== undefined) process.env.TOKEN_ENCRYPTION_KEY = origKey;
                if (origTestKey !== undefined) process.env.TEST_TOKEN_ENCRYPTION_KEY = origTestKey;
            }
        });
    });

    describe('Crypto Core: encryptToken / decryptToken', () => {
        test('round-trips arbitrary OAuth token strings', () => {
            const sampleToken = 'ya29.a0AfH6SMD_example_oauth2_access_token_1234567890';
            const encrypted = encryptToken(sampleToken, TEST_KEY_HEX);

            expect(typeof encrypted).toBe('string');
            expect(encrypted.startsWith('enc:v1:')).toBe(true);
            expect(isEncrypted(encrypted)).toBe(true);

            const decrypted = decryptToken(encrypted, TEST_KEY_HEX);
            expect(decrypted).toBe(sampleToken);
        });

        test('produces different ciphertexts for identical plaintext due to random 12-byte IVs', () => {
            const text = 'my-secret-refresh-token';
            const enc1 = encryptToken(text, TEST_KEY_HEX);
            const enc2 = encryptToken(text, TEST_KEY_HEX);

            expect(enc1).not.toBe(enc2);
            expect(decryptToken(enc1, TEST_KEY_HEX)).toBe(text);
            expect(decryptToken(enc2, TEST_KEY_HEX)).toBe(text);

            const parts1 = enc1.slice('enc:v1:'.length).split(':');
            const parts2 = enc2.slice('enc:v1:'.length).split(':');
            expect(parts1[0]).not.toBe(parts2[0]); // IVs must differ
        });

        test('handles null, undefined, and empty string safely', () => {
            expect(encryptToken(null)).toBeNull();
            expect(encryptToken(undefined)).toBeNull();
            expect(encryptToken('')).toBe('');

            expect(decryptToken(null)).toBeNull();
            expect(decryptToken(undefined)).toBeNull();
            expect(decryptToken('')).toBe('');
        });

        test('is idempotent: encrypting an already encrypted token returns it unchanged', () => {
            const text = 'token-to-encrypt';
            const enc = encryptToken(text, TEST_KEY_HEX);
            const reEnc = encryptToken(enc, TEST_KEY_HEX);
            expect(reEnc).toBe(enc);
        });

        test('transparently returns unencrypted legacy plaintext on decrypt', () => {
            const legacyToken = 'ya29.legacy_plain_text_token_before_encryption';
            expect(isEncrypted(legacyToken)).toBe(false);
            expect(decryptToken(legacyToken, TEST_KEY_HEX)).toBe(legacyToken);
        });

        test('rejects tampered ciphertext', () => {
            const enc = encryptToken('secret-token', TEST_KEY_HEX);
            const parts = enc.slice('enc:v1:'.length).split(':');
            const cipherBuf = Buffer.from(parts[2], 'base64');
            cipherBuf[0] ^= 0xFF; // flip bits
            parts[2] = cipherBuf.toString('base64');
            const tampered = `enc:v1:${parts.join(':')}`;

            expect(() => decryptToken(tampered, TEST_KEY_HEX)).toThrow(/authentication tag verification failed/);
        });

        test('rejects tampered authentication tag', () => {
            const enc = encryptToken('secret-token', TEST_KEY_HEX);
            const parts = enc.slice('enc:v1:'.length).split(':');
            const tagBuf = Buffer.from(parts[1], 'base64');
            tagBuf[0] ^= 0xAA; // tamper tag
            parts[1] = tagBuf.toString('base64');
            const tampered = `enc:v1:${parts.join(':')}`;

            expect(() => decryptToken(tampered, TEST_KEY_HEX)).toThrow(/authentication tag verification failed/);
        });

        test('rejects decryption with the wrong key', () => {
            const enc = encryptToken('secret-token', TEST_KEY_HEX);
            expect(() => decryptToken(enc, ALT_KEY_HEX)).toThrow(/authentication tag verification failed/);
        });

        test('rejects malformed encrypted structures', () => {
            expect(() => decryptToken('enc:v1:not-enough-parts', TEST_KEY_HEX)).toThrow(/Malformed encrypted token/);
            expect(() => decryptToken('enc:v1:a:b:c', TEST_KEY_HEX)).toThrow(/invalid IV length/);
        });
    });
});

describe('Database Integration: Google Calendar OAuth Token Encryption & Migration', () => {
    let testUserId;

    beforeAll(async () => {
        process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
        await db.initDatabase();

        // Create a unique tenant for this test suite
        const email = `cal-encrypt-${Date.now()}@example.test`;
        const user = await db.createUser({
            email,
            passwordHash: 'dummy_hash',
            status: 'active'
        });
        testUserId = user.id;
    });

    afterAll(async () => {
        if (testUserId) {
            await runSql('DELETE FROM users WHERE id = $1', [testUserId]);
        }
        await db.closeDatabase();
    });

    test('saveGoogleCalendarTokens encrypts access_token and refresh_token in the database', async () => {
        const tokens = {
            access_token: 'ya29.live_test_access_token_xyz',
            refresh_token: '1//04_refresh_token_abc',
            scope: 'https://www.googleapis.com/auth/calendar',
            token_type: 'Bearer',
            expiry_date: Date.now() + 3600000
        };

        await db.saveGoogleCalendarTokens(testUserId, tokens);

        // Inspect raw DB row directly to verify at-rest encryption
        const rawRow = await queryGet('SELECT access_token, refresh_token FROM google_calendar_accounts WHERE user_id = $1', [testUserId]);
        expect(rawRow).toBeDefined();
        expect(rawRow.access_token.startsWith('enc:v1:')).toBe(true);
        expect(rawRow.refresh_token.startsWith('enc:v1:')).toBe(true);
        expect(rawRow.access_token).not.toContain('ya29.live_test_access_token_xyz');
        expect(rawRow.refresh_token).not.toContain('1//04_refresh_token_abc');
    });

    test('getGoogleCalendarAccount decrypts tokens transparently', async () => {
        const account = await db.getGoogleCalendarAccount(testUserId);
        expect(account).toBeDefined();
        expect(account.access_token).toBe('ya29.live_test_access_token_xyz');
        expect(account.refresh_token).toBe('1//04_refresh_token_abc');
    });

    test('preserves existing refresh_token when Google token refresh omits it', async () => {
        // When Google refreshes an access token, it only returns access_token and expiry_date (refresh_token is undefined)
        const refreshedTokens = {
            access_token: 'ya29.new_refreshed_access_token_999',
            expiry_date: Date.now() + 7200000
        };

        await db.saveGoogleCalendarTokens(testUserId, refreshedTokens);

        const account = await db.getGoogleCalendarAccount(testUserId);
        expect(account.access_token).toBe('ya29.new_refreshed_access_token_999');
        // Existing refresh token must be preserved!
        expect(account.refresh_token).toBe('1//04_refresh_token_abc');

        // Check raw DB row to confirm refresh_token remains encrypted
        const rawRow = await queryGet('SELECT access_token, refresh_token FROM google_calendar_accounts WHERE user_id = $1', [testUserId]);
        expect(rawRow.access_token.startsWith('enc:v1:')).toBe(true);
        expect(rawRow.refresh_token.startsWith('enc:v1:')).toBe(true);
    });

    test('transparently reads legacy plaintext rows', async () => {
        // Manually insert a legacy unencrypted account row
        const legacyUser = await db.createUser({
            email: `cal-legacy-${Date.now()}@example.test`,
            passwordHash: 'dummy',
            status: 'active'
        });

        await runSql(
            `INSERT INTO google_calendar_accounts (user_id, access_token, refresh_token, scope)
             VALUES ($1, $2, $3, $4)`,
            [legacyUser.id, 'legacy_plaintext_access', 'legacy_plaintext_refresh', 'https://www.googleapis.com/auth/calendar']
        );

        const account = await db.getGoogleCalendarAccount(legacyUser.id);
        expect(account).toBeDefined();
        expect(account.access_token).toBe('legacy_plaintext_access');
        expect(account.refresh_token).toBe('legacy_plaintext_refresh');

        await runSql('DELETE FROM users WHERE id = $1', [legacyUser.id]);
    });

    test('migratePlaintextCalendarTokens migrates legacy plaintext rows idempotently', async () => {
        // Create 2 legacy accounts
        const userA = await db.createUser({ email: `mig-a-${Date.now()}@test.io`, passwordHash: 'd', status: 'active' });
        const userB = await db.createUser({ email: `mig-b-${Date.now()}@test.io`, passwordHash: 'd', status: 'active' });

        await runSql(
            `INSERT INTO google_calendar_accounts (user_id, access_token, refresh_token)
             VALUES ($1, 'raw_access_a', 'raw_refresh_a'),
                    ($2, 'raw_access_b', NULL)`,
            [userA.id, userB.id]
        );

        // Run migration
        const res1 = await db.migratePlaintextCalendarTokens();
        expect(res1.migrated).toBeGreaterThanOrEqual(2);

        // Verify raw rows are now encrypted
        const rawA = await queryGet('SELECT access_token, refresh_token FROM google_calendar_accounts WHERE user_id = $1', [userA.id]);
        expect(rawA.access_token.startsWith('enc:v1:')).toBe(true);
        expect(rawA.refresh_token.startsWith('enc:v1:')).toBe(true);

        const rawB = await queryGet('SELECT access_token, refresh_token FROM google_calendar_accounts WHERE user_id = $1', [userB.id]);
        expect(rawB.access_token.startsWith('enc:v1:')).toBe(true);
        expect(rawB.refresh_token).toBeNull();

        // Verify transparent decrypted read
        const readA = await db.getGoogleCalendarAccount(userA.id);
        expect(readA.access_token).toBe('raw_access_a');
        expect(readA.refresh_token).toBe('raw_refresh_a');

        const readB = await db.getGoogleCalendarAccount(userB.id);
        expect(readB.access_token).toBe('raw_access_b');
        expect(readB.refresh_token).toBeNull();

        // Idempotency: second run should migrate 0 rows
        const res2 = await db.migratePlaintextCalendarTokens();
        expect(res2.migrated).toBe(0);

        await runSql('DELETE FROM users WHERE id IN ($1, $2)', [userA.id, userB.id]);
    });
});
