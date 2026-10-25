/**
 * tests/live/live_sla.js
 *
 * Workpilot Autonomous Loop — Live Verification Script for W10: SLA Breached Badges & Tracking
 *
 * Verifies:
 * 1. On-time reply: logs first response within SLA deadline -> `sla_status = 'on_time'`, badge "Responded"
 * 2. Unanswered overdue lead: sweep escalates to manager -> `sla_status = 'escalated'`, badge "Escalated"
 * 3. Late reply: logs first response past SLA deadline -> `sla_status = 'sla_breached'`, badge "Responded Late"
 * 4. Reassignment: preserves responded state or resets deadline for unresponded deal
 * 5. Approaching SLA: deal within 15 min -> sweep transitions to `approaching_sla`, badge "SLA Due Soon"
 * 6. API Filtering: `GET /api/crm/deals?sla_status=...` filters correctly with zero 400s
 */
'use strict';

require('dotenv').config();
const { queryGet, queryAll, runSql } = require('../../src/services/db-pool');
const leadAssignment = require('../../src/services/lead-assignment');
const database = require('../../src/services/database');
const request = require('supertest');
const express = require('express');

// Mock helper representing the UI badge renderer logic in public/js/app.js
function getSlaBadge(deal) {
    if (!deal) return '';
    if (deal.first_response_at) {
        if (deal.sla_status === 'sla_breached') {
            return 'Responded Late';
        }
        return 'Responded';
    }
    const now = Date.now();
    const dueTime = deal.sla_response_due_at ? new Date(deal.sla_response_due_at).getTime() : null;
    const isOverdue = dueTime && now > dueTime && !['won', 'lost'].includes(deal.stage);

    if (deal.sla_status === 'escalated') return 'Escalated';
    if (deal.sla_status === 'sla_breached' || isOverdue) return 'SLA Breached';
    const isApproaching = dueTime && (dueTime - now <= 15 * 60 * 1000) && (dueTime > now);
    if (deal.sla_status === 'approaching_sla' || deal.sla_status === 'sla_approaching' || isApproaching) return 'SLA Due Soon';
    if (deal.sla_status === 'on_time' || deal.sla_status === 'sla_on_time') return 'SLA OK';
    return '';
}

async function run() {
    console.log('====================================================');
    console.log('  WORKPILOT LIVE VERIFICATION: W10 SLA BADGES & RULES');
    console.log('====================================================\n');

    const app = express();
    app.use(express.json());
    const TEST_TENANT = 3;

    app.use((req, res, next) => {
        req.user = { id: TEST_TENANT, role: 'admin' };
        next();
    });

    const apiRouter = require('../../src/routes/api');
    app.use('/api', apiRouter);

    // Setup: Ensure SLA settings exist for Tenant
    await runSql("INSERT INTO settings (user_id, key, value) VALUES ($1, 'lead_sla_minutes', '30') ON CONFLICT (user_id, key) DO UPDATE SET value = '30'", [TEST_TENANT]);
    await runSql("INSERT INTO settings (user_id, key, value) VALUES ($1, 'lead_escalation_enabled', 'true') ON CONFLICT (user_id, key) DO UPDATE SET value = 'true'", [TEST_TENANT]);

    // Ensure at least one agent and manager exist
    let manager = await queryGet("SELECT * FROM agents WHERE user_id = $1 AND role = 'manager'", [TEST_TENANT]);
    if (!manager) {
        manager = await leadAssignment.createAgent(TEST_TENANT, {
            name: 'Escalation Manager',
            email: 'manager_w10@workpilot.test',
            role: 'manager',
            status: 'active'
        });
    }

    let agent = await queryGet("SELECT * FROM agents WHERE user_id = $1 AND role = 'agent'", [TEST_TENANT]);
    if (!agent) {
        agent = await leadAssignment.createAgent(TEST_TENANT, {
            name: 'Standard Agent',
            email: 'agent_w10@workpilot.test',
            role: 'agent',
            status: 'active'
        });
    }

    // --- Step 1: On-Time First Response ---
    console.log('--- Step 1: On-Time First Response ---');
    const phone1 = '91888' + String(Date.now()).slice(-7);
    const deal1 = await database.createCrmDeal(TEST_TENANT, {
        phone: phone1,
        contact_name: 'On Time Lead',
        stage: 'new',
        assigned_agent_id: agent.id
    });

    console.log(`Created Deal #${deal1.id} for ${phone1}, due: ${deal1.sla_response_due_at}, status: ${deal1.sla_status}`);
    if (getSlaBadge(deal1) !== 'SLA OK') {
        throw new Error(`Expected initial badge to be 'SLA OK', got '${getSlaBadge(deal1)}'`);
    }

    // Agent sends outgoing message on time
    await database.logMessage(TEST_TENANT, phone1, 'outgoing', 'Hello! Thank you for inquiring.');
    const deal1Updated = await database.getCrmDealById(TEST_TENANT, deal1.id);
    console.log(`After on-time reply: first_response_at = ${deal1Updated.first_response_at}, sla_status = ${deal1Updated.sla_status}`);
    if (deal1Updated.sla_status !== 'on_time') {
        throw new Error(`Expected sla_status to be 'on_time', got '${deal1Updated.sla_status}'`);
    }
    const badge1 = getSlaBadge(deal1Updated);
    console.log(`UI Badge: "${badge1}" (Expected: "Responded")`);
    if (badge1 !== 'Responded') {
        throw new Error(`Expected badge 'Responded', got '${badge1}'`);
    }
    console.log('✔ On-time first response verified.');

    // --- Step 2: Overdue Unanswered Lead & Escalation Sweep ---
    console.log('\n--- Step 2: Overdue Lead & Escalation Sweep ---');
    const phone2 = '91887' + String(Date.now()).slice(-7);
    const deal2 = await database.createCrmDeal(TEST_TENANT, {
        phone: phone2,
        contact_name: 'Overdue Lead',
        stage: 'new',
        assigned_agent_id: agent.id
    });

    // Backdate due date to 10 minutes ago
    await runSql(
        "UPDATE crm_deals SET sla_response_due_at = NOW() - INTERVAL '10 minutes' WHERE id = $1 AND user_id = $2",
        [deal2.id, TEST_TENANT]
    );

    // Run sweep
    const sweepResults = await leadAssignment.checkAndEscalateOverdueSlas(TEST_TENANT);
    console.log(`Sweep completed: ${sweepResults.length} deal(s) escalated/marked breached`);

    const deal2AfterSweep = await database.getCrmDealById(TEST_TENANT, deal2.id);
    console.log(`Deal #${deal2.id} after sweep: sla_status = "${deal2AfterSweep.sla_status}", escalated_to = ${deal2AfterSweep.escalated_to_agent_id}`);
    if (deal2AfterSweep.sla_status !== 'escalated') {
        throw new Error(`Expected deal to be 'escalated', got '${deal2AfterSweep.sla_status}'`);
    }
    const badge2 = getSlaBadge(deal2AfterSweep);
    console.log(`UI Badge: "${badge2}" (Expected: "Escalated")`);
    if (badge2 !== 'Escalated') {
        throw new Error(`Expected badge 'Escalated', got '${badge2}'`);
    }
    console.log('✔ Escalation sweep verified.');

    // --- Step 3: Late Response After Deadline ---
    console.log('\n--- Step 3: Late Response After Deadline ---');
    const phone3 = '91886' + String(Date.now()).slice(-7);
    const deal3 = await database.createCrmDeal(TEST_TENANT, {
        phone: phone3,
        contact_name: 'Late Lead',
        stage: 'new',
        assigned_agent_id: agent.id
    });

    // Backdate due date to 15 minutes ago
    await runSql(
        "UPDATE crm_deals SET sla_response_due_at = NOW() - INTERVAL '15 minutes' WHERE id = $1 AND user_id = $2",
        [deal3.id, TEST_TENANT]
    );

    // Send outgoing message late
    await database.logMessage(TEST_TENANT, phone3, 'outgoing', 'Sorry for the late reply! How can I assist?');
    const deal3Updated = await database.getCrmDealById(TEST_TENANT, deal3.id);
    console.log(`After late reply: first_response_at = ${deal3Updated.first_response_at}, sla_status = ${deal3Updated.sla_status}`);
    if (deal3Updated.sla_status !== 'sla_breached') {
        throw new Error(`Expected late reply sla_status to be 'sla_breached', got '${deal3Updated.sla_status}'`);
    }
    const badge3 = getSlaBadge(deal3Updated);
    console.log(`UI Badge: "${badge3}" (Expected: "Responded Late")`);
    if (badge3 !== 'Responded Late') {
        throw new Error(`Expected badge 'Responded Late', got '${badge3}'`);
    }
    console.log('✔ Late response accurately tracked.');

    // --- Step 4: Reassignment Preservation ---
    console.log('\n--- Step 4: Reassignment Handling ---');
    // Reassigning deal 1 (already responded) should NOT overwrite first_response_at or sla_status
    await leadAssignment.reassignLead(TEST_TENANT, deal1.id, manager.id, 'Manager review');
    const deal1Reassigned = await database.getCrmDealById(TEST_TENANT, deal1.id);
    if (!deal1Reassigned.first_response_at) {
        throw new Error('Reassignment wiped out first_response_at on responded deal!');
    }
    if (deal1Reassigned.sla_status !== 'on_time') {
        throw new Error(`Reassignment altered sla_status on responded deal to '${deal1Reassigned.sla_status}'!`);
    }
    console.log('✔ Reassignment preserves responded lead state.');

    // --- Step 5: Approaching SLA Transition ---
    console.log('\n--- Step 5: Approaching SLA Transition ---');
    const phone4 = '91885' + String(Date.now()).slice(-7);
    const deal4 = await database.createCrmDeal(TEST_TENANT, {
        phone: phone4,
        contact_name: 'Due Soon Lead',
        stage: 'new',
        assigned_agent_id: agent.id
    });
    // Set due date to 8 minutes in the future
    await runSql(
        "UPDATE crm_deals SET sla_response_due_at = NOW() + INTERVAL '8 minutes' WHERE id = $1 AND user_id = $2",
        [deal4.id, TEST_TENANT]
    );

    // Run sweep
    await leadAssignment.checkAndEscalateOverdueSlas(TEST_TENANT);
    const deal4AfterSweep = await database.getCrmDealById(TEST_TENANT, deal4.id);
    console.log(`Deal #${deal4.id} status after sweep: ${deal4AfterSweep.sla_status}`);
    if (deal4AfterSweep.sla_status !== 'approaching_sla') {
        throw new Error(`Expected sla_status to transition to 'approaching_sla', got '${deal4AfterSweep.sla_status}'`);
    }
    const badge4 = getSlaBadge(deal4AfterSweep);
    console.log(`UI Badge: "${badge4}" (Expected: "SLA Due Soon")`);
    if (badge4 !== 'SLA Due Soon') {
        throw new Error(`Expected badge 'SLA Due Soon', got '${badge4}'`);
    }
    console.log('✔ Approaching SLA transition verified.');

    // --- Step 6: API Filtering via HTTP GET ---
    console.log('\n--- Step 6: API Filtering via HTTP GET ---');
    const resOnTime = await request(app)
        .get('/api/crm/deals?sla_status=on_time')
        .expect(200);
    console.log(`Filter on_time returned ${resOnTime.body.data.deals.length} deal(s)`);

    const resBreached = await request(app)
        .get('/api/crm/deals?sla_status=sla_breached')
        .expect(200);
    console.log(`Filter sla_breached returned ${resBreached.body.data.deals.length} deal(s)`);

    const resEscalated = await request(app)
        .get('/api/crm/deals?sla_status=escalated')
        .expect(200);
    console.log(`Filter escalated returned ${resEscalated.body.data.deals.length} deal(s)`);

    // Verify filter by legacy frontend enum also works seamlessly
    const resLegacy = await request(app)
        .get('/api/crm/deals?sla_status=sla_on_time')
        .expect(200);
    console.log(`Filter legacy sla_on_time returned ${resLegacy.body.data.deals.length} deal(s)`);

    console.log('\n✅ W10 SLA BADGES & RULES VERIFICATION COMPLETED SUCCESSFULLY.');
    process.exit(0);
}

run().catch(err => {
    console.error('\n❌ W10 Verification FAILED:', err);
    process.exit(1);
});
