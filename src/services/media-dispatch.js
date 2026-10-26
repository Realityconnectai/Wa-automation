/**
 * src/services/media-dispatch.js — Unified Shared Media Dispatch Service
 *
 * Single source of truth for sending media across all WorkPilot features:
 * - Campaigns
 * - Brochure Drop
 * - Property Dashboard / Manual Send
 * - Chatbot Media Responses
 * - Scheduled Attachments
 *
 * Responsibilities:
 * 1. Load stored bytes from DB (media_assets) or validate on-disk path.
 * 2. Assert checksum and valid MIME magic-bytes.
 * 3. Resolve destination chat ID (@lid vs @c.us).
 * 4. Build clean MessageMedia & options object with NO undefined/null keys.
 * 5. Honest fallback chain:
 *    Native Media -> Document Retry -> Honest Failure (Never fake delivery).
 * 6. Atomic idempotency & logging with real WhatsApp Message IDs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

const { getClient, getSession, resolveDestinationChatId } = require('./whatsapp-client');
const { loadMediaAsset } = require('./media-storage');
const { validateMediaFile, ALLOWED_TYPES } = require('./messaging');
const { logMessage, logOutgoingMessageIdempotent } = require('./database');
const { runSql } = require('./db-pool');

/**
 * Strips all null and undefined keys from an object.
 */
function cleanOptionsObject(rawOpts = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(rawOpts)) {
        if (v !== undefined && v !== null) {
            clean[k] = v;
        }
    }
    return clean;
}

/**
 * Dispatches a media message on behalf of a tenant.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.phone
 * @param {number} [params.mediaAssetId] — ID from media_assets table
 * @param {string} [params.filePath]     — Alternative direct file path
 * @param {Buffer} [params.buffer]       — Alternative direct buffer
 * @param {string} [params.mimeType]
 * @param {string} [params.fileName]
 * @param {string} [params.caption]
 * @param {string} [params.idempotencyKey]
 * @param {boolean} [params.sendMediaAsDocument]
 *
 * @returns {Promise<{ waMessageId: string|null, sizeBytes: number, fileName: string, fallbackUsed: boolean, duplicate?: boolean }>}
 */
async function dispatchMedia({
    userId,
    phone,
    mediaAssetId = null,
    filePath = null,
    buffer = null,
    mimeType = null,
    fileName = null,
    caption = '',
    idempotencyKey = null,
    sendMediaAsDocument = false
}) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
        throw new Error('Valid userId is required for media dispatch');
    }

    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits || digits.length < 7 || digits.length > 15) {
        const err = new Error(`Invalid recipient phone: ${phone}`);
        err.code = 'INVALID_RECIPIENT';
        err.status = 400;
        throw err;
    }

    // 1. Verify WhatsApp client connection
    const s = getSession(uid, false);
    if (!s || !s.isConnected || !s.client) {
        const err = new Error('WhatsApp client is not connected');
        err.code = 'WA_NOT_CONNECTED';
        err.status = 409;
        throw err;
    }

    // 2. Load media bytes & validate
    let payloadBuffer;
    let payloadMime;
    let payloadFileName;
    let payloadSize;

    if (mediaAssetId) {
        const asset = await loadMediaAsset(uid, mediaAssetId);
        if (!asset) {
            const err = new Error(`Media asset ${mediaAssetId} not found or inactive`);
            err.code = 'ASSET_NOT_FOUND';
            err.status = 404;
            throw err;
        }
        payloadBuffer   = asset.buffer;
        payloadMime     = asset.mimeType;
        payloadFileName = fileName || asset.fileName;
        payloadSize     = asset.sizeBytes;
    } else if (filePath) {
        const validation = validateMediaFile(filePath, mimeType);
        if (!validation.ok) {
            const err = new Error(validation.message);
            err.code = validation.code;
            err.status = 400;
            throw err;
        }
        payloadBuffer   = fs.readFileSync(filePath);
        payloadMime     = (mimeType || '').toLowerCase().trim();
        payloadFileName = fileName || validation.fileName;
        payloadSize     = validation.sizeBytes;
    } else if (buffer && Buffer.isBuffer(buffer)) {
        payloadBuffer   = buffer;
        payloadMime     = (mimeType || '').toLowerCase().trim();
        payloadFileName = fileName || 'attachment';
        payloadSize     = buffer.length;
    } else {
        const err = new Error('No media source provided (mediaAssetId, filePath, or buffer required)');
        err.code = 'MISSING_MEDIA_SOURCE';
        err.status = 400;
        throw err;
    }

    if (!payloadBuffer || payloadSize === 0) {
        const err = new Error('Media payload is empty (0 bytes)');
        err.code = 'MEDIA_EMPTY';
        err.status = 400;
        throw err;
    }

    const normMime = payloadMime.toLowerCase().trim();
    const isPdf = normMime === 'application/pdf';
    const messageType = normMime.startsWith('video/') ? 'video'
                      : normMime.startsWith('image/') ? 'image'
                      : isPdf ? 'document' : 'media';

    const base64Data = payloadBuffer.toString('base64');
    const media = new MessageMedia(normMime, base64Data, payloadFileName);

    // 3. Resolve destination chat ID
    const chatId = await resolveDestinationChatId(s.client, phone);

    // 4. Build clean options
    const baseOpts = {
        caption: caption ? String(caption).trim() : undefined,
        sendMediaAsDocument: (isPdf || sendMediaAsDocument) ? true : undefined
    };
    const cleanOpts = cleanOptionsObject(baseOpts);

    // 5. Idempotent claim logging
    let logRow;
    const bodyText = caption ? `${caption} [${payloadFileName}]` : `[${payloadFileName}]`;

    if (idempotencyKey) {
        const claim = await logOutgoingMessageIdempotent(uid, idempotencyKey, {
            phone: digits, direction: 'outgoing', messageType,
            body: bodyText, status: 'pending'
        });
        if (!claim.created) {
            return {
                waMessageId: claim.row.wa_message_id,
                sizeBytes: payloadSize,
                fileName: payloadFileName,
                fallbackUsed: false,
                duplicate: true
            };
        }
        logRow = claim.row;
        if (mediaAssetId) {
            await runSql('UPDATE messages SET media_asset_id=$1 WHERE id=$2 AND user_id=$3', [mediaAssetId, logRow.id, uid]);
        }
    }

    // 6. Honest dispatch & fallback chain
    let result;
    let fallbackUsed = false;
    let lastError = null;

    try {
        // Attempt 1: Native media dispatch
        result = await s.client.sendMessage(chatId, media, cleanOpts);
    } catch (err1) {
        lastError = err1;

        // Check if retry with @lid is needed when "No LID for user" occurs on @c.us
        if (/No LID for user/i.test(err1.message) && chatId.endsWith('@c.us') && digits.length >= 14) {
            try {
                result = await s.client.sendMessage(`${digits}@lid`, media, cleanOpts);
                lastError = null;
            } catch (lidErr) {
                lastError = lidErr;
            }
        }

        // Attempt 2: Document fallback retry if first attempt failed and file qualifies
        if (lastError && !cleanOpts.sendMediaAsDocument && (normMime.startsWith('image/') || isPdf)) {
            try {
                const docOpts = cleanOptionsObject({ ...cleanOpts, sendMediaAsDocument: true });
                result = await s.client.sendMessage(chatId, media, docOpts);
                fallbackUsed = true;
                lastError = null;
            } catch (docErr) {
                lastError = docErr;
            }
        }

        // Attempt 3: Fail honestly if all attempts failed
        if (lastError) {
            if (logRow) {
                await runSql("UPDATE messages SET status = 'failed' WHERE id = $1", [logRow.id]).catch(() => {});
            }
            throw lastError;
        }
    }

    const waId = result?.id?._serialized || null;

    // 7. Update status to 'sent'
    if (logRow) {
        await runSql("UPDATE messages SET wa_message_id = $1, status = 'sent' WHERE id = $2", [waId, logRow.id]);
    } else {
        const created = await logMessage(uid, {
            waMessageId: waId, phone: digits, direction: 'outgoing',
            messageType, body: bodyText, status: 'sent'
        });
        if (mediaAssetId && created?.id) {
            await runSql('UPDATE messages SET media_asset_id=$1 WHERE id=$2 AND user_id=$3', [mediaAssetId, created.id, uid]);
        }
    }

    return {
        waMessageId: waId,
        sizeBytes: payloadSize,
        fileName: payloadFileName,
        fallbackUsed
    };
}

module.exports = {
    dispatchMedia,
    cleanOptionsObject
};
