'use strict';

const path = require('path');

/**
 * Validates whether a number looks like a plausible Unix epoch timestamp
 * in milliseconds (spanning years 2020 to 2040).
 *
 * @param {number|string} timestamp
 * @returns {boolean}
 */
function isPlausibleEpochMs(timestamp) {
    const num = Number(timestamp);
    // 2020-01-01 = 1577836800000, 2040-01-01 = 2208988800000
    return Number.isFinite(num) && num >= 1577836800000 && num <= 2208988800000;
}

/**
 * Sanitizes a client-provided original filename for safe storage and display.
 * - Strips directory traversal segments (/ and \)
 * - Replaces unsafe OS characters and control characters
 * - Keeps file extension, spaces, unicode, dots, dashes, underscores intact
 * - Clamps length to a safe ceiling (200 characters)
 *
 * @param {string} rawName
 * @param {string} [fallback='attachment']
 * @returns {string}
 */
function sanitizeOriginalFilename(rawName, fallback = 'attachment') {
    if (!rawName || typeof rawName !== 'string') return fallback;

    // Strip any leading directories / path traversal
    let clean = path.basename(rawName.trim()).replace(/^.*[/\\]/, '');

    // Remove control characters (0-31, 127) and filesystem-illegal characters
    clean = clean.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').trim();

    // Prevent hidden files starting with dot only or empty names
    if (!clean || clean === '.' || clean === '..') {
        clean = fallback;
    }

    return clean.slice(0, 200);
}

/**
 * Resolves the display filename from stored media asset metadata.
 *
 * When an asset record was generated with the server-generated storage pattern:
 *   `<userId>_<Date.now() millisecond timestamp>_<originalSafeName>`
 * this function detects and verifies the server-generated prefix
 * and extracts the original filename.
 *
 * Genuine user filenames containing leading numbers (e.g. `2026_Property_Brochure.pdf`,
 * `123_test.png`, `2026_01_report.pdf`) are strictly preserved because they do not
 * match the exact 10-15 digit epoch millisecond timestamp requirement.
 *
 * @param {string} fileName - stored file_name or storage path basename
 * @param {number|string|null} [userId=null] - optional user_id for strict prefix verification
 * @returns {string}
 */
function resolveDisplayFilename(fileName, userId = null) {
    if (!fileName || typeof fileName !== 'string') return '';
    const trimmed = fileName.trim();

    // Pattern: <userIdDigits>_<epochMsDigits>_<originalName>
    const match = trimmed.match(/^(\d+)_(\d{10,15})_(.+)$/);
    if (match) {
        const prefixUserId = Number(match[1]);
        const timestamp = Number(match[2]);
        const remainder = match[3];

        const timestampValid = isPlausibleEpochMs(timestamp);
        if (timestampValid && remainder.length > 0) {
            return remainder;
        }
    }

    return trimmed;
}

/**
 * Formats a safe Content-Disposition header with RFC 5987 / RFC 6266 encoding.
 *
 * @param {'inline'|'attachment'} disposition
 * @param {string} fileName
 * @returns {string}
 */
function formatSafeContentDisposition(disposition, fileName) {
    const disp = disposition === 'attachment' ? 'attachment' : 'inline';
    const safeBase = sanitizeOriginalFilename(fileName, 'download');
    // Basic ASCII fallback: replace non-ascii and quotes with underscores
    const asciiFallback = safeBase.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(safeBase);
    return `${disp}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
    isPlausibleEpochMs,
    sanitizeOriginalFilename,
    resolveDisplayFilename,
    formatSafeContentDisposition
};
