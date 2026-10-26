/**
 * src/services/media-storage.js — Database-backed media asset storage.
 *
 * Source of truth for all media:
 * - Direct upload: computes SHA-256, stores BYTEA in DB (for <= 16MB) and backup on disk.
 * - Link path: SSRF-safe one-time download at save time, sniffs real MIME from magic bytes,
 *   stores bytes and SHA-256 in DB. At send time, sends exclusively from stored copy.
 * - Tenant authorization enforced on all operations.
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const http   = require('http');
const https  = require('https');
const dns    = require('dns').promises;
const { URL } = require('url');

const { query, queryGet, queryAll, runSql } = require('./db-pool');
const { validateMediaFile, ALLOWED_TYPES } = require('./messaging');
const { sanitizeOriginalFilename, resolveDisplayFilename } = require('../utils/media-filename');

const MAX_DB_BYTES = 16 * 1024 * 1024; // 16 MB cap for DB BYTEA storage
const ASSET_STORE_DIR = process.env.ASSET_STORE_DIR
    || path.join(process.env.PERSIST_ROOT || path.resolve(__dirname, '..', '..'), 'data', 'assets');

try { fs.mkdirSync(ASSET_STORE_DIR, { recursive: true }); } catch (_) {}

/**
 * Validates IP address against private/loopback/link-local ranges (SSRF defense).
 */
function isPrivateIp(ip) {
    if (!ip) return true;
    // IPv4 checks
    if (ip.startsWith('127.') || ip === '0.0.0.0') return true; // loopback
    if (ip.startsWith('10.')) return true;                       // 10.0.0.0/8
    if (ip.startsWith('192.168.')) return true;                  // 192.168.0.0/16
    if (ip.startsWith('169.254.')) return true;                  // link-local
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true; // 172.16.0.0/12

    // IPv6 checks
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true;

    return false;
}

/**
 * Sniffs MIME type from buffer magic bytes.
 */
function sniffMimeType(buffer) {
    if (!buffer || buffer.length < 4) return null;
    // PDF: %PDF
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'application/pdf';
    }
    // JPEG: 0xFF, 0xD8, 0xFF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
    }
    // PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
        return 'image/png';
    }
    // MP4: ftyp box at offset 4
    if (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
        return 'video/mp4';
    }
    return null;
}

/**
 * Downloads a URL with strict SSRF guards, redirect limit, timeout, and max size.
 */
async function downloadUrlSafe(sourceUrl, maxBytes = MAX_DB_BYTES, maxRedirects = 3) {
    let currentUrl = sourceUrl;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
        let parsed;
        try {
            parsed = new URL(currentUrl);
        } catch (_) {
            const err = new Error('Invalid URL format');
            err.code = 'INVALID_URL';
            throw err;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            const err = new Error('Only HTTP and HTTPS protocols are permitted');
            err.code = 'SSRF_BLOCKED_PROTOCOL';
            throw err;
        }

        // DNS resolution check
        const hostname = parsed.hostname;
        let addresses;
        try {
            addresses = await dns.lookup(hostname, { all: true });
        } catch (e) {
            const err = new Error(`Cannot resolve host ${hostname}`);
            err.code = 'DNS_LOOKUP_FAILED';
            throw err;
        }

        for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
                const err = new Error(`Access to private address (${addr.address}) is forbidden`);
                err.code = 'SSRF_BLOCKED_PRIVATE_IP';
                throw err;
            }
        }

        // Perform HTTP GET
        const res = await new Promise((resolve, reject) => {
            const client = parsed.protocol === 'https:' ? https : http;
            const req = client.get(currentUrl, {
                timeout: 15000,
                headers: { 'User-Agent': 'WorkPilot-MediaFetcher/1.0' }
            }, resolve);

            req.on('timeout', () => {
                req.destroy();
                const err = new Error('Download timed out');
                err.code = 'DOWNLOAD_TIMEOUT';
                reject(err);
            });
            req.on('error', reject);
        });

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location;
            if (!location) {
                const err = new Error('Redirect missing location header');
                err.code = 'INVALID_REDIRECT';
                throw err;
            }
            currentUrl = new URL(location, currentUrl).toString();
            redirectCount++;
            continue;
        }

        if (res.statusCode !== 200) {
            const err = new Error(`Server returned status code ${res.statusCode}`);
            err.code = 'DOWNLOAD_FAILED';
            throw err;
        }

        // Read chunks with size ceiling
        const chunks = [];
        let totalBytes = 0;

        return await new Promise((resolve, reject) => {
            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    res.destroy();
                    const err = new Error(`File size exceeds limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`);
                    err.code = 'MEDIA_TOO_LARGE';
                    reject(err);
                    return;
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    const err = new Error('Downloaded file is empty');
                    err.code = 'MEDIA_EMPTY';
                    reject(err);
                    return;
                }
                resolve({ buffer, finalUrl: currentUrl });
            });

            res.on('error', reject);
        });
    }

    const err = new Error('Too many redirects');
    err.code = 'TOO_MANY_REDIRECTS';
    throw err;
}

/**
 * Stores a media asset from an uploaded file on disk.
 */
async function storeMediaAssetFromUpload(userId, { projectId, unitId = null, assetType, fileName, filePath, mimeType, reraVerified = false }) {
    const validation = validateMediaFile(filePath, mimeType);
    if (!validation.ok) {
        const err = new Error(validation.message);
        err.code = validation.code;
        throw err;
    }

    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const sizeBytes = buf.length;
    const data = sizeBytes <= MAX_DB_BYTES ? buf : null;

    const res = await query(`
        INSERT INTO media_assets (
            user_id, project_id, unit_id, asset_type, file_name, storage_path,
            mime_type, size_bytes, sha256, data, source_type, uploaded_by, rera_verified, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'upload', $11, $12, 1)
        RETURNING *
    `, [
        userId, projectId, unitId, assetType, fileName, filePath,
        mimeType, sizeBytes, sha256, data, userId, reraVerified ? 1 : 0
    ]);

    const row = res.rows[0];
    if (row) {
        row.display_name = resolveDisplayFilename(row.file_name, row.user_id);
    }
    return row;
}

/**
 * Downloads a URL once at save time, validates magic bytes, and stores in DB.
 */
async function storeMediaAssetFromUrl(userId, { projectId, unitId = null, assetType, url, fileName = null, reraVerified = false }) {
    const { buffer, finalUrl } = await downloadUrlSafe(url, MAX_DB_BYTES);
    const sniffedMime = sniffMimeType(buffer);
    if (!sniffedMime || !ALLOWED_TYPES[sniffedMime]) {
        const err = new Error(`URL content does not match allowed types (PDF, JPG, PNG, MP4). Detected: ${sniffedMime || 'unknown'}`);
        err.code = 'MEDIA_TYPE_NOT_ALLOWED';
        throw err;
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const sizeBytes = buffer.length;

    // Save backup file on disk
    const ext = sniffedMime === 'application/pdf' ? '.pdf'
              : sniffedMime === 'image/png' ? '.png'
              : sniffedMime === 'video/mp4' ? '.mp4' : '.jpg';
    const safeBaseName = (fileName || path.basename(new URL(finalUrl).pathname) || 'downloaded_asset')
        .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const diskFileName = `${userId}_${Date.now()}_${safeBaseName}${safeBaseName.endsWith(ext) ? '' : ext}`;
    const storagePath = path.join(ASSET_STORE_DIR, diskFileName);
    fs.writeFileSync(storagePath, buffer);

    const displayFileName = sanitizeOriginalFilename(fileName || diskFileName, diskFileName);

    const res = await query(`
        INSERT INTO media_assets (
            user_id, project_id, unit_id, asset_type, file_name, storage_path,
            mime_type, size_bytes, sha256, data, source_type, source_url, fetched_at, uploaded_by, rera_verified, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'url', $11, CURRENT_TIMESTAMP, $12, $13, 1)
        RETURNING *
    `, [
        userId, projectId, unitId, assetType, displayFileName, storagePath,
        sniffedMime, sizeBytes, sha256, buffer, url, userId, reraVerified ? 1 : 0
    ]);

    const row = res.rows[0];
    if (row) {
        row.display_name = resolveDisplayFilename(row.file_name, row.user_id);
    }
    return row;
}

/**
 * Loads media asset bytes from the database (source of truth) with checksum validation.
 * Enforces tenant isolation: userId must match asset owner.
 */
async function loadMediaAsset(userId, assetId) {
    const row = await queryGet(`
        SELECT id, user_id, project_id, unit_id, asset_type, file_name, storage_path,
               mime_type, size_bytes, sha256, data, source_type, source_url, is_active
        FROM media_assets
        WHERE id = $1 AND user_id = $2
    `, [assetId, userId]);

    if (!row) {
        return null;
    }

    if (!row.is_active) {
        const err = new Error(`Media asset ${assetId} is inactive or marked unavailable.`);
        err.code = 'ASSET_UNAVAILABLE';
        err.status = 410;
        throw err;
    }

    let buffer;
    // 1. Source of truth: database BYTEA
    if (row.data && Buffer.isBuffer(row.data) && row.data.length > 0) {
        buffer = row.data;
    } else if (row.storage_path && fs.existsSync(row.storage_path)) {
        // 2. Fallback to storage_path with checksum assertion
        buffer = fs.readFileSync(row.storage_path);
        // Backfill data into DB if <= 16MB
        if (buffer.length <= MAX_DB_BYTES) {
            await runSql('UPDATE media_assets SET data = $1 WHERE id = $2', [buffer, row.id]).catch(() => {});
        }
    } else {
        await runSql('UPDATE media_assets SET is_active = 0 WHERE id = $1', [row.id]).catch(() => {});
        const err = new Error(`Media asset ${assetId} (${row.file_name}) file content is missing on server.`);
        err.code = 'ASSET_FILE_MISSING';
        err.status = 404;
        throw err;
    }

    // Verify SHA-256 checksum if recorded
    const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (row.sha256 && row.sha256 !== computedHash) {
        const err = new Error(`Media asset ${assetId} failed SHA-256 integrity verification.`);
        err.code = 'ASSET_CHECKSUM_MISMATCH';
        err.status = 500;
        throw err;
    }

    const display = resolveDisplayFilename(row.file_name, row.user_id);

    return {
        id: row.id,
        userId: row.user_id,
        projectId: row.project_id,
        assetType: row.asset_type,
        fileName: display,
        mimeType: row.mime_type,
        sizeBytes: buffer.length,
        sha256: computedHash,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        buffer,
        base64Data: buffer.toString('base64')
    };
}

module.exports = {
    storeMediaAssetFromUpload,
    storeMediaAssetFromUrl,
    loadMediaAsset,
    downloadUrlSafe,
    sniffMimeType,
    isPrivateIp,
    MAX_DB_BYTES
};
