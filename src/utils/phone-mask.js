/**
 * src/utils/phone-mask.js — Role-aware anti-theft phone number masking.
 *
 * Implements data protection for field agents and unauthorized roles:
 * - Authorized roles (admin) receive unmasked canonical numbers.
 * - Unauthorized roles (user / agent / public) receive masked phone numbers.
 * - Canonical numbers in PostgreSQL remain untouched.
 * - Non-mutating: creates new objects/arrays during response serialization.
 * - Supports international numbers, short numbers, and non-Indian formats.
 * - Never leaks raw phone numbers in debug or nested payload fields.
 */
'use strict';

const { queryGet } = require('../services/db-pool');
const { tryNormalizePhone } = require('./validate');

/**
 * Authorization policy:
 * Only 'admin' role (or an explicit boolean flag) is authorized to view full phone numbers.
 * All other roles (such as 'user') default to masked view.
 */
function isAuthorizedForFullPhone(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (user.can_view_full_phones === true || user.canViewFullPhones === true) return true;
    return false;
}

/**
 * Checks whether a string is already in masked format (contains 'X', '*', or '•').
 */
function isMaskedPhone(phone) {
    if (typeof phone !== 'string') return false;
    return /[X*•]/.test(phone);
}

/**
 * Masks a phone number string:
 * - Preserves country calling code (e.g. +91, +1, +44, +351).
 * - Shows first 5 digits of the national number.
 * - Replaces trailing digits with 'XXXXX'.
 * - Handles short numbers and malformed inputs gracefully without throwing.
 */
function maskPhoneNumber(phone) {
    if (phone === null || phone === undefined) return phone;
    if (typeof phone !== 'string' && typeof phone !== 'number') return phone;

    const raw = String(phone).trim();
    if (!raw) return raw;
    if (isMaskedPhone(raw)) return raw;

    const hasPlus = raw.startsWith('+');
    const digits = raw.replace(/\D/g, '');

    if (!digits) return raw;

    // Very short numbers (<= 3 digits)
    if (digits.length <= 3) {
        return 'X'.repeat(digits.length);
    }

    // Short numbers (4 to 6 digits)
    if (digits.length <= 6) {
        return digits.slice(0, 2) + 'X'.repeat(digits.length - 2);
    }

    // Numbers between 7 and 9 digits
    if (digits.length < 10) {
        return digits.slice(0, 3) + 'X'.repeat(digits.length - 3);
    }

    // Exactly 10 digits (assumed national number without country code)
    if (digits.length === 10) {
        return `${digits.slice(0, 5)}XXXXX`;
    }

    // 11 digits: US/NANP (+1) or national number
    if (digits.length === 11 && digits.startsWith('1')) {
        const national = digits.slice(1);
        return `+1 ${national.slice(0, 5)} XXXXX`;
    }

    // 12 digits: 2-digit country code (e.g., +91 India, +44 UK, +33 France, +49 Germany)
    if (digits.length === 12) {
        const cc = digits.slice(0, 2);
        const national = digits.slice(2);
        return `+${cc} ${national.slice(0, 5)} XXXXX`;
    }

    // 13 digits: 3-digit country code (e.g., +351, +971) or 2-digit CC + 11 digits
    if (digits.length === 13) {
        const cc = digits.slice(0, 3);
        const national = digits.slice(3);
        return `+${cc} ${national.slice(0, 5)} XXXXX`;
    }

    // Long international numbers (14-15 digits E.164 max)
    const cc = digits.slice(0, digits.length - 10);
    const national = digits.slice(digits.length - 10);
    return `+${cc} ${national.slice(0, 5)} XXXXX`;
}

/**
 * Resolves a :phone URL parameter for a specific tenant:
 * - If the parameter is already canonical digits, normalizes it.
 * - If the parameter is masked (e.g. '+91 98765 XXXXX'), queries the tenant's
 *   contacts, messages, and deals to resolve the true canonical phone number.
 */
async function resolvePhoneForTenant(userId, inputPhone) {
    if (!inputPhone) return '';
    const trimmed = String(inputPhone).trim();

    if (isMaskedPhone(trimmed)) {
        // Extract visible digits (e.g., "+91 98765 XXXXX" -> "9198765")
        const visibleDigits = trimmed.replace(/[^0-9]/g, '');
        if (visibleDigits.length >= 4) {
            // Find tenant record with matching prefix
            const match = await queryGet(
                `SELECT phone FROM contacts WHERE user_id = $1 AND phone LIKE $2 LIMIT 1`,
                [userId, `${visibleDigits}%`]
            ) || await queryGet(
                `SELECT phone FROM messages WHERE user_id = $1 AND phone LIKE $2 LIMIT 1`,
                [userId, `${visibleDigits}%`]
            ) || await queryGet(
                `SELECT phone FROM crm_deals WHERE user_id = $1 AND phone LIKE $2 LIMIT 1`,
                [userId, `${visibleDigits}%`]
            );

            if (match && match.phone) {
                return match.phone;
            }
        }
    }

    // Standard normalization fallback
    const norm = tryNormalizePhone(trimmed);
    if (norm) return norm;

    // Fallback: strip cosmetic characters
    return trimmed.replace(/[\s()+\-.]/g, '');
}

/**
 * Non-mutating entity phone masking:
 * Recursively masks phone attributes across objects and arrays for unauthorized callers.
 */
function maskEntityPhones(data, user) {
    if (isAuthorizedForFullPhone(user)) {
        return data; // Authorized role sees raw numbers
    }

    if (data === null || data === undefined) return data;

    if (Array.isArray(data)) {
        return data.map(item => maskEntityPhones(item, user));
    }

    if (typeof data !== 'object') return data;

    const clone = { ...data };

    // Standard phone fields
    if ('phone' in clone && clone.phone !== null && clone.phone !== undefined) {
        clone.phone = maskPhoneNumber(clone.phone);
    }
    if ('contact_phone' in clone && clone.contact_phone !== null && clone.contact_phone !== undefined) {
        clone.contact_phone = maskPhoneNumber(clone.contact_phone);
    }
    if ('sender_phone' in clone && clone.sender_phone !== null && clone.sender_phone !== undefined) {
        clone.sender_phone = maskPhoneNumber(clone.sender_phone);
    }

    // Common nested structures
    if (Array.isArray(clone.recentMessages)) {
        clone.recentMessages = clone.recentMessages.map(m => maskEntityPhones(m, user));
    }
    if (Array.isArray(clone.deals)) {
        clone.deals = clone.deals.map(d => maskEntityPhones(d, user));
    }
    if (Array.isArray(clone.leads)) {
        clone.leads = clone.leads.map(l => maskEntityPhones(l, user));
    }
    if (Array.isArray(clone.pending)) {
        clone.pending = clone.pending.map(p => maskEntityPhones(p, user));
    }
    if (Array.isArray(clone.contacts)) {
        clone.contacts = clone.contacts.map(c => maskEntityPhones(c, user));
    }
    if (Array.isArray(clone.messages)) {
        clone.messages = clone.messages.map(m => maskEntityPhones(m, user));
    }
    if (Array.isArray(clone.activities)) {
        clone.activities = clone.activities.map(a => maskEntityPhones(a, user));
    }
    if (Array.isArray(clone.appointments)) {
        clone.appointments = clone.appointments.map(a => maskEntityPhones(a, user));
    }
    if (clone.deal && typeof clone.deal === 'object') {
        clone.deal = maskEntityPhones(clone.deal, user);
    }
    if (clone.analysis && typeof clone.analysis === 'object') {
        clone.analysis = maskEntityPhones(clone.analysis, user);
    }

    return clone;
}

module.exports = {
    isAuthorizedForFullPhone,
    isMaskedPhone,
    maskPhoneNumber,
    resolvePhoneForTenant,
    maskEntityPhones
};
