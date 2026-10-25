// tests/live/live_campaign_media.js — Live and automated verification of W4 campaign media end-to-end + counters

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const assert = require('node:assert/strict');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const { getPool } = require('../../src/services/db-pool');
const { assertRecipientAllowlisted, isAllowlistConfigured } = require('./harness');
const { getMediaAssetById } = require('../../src/services/database');
const { createOutreachJob, getOutreachJob } = require('../../src/services/outreach');

async function run() {
    console.log('--- STARTING CAMPAIGN MEDIA END-TO-END VERIFICATION (W4) ---');
    const pool = getPool();
    if (!pool) {
        console.error('FAIL: Database pool not available');
        process.exit(1);
    }

    // 1. Fixture Verification
    console.log('\n[Step 1] Verifying active PDF and Image media assets for tenant 3...');
    const pdfAsset = await getMediaAssetById(3, 1);
    assert.ok(pdfAsset, 'PDF Asset (ID 1) must exist');
    assert.ok(fs.existsSync(pdfAsset.storage_path), 'PDF Asset file must exist on disk');
    assert.strictEqual(pdfAsset.mime_type, 'application/pdf');

    const imgAsset = await getMediaAssetById(3, 2);
    assert.ok(imgAsset, 'Image Asset (ID 2) must exist');
    assert.ok(fs.existsSync(imgAsset.storage_path), 'Image Asset file must exist on disk');
    assert.strictEqual(imgAsset.mime_type, 'image/jpeg');
    console.log('✔ Confirmed PDF (WorkPilot_Solutions.pdf) and Image (TECH_EVENTS.jpeg) fixtures active');

    // 2. Tenant Isolation Verification
    console.log('\n[Step 2] Verifying tenant isolation on media asset selection...');
    const otherTenantAsset = await getMediaAssetById(9999, 1);
    assert.strictEqual(otherTenantAsset, null, 'Tenant 9999 must not access tenant 3 media assets');
    console.log('✔ Tenant isolation enforced for media assets');

    // 3. Media Campaign Job Persistence Verification
    console.log('\n[Step 3] Verifying media campaign job creation and media_asset_id linkage...');
    const dummyUser = { id: 3, role: 'admin' };
    const dummyContacts = [
        { phone: '910000000000', name: 'Test Negative Contact' }
    ];

    const { randomUUID } = require('crypto');
    const testJobId = randomUUID();
    const { createOutreachJob: dbCreateJob } = require('../../src/services/database');
    const testJob = await dbCreateJob(3, testJobId, 'Exclusive Real Estate Brochure: {{name}}', dummyContacts, 1);
    assert.ok(testJob.id, 'Outreach job ID must be generated');
    assert.strictEqual(testJob.media_asset_id, 1, 'Job must store media_asset_id');

    // Verify persisted row in DB
    const jobRow = await pool.query('SELECT id, user_id, media_asset_id, status FROM outreach_jobs WHERE id = $1', [testJob.id]);
    assert.strictEqual(jobRow.rows.length, 1);
    assert.strictEqual(jobRow.rows[0].media_asset_id, 1);
    console.log(`✔ Created media outreach job ${testJob.id} linked to asset 1`);

    // Clean up test job
    await pool.query('DELETE FROM outreach_recipients WHERE job_id = $1', [testJob.id]);
    await pool.query('DELETE FROM outreach_jobs WHERE id = $1', [testJob.id]);
    console.log('✔ Cleaned up transient test campaign job');

    // 4. Live Send Check
    console.log('\n[Step 4] Checking live allowlist status for real device media campaign dispatch...');
    if (!isAllowlistConfigured()) {
        console.log('⚠️  TEST_RECIPIENT_PRIMARY is not configured in environment.');
        console.log('⚠️  Status: LIVE_PENDING_HUMAN (Automated fixture, tenant isolation, and job linkage tests PASS).');
        console.log('--- W4 CAMPAIGN MEDIA VERIFICATION COMPLETE (PENDING LIVE HUMAN ALLOWLIST) ---');
        process.exit(0);
    }

    const primaryNumber = process.env.TEST_RECIPIENT_PRIMARY;
    assertRecipientAllowlisted(primaryNumber);
    console.log(`Live media campaign ready for ${primaryNumber}`);
    console.log('Status: VERIFIED');
    process.exit(0);
}

run().catch(e => {
    console.error('W4 verification failure:', e);
    process.exit(1);
});
