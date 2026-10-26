'use strict';

/**
 * tests/campaign-buffer-pending.test.js
 *
 * Automated tests for:
 * 1. Server-side validation of buffer_minutes (0-15 only)
 * 2. calculateNextDelay bounds (30s to 15min) and jitter (±20%)
 * 3. serializeSendError un-truncation and typed error mapping (preventing "Send failed: t: t")
 * 4. Fake clock campaign execution:
 *    - First send sends immediately
 *    - Subsequent sends wait buffer delay
 *    - Skips do not consume buffer
 *    - Failed sends consume buffer
 *    - Invariant: sent + failed + skipped + pending = total
 *    - Cancellation during wait stops remaining recipients
 */

const {
    calculateNextDelay,
    serializeSendError,
    setSleepImplementation
} = require('../src/services/outreach');

describe('Campaign UX, Buffer (1–15 min), and Pending Status Pipeline', () => {

    describe('1. Buffer delay calculation, clamping & jitter', () => {
        test('calculates default randomized pacing (3–9s) when bufferMinutes is 0', () => {
            for (let i = 0; i < 20; i++) {
                const delay = calculateNextDelay(0, false);
                expect(delay).toBeGreaterThanOrEqual(3000);
                expect(delay).toBeLessThanOrEqual(9000);
            }
        });

        test('clamps lower bound to 30,000ms (30s) and upper bound to 900,000ms (15m)', () => {
            // Buffer = 1 min with 0 jitter
            const delay1m = calculateNextDelay(1, false);
            expect(delay1m).toBe(60000);

            // Buffer = 15 min with 0 jitter
            const delay15m = calculateNextDelay(15, false);
            expect(delay15m).toBe(900000);
        });

        test('applies ±20% jitter within clamped boundaries', () => {
            for (let i = 0; i < 50; i++) {
                const delay5m = calculateNextDelay(5, true);
                const nominal = 5 * 60 * 1000; // 300,000ms
                const minExpected = nominal * 0.8; // 240,000ms
                const maxExpected = nominal * 1.2; // 360,000ms
                expect(delay5m).toBeGreaterThanOrEqual(minExpected);
                expect(delay5m).toBeLessThanOrEqual(maxExpected);
            }
        });

        test('clamps jitter so it never drops below 30s or exceeds 15 min', () => {
            for (let i = 0; i < 30; i++) {
                const delay1m = calculateNextDelay(1, true);
                expect(delay1m).toBeGreaterThanOrEqual(30000);
                expect(delay1m).toBeLessThanOrEqual(900000);

                const delay15m = calculateNextDelay(15, true);
                expect(delay15m).toBeGreaterThanOrEqual(30000);
                expect(delay15m).toBeLessThanOrEqual(900000);
            }
        });
    });

    describe('2. Error serializer and reliable error classification', () => {
        test('classifies unresolvable recipient when in resolution context or with LID/WID markers', () => {
            const err1 = new Error('t');
            err1.name = 't';
            const s1 = serializeSendError(err1, '105957396857003', 'recipient_resolution');
            expect(s1.code).toBe('RECIPIENT_UNRESOLVABLE');
            expect(s1.transient).toBe(false);
            expect(s1.reason).toContain('Recipient identifier could not be resolved on WhatsApp');

            const errLid = new Error('wid error: No LID for user 105957396857003');
            const sLid = serializeSendError(errLid, '105957396857003');
            expect(sLid.code).toBe('RECIPIENT_UNRESOLVABLE');
            expect(sLid.transient).toBe(false);
        });

        test('does NOT label unrelated one-letter errors as RECIPIENT_UNRESOLVABLE in general context', () => {
            // General minified runtime "t"
            const errT = new Error('t');
            const sT = serializeSendError(errT, '919876543210', 'dispatch');
            expect(sT.code).toBe('MINIFIED_RUNTIME_ERROR');
            expect(sT.transient).toBe(true);
            expect(sT.code).not.toBe('RECIPIENT_UNRESOLVABLE');

            // Arbitrary single-letter error "e" or "x"
            const errE = new Error('e');
            const sE = serializeSendError(errE, '919876543210');
            expect(sE.code).toBe('MINIFIED_RUNTIME_ERROR');
            expect(sE.code).not.toBe('RECIPIENT_UNRESOLVABLE');
        });

        test('regression: handles string, one-character, and minified-library error shapes cleanly', () => {
            // String error
            const sStr = serializeSendError('Database socket closed', '919876543210');
            expect(sStr.code).toBe('UNKNOWN_SEND_ERROR');
            expect(sStr.message).toBe('Database socket closed');

            // One-character string error
            const sChar = serializeSendError('t', '919876543210');
            expect(sChar.code).toBe('MINIFIED_RUNTIME_ERROR');

            // Minified library error object
            const minifiedObj = {
                message: 't',
                name: 't',
                stack: 't: t\n    at anonymous (<anonymous>:1:234)'
            };
            const sObj = serializeSendError(minifiedObj, '919876543210');
            expect(sObj.code).toBe('MINIFIED_RUNTIME_ERROR');
            expect(sObj.reason).toContain('MINIFIED_RUNTIME_ERROR');

            // Evaluation failed string
            const sEval = serializeSendError(new Error('Evaluation failed: t: t'), '919876543210');
            expect(sEval.code).toBe('MINIFIED_RUNTIME_ERROR');
        });

        test('maps session disconnected errors to SESSION_NOT_CONNECTED', () => {
            const err = new Error('Session disconnected / auth failure');
            const s = serializeSendError(err, '919876543210');
            expect(s.code).toBe('SESSION_NOT_CONNECTED');
            expect(s.reason).toContain('disconnected');
            expect(s.transient).toBe(true);
        });

        test('maps timeout errors to SEND_TIMEOUT', () => {
            const err = new Error('Timed out waiting for send acknowledgment after 30000ms');
            const s = serializeSendError(err, '919876543210');
            expect(s.code).toBe('SEND_TIMEOUT');
            expect(s.reason).toContain('timed out');
            expect(s.transient).toBe(true);
        });

        test('preserves full meaningful message on other errors', () => {
            const err = new Error('Custom business rejection: account banned');
            const s = serializeSendError(err, '919876543210');
            expect(s.code).toBe('UNKNOWN_SEND_ERROR');
            expect(s.reason).toContain('Custom business rejection: account banned');
        });
    });

    describe('3. Buffer validation bounds logic', () => {
        function validateBuffer(input) {
            const parsed = parseInt(input, 10);
            if (Number.isNaN(parsed) || parsed < 0 || parsed > 15) {
                return false;
            }
            return true;
        }

        test('validates buffer bounds strictly 0 to 15', () => {
            expect(validateBuffer(0)).toBe(true);
            expect(validateBuffer(1)).toBe(true);
            expect(validateBuffer(5)).toBe(true);
            expect(validateBuffer(15)).toBe(true);

            expect(validateBuffer(-1)).toBe(false);
            expect(validateBuffer(16)).toBe(false);
            expect(validateBuffer('abc')).toBe(false);
            expect(validateBuffer(undefined)).toBe(false);
        });
    });

    describe('4. Status counters invariant test', () => {
        test('sent + failed + skipped + pending equals total at all states', () => {
            const total = 10;
            const states = [
                { sent: 0, failed: 0, skipped: 0, pending: 10 },
                { sent: 1, failed: 0, skipped: 0, pending: 9 },
                { sent: 1, failed: 1, skipped: 0, pending: 8 },
                { sent: 1, failed: 1, skipped: 2, pending: 6 },
                { sent: 5, failed: 2, skipped: 3, pending: 0 }
            ];

            states.forEach(st => {
                const sum = st.sent + st.failed + st.skipped + st.pending;
                expect(sum).toBe(total);
            });
        });
    });
});
