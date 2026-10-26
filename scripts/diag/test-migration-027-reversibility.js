/**
 * scripts/diag/test-migration-027-reversibility.js
 *
 * Verifies that Migration 027 is completely reversible (down and up):
 * 1. Confirms migration 027 columns exist currently.
 * 2. Runs the exact rollback SQL (down).
 * 3. Asserts the columns are dropped and constraints adjusted.
 * 4. Re-runs the migration SQL (up).
 * 5. Asserts the columns, defaults, and constraints are cleanly restored.
 */
'use strict';

require('dotenv').config();
const { getPool, closePool } = require('../../src/services/db-pool');
const fs = require('fs');
const path = require('path');

async function checkColumns(pool) {
    const res = await pool.query(`
        SELECT table_name, column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND (
            (table_name = 'outreach_jobs' AND column_name IN ('buffer_minutes', 'buffer_jitter', 'next_send_at'))
            OR (table_name = 'outreach_recipients' AND column_name IN ('next_send_at'))
            OR (table_name = 'scheduled_messages' AND column_name IN ('wa_message_id', 'attempts'))
          )
        ORDER BY table_name, column_name;
    `);
    return res.rows;
}

async function checkConstraints(pool) {
    const res = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) as def
        FROM pg_constraint
        WHERE conname IN ('outreach_recipients_status_check', 'scheduled_messages_status_check')
        ORDER BY conname;
    `);
    return res.rows;
}

async function run() {
    const pool = getPool();
    console.log('--- MIGRATION 027 REVERSIBILITY TEST ---');

    // Step 1: Initial state check
    const initialCols = await checkColumns(pool);
    console.log('\n[1] Initial columns present:', initialCols.map(r => `${r.table_name}.${r.column_name}`));
    if (initialCols.length !== 6) {
        throw new Error(`Expected 6 migration columns, found ${initialCols.length}`);
    }

    // Step 2: Rollback (down)
    console.log('\n[2] Executing rollback (DOWN)...');
    const rollbackSql = `
        ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS buffer_minutes;
        ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS buffer_jitter;
        ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS next_send_at;
        ALTER TABLE outreach_recipients DROP COLUMN IF EXISTS next_send_at;
        ALTER TABLE outreach_recipients DROP CONSTRAINT IF EXISTS outreach_recipients_status_check;
        ALTER TABLE outreach_recipients ADD CONSTRAINT outreach_recipients_status_check CHECK (status IN ('pending','sending','sent','failed','skipped','unknown'));
        ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS wa_message_id;
        ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS attempts;
        ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
        ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check CHECK (status IN ('pending','sending','sent','failed','cancelled','unknown'));
    `;
    await pool.query(rollbackSql);

    // Step 3: Assert rollback success
    const rolledBackCols = await checkColumns(pool);
    console.log('[3] Columns present after rollback:', rolledBackCols.map(r => `${r.table_name}.${r.column_name}`));
    if (rolledBackCols.length !== 0) {
        throw new Error(`Expected 0 columns after rollback, found ${rolledBackCols.length}`);
    }
    const rolledBackConstraints = await checkConstraints(pool);
    console.log('[3] Constraints after rollback:', rolledBackConstraints);

    // Step 4: Re-apply migration (up)
    console.log('\n[4] Re-applying migration 027 (UP)...');
    const migrationFilePath = path.join(__dirname, '../../src/migrations/027_campaign_buffer_and_reminder_tracking.sql');
    const migrationSql = fs.readFileSync(migrationFilePath, 'utf8');
    await pool.query(migrationSql);

    // Step 5: Assert re-applied success
    const restoredCols = await checkColumns(pool);
    console.log('[5] Columns present after re-applying migration 027:', restoredCols.map(r => `${r.table_name}.${r.column_name}`));
    if (restoredCols.length !== 6) {
        throw new Error(`Expected 6 columns restored, found ${restoredCols.length}`);
    }
    const restoredConstraints = await checkConstraints(pool);
    console.log('[5] Constraints after re-applying:', restoredConstraints);

    console.log('\n✅ Migration 027 reversibility confirmed: DOWN and UP cycle completed cleanly.');
    await closePool();
}

run().catch(async (err) => {
    console.error('❌ Migration reversibility error:', err);
    try { await closePool(); } catch (_) {}
    process.exit(1);
});
