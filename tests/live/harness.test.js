// tests/live/harness.test.js — Verification of allowlist guard and safety constraints

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRecipientAllowlisted, NEGATIVE_TEST_RECIPIENTS } = require('./harness');

test('assertRecipientAllowlisted throws on empty number', () => {
    assert.throws(() => {
        assertRecipientAllowlisted('');
    }, /SAFETY_VIOLATION/);
});

test('assertRecipientAllowlisted permits negative test numbers when allowNegative=true', () => {
    const res = assertRecipientAllowlisted('+910000000000', true);
    assert.strictEqual(res, '+910000000000');
});

test('assertRecipientAllowlisted blocks negative test numbers when allowNegative=false', () => {
    assert.throws(() => {
        assertRecipientAllowlisted('+910000000000', false);
    }, /(SAFETY_LOCKOUT|SAFETY_VIOLATION)/);
});

test('assertRecipientAllowlisted blocks arbitrary numbers when allowlist is empty', () => {
    assert.throws(() => {
        assertRecipientAllowlisted('+919876543210');
    }, /(SAFETY_LOCKOUT|SAFETY_VIOLATION)/);
});
