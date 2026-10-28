#!/usr/bin/env node
/**
 * scripts/backfill-appointment-reminders.js
 *
 * Scans confirmed FUTURE appointments missing reminder rows and backfills them.
 * Defaults to DRY-RUN mode. Requires explicit --apply flag to modify database.
 * NEVER sends any WhatsApp messages. NEVER touches past or cancelled appointments.
 *
 * Usage:
 *   node scripts/backfill-appointment-reminders.js            # Dry-run (default)
 *   node scripts/backfill-appointment-reminders.js --dry-run  # Dry-run explicit
 *   node scripts/backfill-appointment-reminders.js --apply    # Execute backfill
 */
'use strict';

require('dotenv').config();
const { getPool, initPool, queryAll, runSql, closePool } = require('../src/services/db-pool');
const { maskPhoneNumber } = require('../src/utils/phone-mask');
const { formatInZone } = require('../src/utils/tz');

async function main() {
    const isApply = process.argv.includes('--apply');
    const isDryRun = !isApply;

    console.log('=================================================================');
    console.log(`  WORKPILOT: APPOINTMENT REMINDER BACKFILL (${isDryRun ? 'DRY-RUN' : 'LIVE APPLY'})`);
    console.log('=================================================================\n');

    await initPool();
    const pool = getPool();
    const dbNameRes = await pool.query('SELECT current_database() as db');
    const dbName = dbNameRes.rows[0].db;
    console.log(`✔ Connected to database: ${dbName}`);

    if (isDryRun) {
        console.log('ℹ Running in DRY-RUN mode. No changes will be written to the database.');
        console.log('  To apply changes, pass the --apply flag explicitly after review.\n');
    } else {
        console.log('⚠️ Running in APPLY mode. Missing reminder rows will be created in PostgreSQL.\n');
    }

    const now = new Date();
    const nowMs = now.getTime();
    const MS_24_HOURS = 24 * 60 * 60 * 1000;
    const MS_2_HOURS = 2 * 60 * 60 * 1000;

    // Only confirmed future appointments
    const appointments = await queryAll(`
        SELECT a.*, u.email as tenant_email
        FROM appointments a
        JOIN users u ON u.id = a.user_id
        WHERE a.status = 'confirmed' AND a.start_at > CURRENT_TIMESTAMP
        ORDER BY a.start_at ASC
    `);

    console.log(`Found ${appointments.length} confirmed future appointment(s).\n`);

    const summary = {
        totalFutureAppointments: appointments.length,
        fullyCovered: 0,
        missingReminders: 0,
        actions: {
            schedulePending: 0,
            skippedPast: 0,
            skippedUnreachable: 0
        },
        items: []
    };

    const appointmentReminders = require('../src/services/appointment-reminders');

    for (const appt of appointments) {
        const existing = await queryAll(
            "SELECT * FROM scheduled_messages WHERE appointment_id = $1 AND status != 'cancelled'",
            [appt.id]
        );

        const has24h = existing.some(r => r.reminder_type === '24h' || r.type === '24h');
        const has2h = existing.some(r => r.reminder_type === '2h' || r.type === '2h');

        if (has24h && has2h) {
            summary.fullyCovered++;
            continue;
        }

        summary.missingReminders++;

        const startMs = new Date(appt.start_at).getTime();
        const target24h = new Date(startMs - MS_24_HOURS);
        const target2h = new Date(startMs - MS_2_HOURS);

        const maskedPhone = maskPhoneNumber(appt.phone);
        const istStart = formatInZone(new Date(startMs), 'Asia/Kolkata');

        // Check deliverability
        let deliverable = true;
        let unreachableReason = '';
        const digits = (appt.phone || '').replace(/\D/g, '');
        if (!digits || /^0+$/.test(digits) || /^910+$/.test(digits)) {
            deliverable = false;
            unreachableReason = 'Invalid or dummy phone number';
        } else if (appt.phone.includes('@lid') || (digits.length >= 14 && digits.startsWith('2'))) {
            // Check if contact exists
            const contact = await queryAll(
                'SELECT id FROM contacts WHERE user_id = $1 AND (phone = $2 OR phone = $3)',
                [appt.user_id, appt.phone, digits]
            );
            if (contact.length === 0) {
                deliverable = false;
                unreachableReason = 'LID identifier has no resolvable chat';
            }
        }

        const plan = [];

        if (!has24h) {
            let actionStatus;
            if (!deliverable) {
                actionStatus = 'skipped_unreachable';
                summary.actions.skippedUnreachable++;
            } else if (target24h.getTime() > nowMs) {
                actionStatus = 'pending';
                summary.actions.schedulePending++;
            } else {
                actionStatus = 'skipped_past';
                summary.actions.skippedPast++;
            }
            plan.push({ type: '24h', target: target24h, actionStatus, reason: unreachableReason });
        }

        if (!has2h) {
            let actionStatus;
            if (!deliverable) {
                actionStatus = 'skipped_unreachable';
                summary.actions.skippedUnreachable++;
            } else if (target2h.getTime() > nowMs) {
                actionStatus = 'pending';
                summary.actions.schedulePending++;
            } else {
                actionStatus = 'skipped_past';
                summary.actions.skippedPast++;
            }
            plan.push({ type: '2h', target: target2h, actionStatus, reason: unreachableReason });
        }

        summary.items.push({
            id: appt.id,
            tenant: appt.tenant_email,
            phone: maskedPhone,
            start: istStart,
            plan
        });

        console.log(`• Appointment #${appt.id} (${maskedPhone}, starts ${istStart} IST, tenant: ${appt.tenant_email}):`);
        for (const p of plan) {
            const timeStr = formatInZone(p.target, 'Asia/Kolkata');
            console.log(`    - ${p.type} reminder -> [${p.actionStatus.toUpperCase()}] target: ${timeStr} IST ${p.reason ? `(${p.reason})` : ''}`);
        }

        if (isApply) {
            await appointmentReminders.scheduleAppointmentReminders(appt.user_id, appt, { now });
            console.log(`    ✔ Created reminder rows for #${appt.id}`);
        }
    }

    console.log('\n-----------------------------------------------------------------');
    console.log('  SUMMARY');
    console.log('-----------------------------------------------------------------');
    console.log(`Total Confirmed Future Appointments:   ${summary.totalFutureAppointments}`);
    console.log(`Already Fully Covered:                 ${summary.fullyCovered}`);
    console.log(`Missing Reminders:                     ${summary.missingReminders}`);
    console.log(`  - To schedule (pending):             ${summary.actions.schedulePending}`);
    console.log(`  - To record as skipped (past):       ${summary.actions.skippedPast}`);
    console.log(`  - To record as skipped (unreachable): ${summary.actions.skippedUnreachable}`);
    console.log('-----------------------------------------------------------------');

    if (isDryRun) {
        console.log('\n[DRY-RUN COMPLETE] No database modifications were made.');
        console.log('To apply these reminder records, rerun with: node scripts/backfill-appointment-reminders.js --apply\n');
    } else {
        console.log('\n[APPLY COMPLETE] Backfill applied successfully.\n');
    }

    await closePool();
}

main().catch(err => {
    console.error('Fatal backfill error:', err);
    process.exit(1);
});
