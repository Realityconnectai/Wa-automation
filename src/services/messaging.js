/**
 * src/services/messaging.js — provider-agnostic send layer.
 *
 * Business code (chatbot, brochure drops, outreach) calls sendText/sendMedia
 * here rather than reaching into whatsapp-client.js directly. This keeps the
 * provider boundary clean so a Meta Cloud API adapter can be swapped in later
 * without touching call sites.
 *
 * Only QR/whatsapp-web.js is supported for now. A future
 * src/services/meta-cloud.js would expose the same interface and this
 * module would select between them based on the tenant's
 * provider_connections row.
 *
 * Validation rules (enforced here, not at the HTTP boundary):
 *   - Allowed MIME types: PDF, JPG, PNG, MP4 (configurable via env).
 *   - Size limits: PDF/image 10 MB, video 16 MB (configurable via env).
 *   - File signature (magic bytes) is verified so a renamed file cannot
 *     bypass the type check.
 *   - Phone is re-sanitised to digits before reaching the transport.
 *
 * Every send is logged as a messages row (type, file name, status).
 * Ack status is updated via the message_ack handler in whatsapp-client.js.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { sendTextMessage, sendMediaMessage } = require('./whatsapp-client');
const { logMessage, logOutgoingMessageIdempotent, findMessageByIdempotencyKey } = require('./database');
const { runSql } = require('./db-pool');

// ─── Size limits (read at call time so tests can override via env) ────────
const MB = 1024 * 1024;
function maxImagePdfBytes() {
    const v = parseInt(process.env.MAX_MEDIA_IMAGE_PDF_MB, 10);
    return (Number.isFinite(v) && v >= 0 ? v : 10) * MB;
}
function maxVideoBytes() {
    const v = parseInt(process.env.MAX_MEDIA_VIDEO_MB, 10);
    return (Number.isFinite(v) && v >= 0 ? v : 16) * MB;
}

// ─── Allowed MIME types and their magic-byte signatures ──────────────────
// Only these types may be sent. The signature check is defence-in-depth:
// a file with the correct extension but wrong content (e.g. a disguised
// executable) is rejected before it leaves the server.
const ALLOWED_TYPES = {
    'application/pdf': {
        get maxBytes()  { return maxImagePdfBytes(); },
        label:      'PDF',
        signatures: [Buffer.from([0x25, 0x50, 0x44, 0x46])],        // %PDF
    },
    'image/jpeg': {
        get maxBytes()  { return maxImagePdfBytes(); },
        label:      'JPG',
        signatures: [Buffer.from([0xFF, 0xD8, 0xFF])],               // SOI marker
    },
    'image/jpg': {   // alias
        get maxBytes()  { return maxImagePdfBytes(); },
        label:      'JPG',
        signatures: [Buffer.from([0xFF, 0xD8, 0xFF])],
    },
    'image/png': {
        get maxBytes()  { return maxImagePdfBytes(); },
        label:      'PNG',
        signatures: [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], // PNG\r\n..
    },
    'video/mp4': {
        get maxBytes()  { return maxVideoBytes(); },
        label:      'MP4',
        // MP4 boxes vary; check for 'ftyp' at offset 4 or RIFF-like header
        signatures: [
            Buffer.from([0x00, 0x00, 0x00]),                         // box size prefix (varies)
            Buffer.from([0x66, 0x74, 0x79, 0x70]),                   // ftyp box
        ],
        customCheck: (buf) => {
            // ftyp box normally appears at byte 4; check bytes 4-7
            if (buf.length < 8) return false;
            const ftyp = buf.slice(4, 8).toString('ascii');
            return ftyp === 'ftyp';
        }
    },
};

/**
 * Validates a file's MIME type, size, and magic bytes.
 *
 * @param {string} filePath  — absolute path to an on-disk file
 * @param {string} mimeType  — declared MIME type
 * @returns {{ ok: true, sizeBytes: number, fileName: string } |
 *           { ok: false, code: string, message: string }}
 */
function validateMediaFile(filePath, mimeType) {
    const normalised = (mimeType || '').toLowerCase().trim();
    const spec = ALLOWED_TYPES[normalised];
    if (!spec) {
        return {
            ok: false,
            code: 'MEDIA_TYPE_NOT_ALLOWED',
            message: `File type '${normalised}' is not allowed. Allowed: PDF, JPG, PNG, MP4.`
        };
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return { ok: false, code: 'MEDIA_FILE_NOT_FOUND', message: 'Media file not found.' };
    }

    if (stat.size > spec.maxBytes) {
        return {
            ok: false,
            code: 'MEDIA_TOO_LARGE',
            message: `File size ${(stat.size / MB).toFixed(1)} MB exceeds the ${(spec.maxBytes / MB).toFixed(0)} MB limit for ${spec.label}.`
        };
    }

    if (stat.size === 0) {
        return { ok: false, code: 'MEDIA_EMPTY', message: 'File is empty.' };
    }

    // Read just enough bytes for magic number check
    const headerBuf = Buffer.alloc(16);
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, headerBuf, 0, 16, 0);
        if (bytesRead < 4) {
            return { ok: false, code: 'MEDIA_TOO_SMALL', message: 'File is too small to validate.' };
        }
    } catch (e) {
        return { ok: false, code: 'MEDIA_READ_ERROR', message: 'Cannot read file.' };
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }

    const head = headerBuf.slice(0, 16);

    if (spec.customCheck) {
        if (!spec.customCheck(head)) {
            return { ok: false, code: 'MEDIA_INVALID_SIGNATURE', message: `File does not match expected ${spec.label} format.` };
        }
    } else {
        const sigMatch = spec.signatures.some(sig => head.slice(0, sig.length).equals(sig));
        if (!sigMatch) {
            return { ok: false, code: 'MEDIA_INVALID_SIGNATURE', message: `File does not match expected ${spec.label} format.` };
        }
    }

    return { ok: true, sizeBytes: stat.size, fileName: path.basename(filePath) };
}

/**
 * Sends a text message and logs it.
 *
 * This is a thin pass-through for now — it exists so callers don't import
 * whatsapp-client.js directly.
 */
async function sendText(userId, phone, text) {
    const digits = String(phone).replace(/\D/g, '');
    const result = await sendTextMessage(userId, digits, text);
    const waId = result?.id?._serialized || null;
    await logMessage(userId, {
        waMessageId: waId, phone: digits, direction: 'outgoing',
        messageType: 'text', body: String(text), status: 'sent'
    });
    return { waMessageId: waId };
}

/**
 * Sends a media file from an on-disk path and logs it.
 *
 * @param {number} userId
 * @param {string} phone      — digits only
 * @param {object} opts
 *   @param {string}  opts.filePath   — absolute path to the file
 *   @param {string}  opts.mimeType   — MIME type
 *   @param {string}  [opts.caption]  — optional caption
 *   @param {string}  [opts.idempotencyKey] — optional, to prevent duplicate sends
 *
 * @returns {{ waMessageId: string|null, sizeBytes: number, fileName: string }}
 * @throws  Error with .code if validation fails or WA client not connected
 */
async function sendMedia(userId, phone, { filePath, mimeType, caption = '', idempotencyKey = null, mediaAssetId = null, fileName = null, buffer = null, sendMediaAsDocument = false }) {
    const { dispatchMedia } = require('./media-dispatch');
    return await dispatchMedia({
        userId,
        phone,
        filePath,
        buffer,
        mimeType,
        fileName,
        caption,
        idempotencyKey,
        mediaAssetId,
        sendMediaAsDocument
    });
}

module.exports = { sendText, sendMedia, validateMediaFile, ALLOWED_TYPES };
