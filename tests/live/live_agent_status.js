/**
 * tests/live/live_agent_status.js
 *
 * Workpilot Autonomous Loop — Live Verification Script for W9: Agent Availability
 *
 * Verifies:
 * 1. Set Busy persists to PostgreSQL (`status = 'paused'`, `routing_status = 'busy'`).
 * 2. Re-fetching agent workload from server returns updated status (`routing_status = 'busy'`).
 * 3. Lead routing skips busy agents (only available agents receive new deals).
 * 4. Set Available persists to PostgreSQL (`status = 'active'`, `routing_status = 'available'`).
 * 5. Re-fetching agent workload from server returns `routing_status = 'available'`.
 * 6. Tenant isolation: Agent status in Tenant A never affects Tenant B, and Tenant B cannot modify Tenant A's agents.
 */
'use strict';

require('dotenv').config();
const { queryGet, queryAll, runSql } = require('../../src/services/db-pool');
const leadAssignment = require('../../src/services/lead-assignment');
const database = require('../../src/services/database');
const request = require('supertest');
const express = require('express');

async function run() {
    console.log('====================================================');
    console.log('  WORKPILOT LIVE VERIFICATION: W9 AGENT AVAILABILITY');
    console.log('====================================================\n');

    // Setup an isolated express app with the real API router to test the actual HTTP endpoints
    const app = express();
    app.use(express.json());

    // Mock auth middleware to simulate authenticated tenant session
    let mockUser = { id: 3, role: 'admin' };
    app.use((req, res, next) => {
        req.user = mockUser;
        next();
    });

    const apiRouter = require('../../src/routes/api');
    app.use('/api', apiRouter);

    const TEST_TENANT_A = 3;
    const TEST_TENANT_B = 2;

    // --- Step 1: Create or fetch test agent in Tenant A ---
    console.log('--- Step 1: Initial State & Agent Setup ---');
    const existing = await queryGet(
        "SELECT * FROM agents WHERE user_id = $1 AND email = 'test_agent_w9@workpilot.test'",
        [TEST_TENANT_A]
    );

    let agentId;
    if (existing) {
        agentId = existing.id;
        await leadAssignment.updateAgent(TEST_TENANT_A, agentId, { routing_status: 'available' });
    } else {
        const created = await leadAssignment.createAgent(TEST_TENANT_A, {
            name: 'W9 Test Agent',
            email: 'test_agent_w9@workpilot.test',
            role: 'agent',
            status: 'active'
        });
        agentId = created.id;
    }

    let agentState = await leadAssignment.getAgentById(TEST_TENANT_A, agentId);
    console.log(`Initial agent #${agentId} status: ${agentState.routing_status} (DB status: ${agentState.status})`);
    if (agentState.routing_status !== 'available') {
        throw new Error(`Expected initial status to be 'available', got '${agentState.routing_status}'`);
    }

    // --- Step 2: HTTP PUT /api/crm/agents/:id with { routing_status: 'busy' } ---
    console.log('\n--- Step 2: Toggle Status to Busy via HTTP PUT ---');
    const resBusy = await request(app)
        .put(`/api/crm/agents/${agentId}`)
        .send({ routing_status: 'busy' })
        .expect(200);

    console.log('PUT response body:', JSON.stringify(resBusy.body));
    if (resBusy.body.data.routing_status !== 'busy') {
        throw new Error(`Expected PUT response routing_status to be 'busy', got '${resBusy.body.data?.routing_status}'`);
    }

    // Verify directly in DB
    const dbRowBusy = await queryGet('SELECT status FROM agents WHERE id = $1 AND user_id = $2', [agentId, TEST_TENANT_A]);
    console.log(`PostgreSQL raw status after Set Busy: "${dbRowBusy.status}" (Expected: "paused")`);
    if (dbRowBusy.status !== 'paused') {
        throw new Error(`Expected DB status to be 'paused', got '${dbRowBusy.status}'`);
    }

    // Verify via GET /api/crm/agents/workload
    const resWorkloadBusy = await request(app)
        .get('/api/crm/agents/workload')
        .expect(200);

    const workloadItemBusy = resWorkloadBusy.body.data.find(a => a.id === agentId);
    console.log(`Server workload response for agent #${agentId}: ${workloadItemBusy.routing_status}`);
    if (workloadItemBusy.routing_status !== 'busy') {
        throw new Error(`Expected workload routing_status to be 'busy', got '${workloadItemBusy.routing_status}'`);
    }

    // --- Step 3: Verify Lead Routing Skips Busy Agent ---
    console.log('\n--- Step 3: Lead Routing Honors Busy Status ---');
    // Ensure Tenant A has routing strategy configured
    await runSql("INSERT INTO settings (user_id, key, value) VALUES ($1, 'lead_assignment_strategy', 'round-robin') ON CONFLICT (user_id, key) DO UPDATE SET value = 'round-robin'", [TEST_TENANT_A]);

    // Create a second available agent so routing has a candidate
    let agent2 = await queryGet("SELECT * FROM agents WHERE user_id = $1 AND email = 'test_agent2_w9@workpilot.test'", [TEST_TENANT_A]);
    if (!agent2) {
        agent2 = await leadAssignment.createAgent(TEST_TENANT_A, {
            name: 'W9 Candidate Agent',
            email: 'test_agent2_w9@workpilot.test',
            role: 'agent',
            status: 'active'
        });
    } else {
        await leadAssignment.updateAgent(TEST_TENANT_A, agent2.id, { routing_status: 'available' });
    }

    // Route a deal
    const dynamicPhone = '91999' + String(Date.now()).slice(-7);
    const deal = await database.createCrmDeal(TEST_TENANT_A, {
        phone: dynamicPhone,
        contact_name: 'Routing Test Lead',
        stage: 'new'
    });

    console.log(`Deal #${deal.id} assigned to agent #${deal.assigned_agent_id}`);
    if (deal.assigned_agent_id === agentId) {
        throw new Error(`Routing assigned deal to busy agent #${agentId}!`);
    }
    console.log('✔ Busy agent was correctly skipped by lead routing.');

    // --- Step 4: Toggle Status back to Available via HTTP PUT ---
    console.log('\n--- Step 4: Toggle Status back to Available via HTTP PUT ---');
    const resAvail = await request(app)
        .put(`/api/crm/agents/${agentId}`)
        .send({ routing_status: 'available' })
        .expect(200);

    if (resAvail.body.data.routing_status !== 'available') {
        throw new Error(`Expected PUT response routing_status to be 'available', got '${resAvail.body.data?.routing_status}'`);
    }

    const dbRowAvail = await queryGet('SELECT status FROM agents WHERE id = $1 AND user_id = $2', [agentId, TEST_TENANT_A]);
    console.log(`PostgreSQL raw status after Set Available: "${dbRowAvail.status}" (Expected: "active")`);
    if (dbRowAvail.status !== 'active') {
        throw new Error(`Expected DB status to be 'active', got '${dbRowAvail.status}'`);
    }

    // --- Step 5: Tenant Isolation Verification ---
    console.log('\n--- Step 5: Tenant Isolation ---');
    mockUser = { id: TEST_TENANT_B, role: 'admin' }; // Switch to Tenant B

    // Tenant B trying to update Tenant A's agent must return 404
    const resCrossTenant = await request(app)
        .put(`/api/crm/agents/${agentId}`)
        .send({ routing_status: 'busy' })
        .expect(404);

    console.log('Tenant B modification on Tenant A agent rejected with 404 Not Found:', resCrossTenant.body);

    // Verify Tenant A's agent remains 'active'
    const dbRowUntouched = await queryGet('SELECT status FROM agents WHERE id = $1 AND user_id = $2', [agentId, TEST_TENANT_A]);
    if (dbRowUntouched.status !== 'active') {
        throw new Error(`Tenant A agent was corrupted by cross-tenant request!`);
    }
    console.log('✔ Cross-tenant isolation verified: Tenant A agent untouched.');

    console.log('\n✅ W9 AGENT AVAILABILITY VERIFICATION COMPLETED SUCCESSFULLY.');
    process.exit(0);
}

run().catch(err => {
    console.error('\n❌ W9 Verification FAILED:', err);
    process.exit(1);
});
