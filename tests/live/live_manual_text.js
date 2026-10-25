// tests/live/live_manual_text.js — Live verification script for W1 manual reply dispatch

const path = require('path');
const dotenv = require('dotenv');
const assert = require('node:assert/strict');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const { getPool } = require('../../src/services/db-pool');
const { assertRecipientAllowlisted, isAllowlistConfigured } = require('./harness');
const { resolveDestinationChatId } = require('../../src/services/whatsapp-client');

async function run() {
    console.log('--- STARTING LIVE MANUAL TEXT DISPATCH VERIFICATION (W1) ---');
    const pool = getPool();
    if (!pool) {
        console.error('FAIL: Database pool not available');
        process.exit(1);
    }

    // 1. Negative test: Deliberately invalid dummy number +910000000000
    console.log('\n[Step 1] Verifying negative rejection of +910000000000...');
    try {
        await resolveDestinationChatId(null, '+910000000000');
        assert.fail('Should have thrown on invalid destination');
    } catch (err) {
        assert.match(err.code, /(INVALID_RECIPIENT|RECIPIENT_NOT_ON_WHATSAPP)/);
        console.log('✔ Negative test rejected cleanly with code:', err.code, err.message);
    }

    // 2. Negative test: Non-allowlisted arbitrary number blocked by harness guard
    console.log('\n[Step 2] Verifying test harness blocks unapproved number...');
    try {
        assertRecipientAllowlisted('+919999988888');
        assert.fail('Should have been blocked by harness');
    } catch (err) {
        assert.match(err.message, /SAFETY_/);
        console.log('✔ Harness safety guard active:', err.message);
    }

    // 3. Negative test: 12-digit Indian number not on WhatsApp
    console.log('\n[Step 3] Verifying 12-digit not-on-whatsapp resolution...');
    try {
        const mockClient = {
            getNumberId: async () => null,
            getChatById: async () => null
        };
        await resolveDestinationChatId(mockClient, '+919876543210');
        assert.fail('Should have rejected non-registered number');
    } catch (err) {
        assert.strictEqual(err.code, 'RECIPIENT_NOT_ON_WHATSAPP');
        assert.strictEqual(err.status, 400);
        console.log('✔ Correctly identified un-registered 12-digit recipient:', err.message);
    }

    // 4. Multi-device LID resolution test
    console.log('\n[Step 4] Verifying 14-15 digit multi-device LID resolution...');
    const lidMock = {
        getNumberId: async () => null,
        getContactById: async (id) => ({ id: { _serialized: id }, number: null }),
        getChatById: async (id) => ({ id: { _serialized: id } })
    };
    const lidRes = await resolveDestinationChatId(lidMock, '227105572937810');
    assert.strictEqual(lidRes, '227105572937810@lid');
    console.log('✔ LID resolved cleanly to:', lidRes);

    // 5. Check live allowlist for live outbound message
    console.log('\n[Step 5] Checking live allowlist status for real device dispatch...');
    if (!isAllowlistConfigured()) {
        console.log('⚠️  TEST_RECIPIENT_PRIMARY is not set in environment.');
        console.log('⚠️  Status: LIVE_PENDING_HUMAN (All unit and mock verifications passed).');
        console.log('--- W1 DISPATCH VERIFICATION COMPLETE (PENDING LIVE HUMAN ALLOWLIST) ---');
        process.exit(0);
    }

    const primaryNumber = process.env.TEST_RECIPIENT_PRIMARY;
    assertRecipientAllowlisted(primaryNumber);
    const token = `WP-TEST-W1-${Date.now()}`;
    console.log(`Sending live manual text to allowlisted device ${primaryNumber} with token ${token}...`);

    const { sendTextMessage } = require('../../src/services/whatsapp-client');
    try {
        const result = await sendTextMessage(3, primaryNumber, `Workpilot live test token: ${token}`);
        console.log('✔ Outbound send succeeded! Message ID:', result?.id?._serialized);
        console.log('Status: VERIFIED');
    } catch (err) {
        console.error('Live send encountered error:', err.message);
        if (err.code === 'WA_NOT_CONNECTED') {
            console.log('⚠️  WhatsApp Web session not currently connected. Scan QR in UI.');
        }
        process.exit(1);
    }

    process.exit(0);
}

run().catch(e => {
    console.error('Test script failure:', e);
    process.exit(1);
});
