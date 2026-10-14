'use strict';

/**
 * tests/phone-masking.test.js
 *
 * Unit tests for src/utils/phone-mask.js:
 *   - maskPhoneNumber: international formats, short numbers, malformed input.
 *   - isAuthorizedForFullPhone: role-based access decisions.
 *   - maskEntityPhones: non-mutating, recursive masking of response objects.
 *
 * No real database or server is started.
 */

const { maskPhoneNumber, isAuthorizedForFullPhone, isMaskedPhone, maskEntityPhones } = require('../src/utils/phone-mask');

// maskPhoneNumber tests
describe('maskPhoneNumber', () => {
    test('null returns null', () => expect(maskPhoneNumber(null)).toBeNull());
    test('undefined returns undefined', () => expect(maskPhoneNumber(undefined)).toBeUndefined());
    test('empty string returns empty string', () => expect(maskPhoneNumber('')).toBe(''));

    test('already-masked value is returned unchanged', () => {
        const masked = '+91 98765 XXXXX';
        expect(maskPhoneNumber(masked)).toBe(masked);
    });

    test('10-digit national number', () => {
        const result = maskPhoneNumber('9876543210');
        expect(result).toBe('98765XXXXX');
    });

    test('12-digit E.164 Indian number (+91)', () => {
        const result = maskPhoneNumber('919876543210');
        expect(result).toMatch(/^\+91/);
        expect(result).toContain('XXXXX');
        expect(result).not.toContain('3210');
    });

    test('US NANP 11-digit number', () => {
        const result = maskPhoneNumber('12125551234');
        expect(result).toMatch(/^\+1/);
        expect(result).toContain('XXXXX');
    });

    test('13-digit Portugal +351', () => {
        // 351 (3-digit CC) + 912345678 (9 digits national) = 12 digits total
        // For a true 13-digit E.164: +351 + 10-digit national = 3513512345678
        const result = maskPhoneNumber('3513512345678');
        expect(result).toMatch(/^\+351/);
        expect(result).toContain('XXXXX');
    });

    test('short number 4 digits', () => {
        const result = maskPhoneNumber('1234');
        expect(result).toMatch(/^12X/);
    });

    test('very short number 3 digits becomes all X', () => {
        expect(maskPhoneNumber('123')).toBe('XXX');
    });

    test('cosmetic characters are stripped before masking', () => {
        const result = maskPhoneNumber('+91 98765-43210');
        expect(result).toContain('XXXXX');
        expect(result).not.toContain('43210');
    });

    test('non-string non-number input is returned as-is', () => {
        const obj = {};
        expect(maskPhoneNumber(obj)).toBe(obj);
    });

    test('numeric input is coerced to string and masked', () => {
        expect(maskPhoneNumber(9876543210)).toBe('98765XXXXX');
    });
});

// isMaskedPhone tests
describe('isMaskedPhone', () => {
    test('returns true for X-masked string', () => expect(isMaskedPhone('+91 98765 XXXXX')).toBe(true));
    test('returns true for *-masked string', () => expect(isMaskedPhone('****1234')).toBe(true));
    test('returns false for plain numeric string', () => expect(isMaskedPhone('9876543210')).toBe(false));
    test('returns false for non-string', () => {
        expect(isMaskedPhone(12345)).toBe(false);
        expect(isMaskedPhone(null)).toBe(false);
    });
});

// isAuthorizedForFullPhone tests
describe('isAuthorizedForFullPhone', () => {
    test('admin role is authorized', () => expect(isAuthorizedForFullPhone({ role: 'admin' })).toBe(true));
    test('user role is NOT authorized', () => expect(isAuthorizedForFullPhone({ role: 'user' })).toBe(false));
    test('unknown role is NOT authorized', () => expect(isAuthorizedForFullPhone({ role: 'superuser' })).toBe(false));
    test('null user is NOT authorized', () => expect(isAuthorizedForFullPhone(null)).toBe(false));
    test('undefined user is NOT authorized', () => expect(isAuthorizedForFullPhone(undefined)).toBe(false));
    test('can_view_full_phones flag overrides role', () => {
        expect(isAuthorizedForFullPhone({ role: 'user', can_view_full_phones: true })).toBe(true);
    });
});

// maskEntityPhones tests
describe('maskEntityPhones', () => {
    const admin = { role: 'admin' };
    const user = { role: 'user' };

    test('admin sees unmasked phone', () => {
        const result = maskEntityPhones({ phone: '9876543210' }, admin);
        expect(result.phone).toBe('9876543210');
    });

    test('user gets masked phone', () => {
        const result = maskEntityPhones({ phone: '9876543210' }, user);
        expect(result.phone).toBe('98765XXXXX');
    });

    test('does not mutate the original object', () => {
        const original = { phone: '9876543210' };
        maskEntityPhones(original, user);
        expect(original.phone).toBe('9876543210');
    });

    test('masks arrays of entities', () => {
        const result = maskEntityPhones([{ phone: '9876543210' }, { phone: '8765432109' }], user);
        expect(result[0].phone).toBe('98765XXXXX');
        expect(result[1].phone).toBe('87654XXXXX');
    });

    test('masks contact_phone field', () => {
        expect(maskEntityPhones({ contact_phone: '9876543210' }, user).contact_phone).toBe('98765XXXXX');
    });

    test('masks sender_phone field', () => {
        expect(maskEntityPhones({ sender_phone: '9876543210' }, user).sender_phone).toBe('98765XXXXX');
    });

    test('masks nested leads array', () => {
        const data = { leads: [{ phone: '9876543210' }], stats: { total: 1 } };
        const result = maskEntityPhones(data, user);
        expect(result.leads[0].phone).toBe('98765XXXXX');
        expect(result.stats.total).toBe(1);
    });

    test('masks nested deals array', () => {
        const result = maskEntityPhones({ deals: [{ phone: '9876543210', stage: 'new' }] }, user);
        expect(result.deals[0].phone).toBe('98765XXXXX');
    });

    test('masks nested pending array', () => {
        const result = maskEntityPhones({ pending: [{ phone: '9876543210', message_count: 5 }] }, user);
        expect(result.pending[0].phone).toBe('98765XXXXX');
    });

    test('handles null phone gracefully', () => {
        expect(maskEntityPhones({ phone: null }, user).phone).toBeNull();
    });

    test('handles entity with no phone field', () => {
        const result = maskEntityPhones({ name: 'No phone' }, user);
        expect(result.phone).toBeUndefined();
    });

    test('handles null data gracefully', () => expect(maskEntityPhones(null, user)).toBeNull());
    test('handles undefined data gracefully', () => expect(maskEntityPhones(undefined, user)).toBeUndefined());

    test('admin array sees all numbers unmasked', () => {
        const result = maskEntityPhones([{ phone: '9876543210' }, { phone: '8765432109' }], admin);
        expect(result[0].phone).toBe('9876543210');
        expect(result[1].phone).toBe('8765432109');
    });

    test('masks nested deal object', () => {
        const result = maskEntityPhones({ deal: { phone: '9876543210', stage: 'new' } }, user);
        expect(result.deal.phone).toBe('98765XXXXX');
    });

    test('masks nested activities array', () => {
        const result = maskEntityPhones({ activities: [{ phone: '9876543210', type: 'note' }] }, user);
        expect(result.activities[0].phone).toBe('98765XXXXX');
    });

    test('masks nested contacts array', () => {
        const result = maskEntityPhones({ contacts: [{ phone: '9876543210', name: 'Charlie' }] }, user);
        expect(result.contacts[0].phone).toBe('98765XXXXX');
    });

    test('masks nested messages array', () => {
        const result = maskEntityPhones({ messages: [{ phone: '9876543210', body: 'Hi' }] }, user);
        expect(result.messages[0].phone).toBe('98765XXXXX');
    });
});
