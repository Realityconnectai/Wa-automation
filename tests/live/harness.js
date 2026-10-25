// tests/live/harness.js — Master test harness and allowlist guard for Workpilot live verification

const path = require('path');
const dotenv = require('dotenv');

// Load environment
dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * Approved test recipient allowlist.
 * Can be populated via environment variables TEST_RECIPIENT_PRIMARY / TEST_RECIPIENT_SECONDARY
 * or configured directly here by the authorized operator.
 */
const ALLOWED_TEST_RECIPIENTS = new Set(
    [
        process.env.TEST_RECIPIENT_PRIMARY,
        process.env.TEST_RECIPIENT_SECONDARY,
        process.env.TEST_RECIPIENT_ALLOWLIST ? process.env.TEST_RECIPIENT_ALLOWLIST.split(',') : null
    ]
        .flat()
        .filter(Boolean)
        .map(n => String(n).trim().replace(/[^\d+]/g, ''))
);

// Deliberate negative test numbers (safe to test rejection paths)
const NEGATIVE_TEST_RECIPIENTS = new Set([
    '+910000000000',
    '910000000000',
    '0000000000'
]);

/**
 * Strict safety guard.
 * Throws an Error if a phone number is not explicitly in the allowlist.
 * Negative test recipients are permitted only when allowNegative is true.
 *
 * @param {string} phone
 * @param {boolean} [allowNegative=false]
 */
function assertRecipientAllowlisted(phone, allowNegative = false) {
    if (!phone) {
        throw new Error('SAFETY_VIOLATION: Recipient phone number is empty or undefined');
    }

    const clean = String(phone).trim().replace(/[^\d+]/g, '');

    if (allowNegative && (NEGATIVE_TEST_RECIPIENTS.has(clean) || NEGATIVE_TEST_RECIPIENTS.has(clean.replace(/^\+/, '')))) {
        return clean;
    }

    if (ALLOWED_TEST_RECIPIENTS.size === 0) {
        const err = new Error(
            'SAFETY_LOCKOUT: No test recipients are allowlisted in §0 / environment. ' +
            'Live WhatsApp outbound messages are blocked until owner provides TEST_RECIPIENT_PRIMARY.'
        );
        err.code = 'ALLOWLIST_EMPTY';
        throw err;
    }

    const isAllowed = ALLOWED_TEST_RECIPIENTS.has(clean) || 
                      ALLOWED_TEST_RECIPIENTS.has(`+${clean}`) || 
                      ALLOWED_TEST_RECIPIENTS.has(clean.replace(/^\+/, ''));

    if (!isAllowed) {
        const err = new Error(
            `SAFETY_VIOLATION: Phone number ${clean.slice(0, 4)}****${clean.slice(-2)} is not in the approved test allowlist. ` +
            'Outbound send was blocked.'
        );
        err.code = 'RECIPIENT_NOT_ALLOWLISTED';
        throw err;
    }

    return clean;
}

/**
 * Checks whether allowlist is populated without throwing.
 */
function isAllowlistConfigured() {
    return ALLOWED_TEST_RECIPIENTS.size > 0;
}

/**
 * Returns current allowlist summary (redacted for safe logging).
 */
function getAllowlistSummary() {
    return Array.from(ALLOWED_TEST_RECIPIENTS).map(p => 
        p.length >= 6 ? `${p.slice(0, 4)}****${p.slice(-2)}` : '****'
    );
}

module.exports = {
    assertRecipientAllowlisted,
    isAllowlistConfigured,
    getAllowlistSummary,
    ALLOWED_TEST_RECIPIENTS,
    NEGATIVE_TEST_RECIPIENTS
};
