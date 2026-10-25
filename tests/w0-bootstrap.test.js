// tests/w0-bootstrap.test.js — Automated verification of W0 Bootstrap & Error Truncation fixes

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRecipientAllowlisted } = require('./live/harness');
const { errorHandler } = require('../src/utils/errors');

test('W0: assertRecipientAllowlisted enforces safety lock when allowlist is unpopulated', () => {
    assert.throws(() => {
        assertRecipientAllowlisted('+919876543210', false);
    }, /(SAFETY_LOCKOUT|SAFETY_VIOLATION)/);
});

test('W0: assertRecipientAllowlisted permits designated negative test numbers when flag is set', () => {
    const safe = assertRecipientAllowlisted('+910000000000', true);
    assert.strictEqual(safe, '+910000000000');
});

test('W0: errorHandler preserves 502 upstream WhatsApp errors and does not mask them to generic 500', () => {
    const err = new Error('No LID for user');
    err.status = 502;
    err.code = 'NO_LID_FOR_USER';

    let responseStatus = null;
    let responseBody = null;

    const res = {
        headersSent: false,
        status(code) {
            responseStatus = code;
            return this;
        },
        json(payload) {
            responseBody = payload;
            return this;
        }
    };

    errorHandler(err, { method: 'POST', originalUrl: '/api/messages/send' }, res, () => {});

    assert.strictEqual(responseStatus, 502);
    assert.strictEqual(responseBody.success, false);
    assert.strictEqual(responseBody.error, 'No LID for user');
    assert.strictEqual(responseBody.code, 'NO_LID_FOR_USER');
});

test('W0: errorHandler un-truncates single-character errors like "t"', () => {
    const err = new Error('t');
    err.status = 502;
    err.code = 'WA_DISPATCH_FAILED';

    let responseStatus = null;
    let responseBody = null;

    const res = {
        headersSent: false,
        status(code) {
            responseStatus = code;
            return this;
        },
        json(payload) {
            responseBody = payload;
            return this;
        }
    };

    errorHandler(err, { method: 'POST', originalUrl: '/api/messages/send' }, res, () => {});

    assert.strictEqual(responseStatus, 502);
    assert.strictEqual(responseBody.success, false);
    assert.notStrictEqual(responseBody.error, 't');
    assert.strictEqual(responseBody.error, 'WA_DISPATCH_FAILED');
});
