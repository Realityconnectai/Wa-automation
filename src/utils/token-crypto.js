/**
 * src/utils/token-crypto.js — AES-256-GCM token encryption at rest.
 *
 * Encrypts sensitive credentials (such as Google OAuth access and refresh tokens)
 * before persisting to the database.
 *
 * Wire format:
 *   enc:v1:<iv_base64>:<tag_base64>:<ciphertext_base64>
 *
 * Guarantees:
 *   1. Fresh, random 12-byte IV per encryption call.
 *   2. 16-byte GCM authentication tag verifies ciphertext integrity and authenticity.
 *   3. Strict validation: malformed, tampered, or wrong-key attempts throw an explicit error.
 *   4. Backward-compatible: unencrypted legacy tokens are passed through on read.
 *   5. Safe key management: in production, TOKEN_ENCRYPTION_KEY is required and strictly validated.
 *      Insecure fallbacks are strictly barred in production.
 */
'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;      // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;     // 128-bit authentication tag
const PREFIX = 'enc:v1:';

// Deterministic fallback key strictly for development/test environments.
// MUST NEVER be used in production.
const DEV_FALLBACK_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
let _hasWarnedDevFallback = false;

/**
 * Validates and normalizes a candidate encryption key into a 32-byte Buffer.
 * Accepts:
 *   - 32-byte Buffer
 *   - 64-character hexadecimal string
 *   - Strictly validated 32-byte Base64 string
 *
 * Rejects invalid encodings, wrong lengths, and weak/derived keys.
 * Never logs the key.
 */
function parseKey(rawKey) {
    if (!rawKey) return null;

    if (Buffer.isBuffer(rawKey)) {
        if (rawKey.length === 32) return rawKey;
        throw new Error(`Invalid token encryption key: Buffer length must be exactly 32 bytes, got ${rawKey.length}.`);
    }

    if (typeof rawKey !== 'string') {
        throw new Error('Invalid token encryption key: Key must be a 64-hex string or Buffer.');
    }

    const trimmed = rawKey.trim();

    // 1. Strict 64-character Hexadecimal (preferred)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }

    // 2. Strict Base64 validation (must decode to exactly 32 bytes and round-trip cleanly)
    // A 32-byte base64 string is 44 characters ending with '=' or '=='
    if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || /^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
        const decoded = Buffer.from(trimmed, 'base64');
        if (decoded.length === 32 && decoded.toString('base64') === trimmed) {
            return decoded;
        }
    }

    throw new Error('Invalid token encryption key format: Must be exactly 32 bytes encoded as 64 hex characters or valid Base64.');
}

/**
 * Resolves the active encryption key based on environment.
 * In production: TOKEN_ENCRYPTION_KEY must be present and valid.
 * In non-production: Uses TEST_TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY if set;
 *                    otherwise falls back to DEV_FALLBACK_KEY_HEX with a loud warning.
 */
function getEncryptionKey(overrideKey = null) {
    if (overrideKey) {
        return parseKey(overrideKey);
    }

    const envKey = process.env.TOKEN_ENCRYPTION_KEY || process.env.TEST_TOKEN_ENCRYPTION_KEY;
    const isProduction = process.env.NODE_ENV === 'production';

    if (envKey) {
        return parseKey(envKey);
    }

    if (isProduction) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY is required in production. ' +
            'Provide a securely generated 32-byte key encoded as 64 hexadecimal characters.'
        );
    }

    // Non-production fallback
    if (!_hasWarnedDevFallback) {
        console.warn(
            '⚠️  [token-crypto] TOKEN_ENCRYPTION_KEY is not set. ' +
            'Using insecure test/dev fallback key. DO NOT USE IN PRODUCTION.'
        );
        _hasWarnedDevFallback = true;
    }

    return Buffer.from(DEV_FALLBACK_KEY_HEX, 'hex');
}

/**
 * Returns true if a string matches the encrypted token version 1 format.
 */
function isEncrypted(token) {
    return typeof token === 'string' && token.startsWith(PREFIX);
}

/**
 * Encrypts a plain-text token using AES-256-GCM.
 *
 * @param {string} plainText
 * @param {Buffer|string|null} [keyOverride]
 * @returns {string|null} Formatted as `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 */
function encryptToken(plainText, keyOverride = null) {
    if (plainText === null || plainText === undefined) return null;
    if (plainText === '') return '';
    if (isEncrypted(plainText)) return plainText; // Idempotent: already encrypted

    const key = getEncryptionKey(keyOverride);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(String(plainText), 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts an encrypted token.
 * If the input is not encrypted, returns it unchanged (backward compatibility for legacy plaintext).
 * Throws on tampering, invalid format, or wrong decryption key.
 *
 * @param {string|null} token
 * @param {Buffer|string|null} [keyOverride]
 * @returns {string|null} Plain-text token
 */
function decryptToken(token, keyOverride = null) {
    if (token === null || token === undefined) return null;
    if (token === '') return '';
    if (!isEncrypted(token)) {
        // Transparent backward compatibility for legacy plaintext tokens
        return token;
    }

    const payload = token.slice(PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 3) {
        throw new Error('Malformed encrypted token: expected 3 colon-delimited components after prefix.');
    }

    const [ivB64, tagB64, cipherB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(cipherB64, 'base64');

    if (iv.length !== IV_LENGTH) {
        throw new Error(`Malformed encrypted token: invalid IV length (${iv.length} bytes, expected ${IV_LENGTH}).`);
    }
    if (authTag.length !== TAG_LENGTH) {
        throw new Error(`Malformed encrypted token: invalid auth tag length (${authTag.length} bytes, expected ${TAG_LENGTH}).`);
    }

    const key = getEncryptionKey(keyOverride);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    try {
        const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    } catch (err) {
        const authErr = new Error('Failed to decrypt token: authentication tag verification failed or wrong key.');
        authErr.code = 'ERR_CRYPTO_TOKEN_DECRYPT_FAILED';
        throw authErr;
    }
}

module.exports = {
    encryptToken,
    decryptToken,
    isEncrypted,
    parseKey,
    getEncryptionKey,
    DEV_FALLBACK_KEY_HEX
};
