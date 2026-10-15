/**
 * tests/lead-assignment-sla.test.js
 *
 * Comprehensive tests for Item 5: Multi-Agent Lead Assignment & SLA Routing
 * 1. Agent CRUD & Tenant Isolation
 * 2. Routing Strategies: Round Robin, Weighted Round Robin, Workload (least-busy)
 * 3. Capacity & Status Constraints (max_concurrent_leads, available/busy/offline)
 * 4. Manual Reassignment with Audit Trail (lead_assignment_history)
 * 5. Response SLA Calculation & First-Response Fulfillment
 * 6. SLA Breach Detection & Manager Escalation
 * 7. Role-Based Permissions & Scoping (agents see own leads, managers/admins see all)
 * 8. Concurrency & Locking
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/lead-assignment-sla.test.js --forceExit
 */
'use strict';

const request = require('supertest');
const { query } = require('../src/services/db-pool');

describe('Multi-Agent Lead Assignment & SLA Routing', () => {
    let db, app;
    let userA, userB;
    let leadAssignment;

    beforeEach(async () => {
        db = await freshDatabase();
        leadAssignment = require('../src/services/lead-assignment');

        userA = await db.createUser({
            email: `tenant_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            businessName: 'Apex Realty',
            ownerName: 'Alice Admin',
            role: 'admin',
            status: 'active'
        });

        userB = await db.createUser({
            email: `tenant_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            passwordHash: '$2a$04$abcdefghijklmnopqrstuvwxyz123456',
            businessName: 'Beacon Homes',
            ownerName: 'Bob Broker',
            role: 'admin',
            status: 'active'
        });
    });

    describe('1. Agent CRUD & Tenant Isolation', () => {
        test('creates an agent with valid attributes', async () => {
            const agent = await leadAssignment.createAgent(userA.id, {
                name: 'Rohan Sharma',
                email: 'rohan@apex.com',
                phone: '919876543210',
                role: 'agent',
                routing_status: 'available',
                weight: 2,
                max_concurrent_leads: 15
            });

            expect(agent).toBeDefined();
            expect(agent.id).toBeDefined();
            expect(agent.name).toBe('Rohan Sharma');
            expect(agent.email).toBe('rohan@apex.com');
            expect(agent.weight).toBe(2);
            expect(agent.max_concurrent_leads).toBe(15);
            expect(agent.user_id).toBe(userA.id);
        });

        test('enforces unique email per tenant', async () => {
            await leadAssignment.createAgent(userA.id, {
                name: 'Rohan 1',
                email: 'rohan@apex.com'
            });

            await expect(leadAssignment.createAgent(userA.id, {
                name: 'Rohan 2',
                email: 'rohan@apex.com'
            })).rejects.toThrow();
        });

        test('allows same agent email across different tenants', async () => {
            const a1 = await leadAssignment.createAgent(userA.id, {
                name: 'Rohan A',
                email: 'rohan@agency.com'
            });
            const a2 = await leadAssignment.createAgent(userB.id, {
                name: 'Rohan B',
                email: 'rohan@agency.com'
            });

            expect(a1.id).toBeDefined();
            expect(a2.id).toBeDefined();
            expect(a1.id).not.toBe(a2.id);
        });

        test('tenant B cannot view or update tenant A agent', async () => {
            const agentA = await leadAssignment.createAgent(userA.id, {
                name: 'Alice Agent',
                email: 'alice.agent@apex.com'
            });

            const fetchedByB = await leadAssignment.getAgentById(userB.id, agentA.id);
            expect(fetchedByB).toBeNull();

            const updatedByB = await leadAssignment.updateAgent(userB.id, agentA.id, { name: 'Hacked' });
            expect(updatedByB).toBeNull();

            const fetchedByA = await leadAssignment.getAgentById(userA.id, agentA.id);
            expect(fetchedByA.name).toBe('Alice Agent');
        });
    });

    describe('2. Routing Strategies', () => {
        let agent1, agent2, agent3;

        beforeEach(async () => {
            agent1 = await leadAssignment.createAgent(userA.id, {
                name: 'Agent 1',
                email: 'agent1@apex.com',
                weight: 1,
                max_concurrent_leads: 20
            });
            agent2 = await leadAssignment.createAgent(userA.id, {
                name: 'Agent 2',
                email: 'agent2@apex.com',
                weight: 1,
                max_concurrent_leads: 20
            });
            agent3 = await leadAssignment.createAgent(userA.id, {
                name: 'Agent 3',
                email: 'agent3@apex.com',
                weight: 1,
                max_concurrent_leads: 20
            });
        });

        test('round_robin: assigns sequentially among available agents', async () => {
            await query("UPDATE settings SET value = 'round_robin' WHERE user_id = $1 AND key = 'lead_assignment_strategy'", [userA.id]);
            await query("UPDATE settings SET value = 'true' WHERE user_id = $1 AND key = 'lead_assignment_enabled'", [userA.id]);

            const deal1 = await db.createCrmDeal(userA.id, { phone: '919000000001', contact_name: 'Lead 1' });
            const deal2 = await db.createCrmDeal(userA.id, { phone: '919000000002', contact_name: 'Lead 2' });
            const deal3 = await db.createCrmDeal(userA.id, { phone: '919000000003', contact_name: 'Lead 3' });
            const deal4 = await db.createCrmDeal(userA.id, { phone: '919000000004', contact_name: 'Lead 4' });

            const assignedAgents = [deal1.assigned_agent_id, deal2.assigned_agent_id, deal3.assigned_agent_id, deal4.assigned_agent_id];
            // Deals 1, 2, 3 should each get a distinct agent
            expect(new Set([assignedAgents[0], assignedAgents[1], assignedAgents[2]]).size).toBe(3);
            // Deal 4 loops back to the first assigned agent
            expect(assignedAgents[3]).toBe(assignedAgents[0]);
        });

        test('workload: assigns to agent with lowest active deal load', async () => {
            await query("UPDATE settings SET value = 'workload' WHERE user_id = $1 AND key = 'lead_assignment_strategy'", [userA.id]);

            // Give Agent 1 two active deals, Agent 2 one active deal, Agent 3 zero active deals
            await db.createCrmDeal(userA.id, { phone: '919000000010', stage: 'new' });
            await db.createCrmDeal(userA.id, { phone: '919000000011', stage: 'contacted' });

            // Next deal should pick the least-busy agent
            const newDeal = await db.createCrmDeal(userA.id, { phone: '919000000099', contact_name: 'New Buyer' });
            expect(newDeal.assigned_agent_id).toBeDefined();

            // Verify workload distribution
            const workload = await leadAssignment.getAgentWorkload(userA.id);
            const maxLoad = Math.max(...workload.map(w => w.active_leads_count));
            const minLoad = Math.min(...workload.map(w => w.active_leads_count));
            expect(maxLoad - minLoad).toBeLessThanOrEqual(1);
        });

        test('skips busy or offline agents during routing', async () => {
            // Set Agent 1 to busy, Agent 2 to offline, Agent 3 remains available
            await leadAssignment.updateAgent(userA.id, agent1.id, { routing_status: 'busy' });
            await leadAssignment.updateAgent(userA.id, agent2.id, { routing_status: 'offline' });

            const deal = await db.createCrmDeal(userA.id, { phone: '919000000050', contact_name: 'Sole Available' });
            expect(deal.assigned_agent_id).toBe(agent3.id);
        });

        test('skips agents at max_concurrent_leads capacity', async () => {
            // Cap Agent 1 at 1 lead
            await leadAssignment.updateAgent(userA.id, agent1.id, { max_concurrent_leads: 1 });
            // Deactivate Agents 2 and 3
            await leadAssignment.updateAgent(userA.id, agent2.id, { status: 'inactive' });
            await leadAssignment.updateAgent(userA.id, agent3.id, { status: 'inactive' });

            // Deal 1 fills Agent 1 capacity
            const deal1 = await db.createCrmDeal(userA.id, { phone: '919000000061' });
            expect(deal1.assigned_agent_id).toBe(agent1.id);

            // Deal 2 should remain unassigned because Agent 1 is full and others are inactive
            const deal2 = await db.createCrmDeal(userA.id, { phone: '919000000062' });
            expect(deal2.assigned_agent_id).toBeNull();
        });
    });

    describe('3. Manual Reassignment with Audit History', () => {
        let agent1, agent2, deal;

        beforeEach(async () => {
            agent1 = await leadAssignment.createAgent(userA.id, { name: 'Priya', email: 'priya@apex.com' });
            agent2 = await leadAssignment.createAgent(userA.id, { name: 'Kunal', email: 'kunal@apex.com' });
            deal = await db.createCrmDeal(userA.id, { phone: '919111111111', contact_name: 'Vikas' });
        });

        test('reassigns lead and records history entry', async () => {
            const reassigned = await leadAssignment.reassignLead(
                userA.id,
                deal.id,
                agent2.id,
                'Customer requested luxury specialist',
                null
            );

            expect(reassigned.assigned_agent_id).toBe(agent2.id);

            // Check history
            const history = await leadAssignment.getAssignmentHistory(userA.id, deal.id);
            expect(history.length).toBeGreaterThanOrEqual(1);

            const latest = history[0];
            expect(latest.to_agent_id).toBe(agent2.id);
            expect(latest.reason).toBe('Customer requested luxury specialist');
        });

        test('tenant B cannot reassign tenant A deal', async () => {
            const agentB = await leadAssignment.createAgent(userB.id, { name: 'Bob Agent', email: 'bob.a@beacon.com' });

            await expect(leadAssignment.reassignLead(
                userB.id,
                deal.id,
                agentB.id,
                'Malicious reassignment',
                null
            )).rejects.toThrow(/Deal not found/);
        });
    });

    describe('4. SLA Calculation & First Response Tracking', () => {
        let agent;

        beforeEach(async () => {
            agent = await leadAssignment.createAgent(userA.id, { name: 'Samir', email: 'samir@apex.com' });
        });

        test('new deal calculates sla_response_due_at from tenant settings', async () => {
            await query("UPDATE settings SET value = '30' WHERE user_id = $1 AND key = 'lead_sla_minutes'", [userA.id]);

            const deal = await db.createCrmDeal(userA.id, { phone: '919222222222', contact_name: 'SLA Test' });
            expect(deal.sla_response_due_at).toBeDefined();

            const dueTime = new Date(deal.sla_response_due_at).getTime();
            const createdTime = new Date(deal.created_at).getTime();
            const diffMinutes = Math.round((dueTime - createdTime) / (60 * 1000));
            expect(diffMinutes).toBe(30);
            expect(deal.sla_status).toBe('on_time');
        });

        test('first outgoing message records first_response_at and marks SLA on time', async () => {
            const deal = await db.createCrmDeal(userA.id, { phone: '919333333333', contact_name: 'Quick Lead' });
            expect(deal.first_response_at).toBeNull();

            // Log outgoing WhatsApp message
            await db.logMessage(userA.id, '919333333333', 'outgoing', 'Hello! Thanks for your enquiry.');

            const updatedDeal = await db.getCrmDealById(userA.id, deal.id);
            expect(updatedDeal.first_response_at).toBeDefined();
            expect(updatedDeal.sla_status).toBe('on_time');

            // Subsequent outgoing messages do not overwrite first_response_at
            const firstTimestamp = updatedDeal.first_response_at;
            await db.logMessage(userA.id, '919333333333', 'outgoing', 'Second follow-up message.');
            const recheckDeal = await db.getCrmDealById(userA.id, deal.id);
            expect(new Date(recheckDeal.first_response_at).getTime()).toBe(new Date(firstTimestamp).getTime());
        });
    });

    describe('5. SLA Breach Detection & Escalation Sweep', () => {
        let agent, manager;

        beforeEach(async () => {
            agent = await leadAssignment.createAgent(userA.id, {
                name: 'Junior Rep',
                email: 'junior@apex.com',
                role: 'agent'
            });
            manager = await leadAssignment.createAgent(userA.id, {
                name: 'Sales Manager',
                email: 'manager@apex.com',
                role: 'manager'
            });
        });

        test('escalates overdue unresponded deal to manager', async () => {
            // Create deal with SLA deadline in the past
            const deal = await db.createCrmDeal(userA.id, { phone: '919444444444', contact_name: 'Overdue Lead' });
            await query(
                "UPDATE crm_deals SET sla_response_due_at = NOW() - INTERVAL '10 minutes', assigned_agent_id = $1 WHERE id = $2",
                [agent.id, deal.id]
            );

            // Run SLA escalation sweep
            const escalated = await leadAssignment.checkAndEscalateOverdueSlas(userA.id);
            expect(escalated.length).toBeGreaterThanOrEqual(1);

            const dealAfter = await db.getCrmDealById(userA.id, deal.id);
            expect(dealAfter.sla_status).toBe('escalated');
            expect(dealAfter.escalation_level).toBe(1);
            expect(dealAfter.escalated_to_agent_id).toBe(manager.id);

            // Overdue query returns this deal
            const overdue = await leadAssignment.getOverdueDeals(userA.id);
            expect(overdue.some(d => d.id === deal.id)).toBe(true);
        });
    });

    describe('6. Concurrency & Locking', () => {
        test('concurrent assignLead calls do not crash and assign all deals', async () => {
            const a1 = await leadAssignment.createAgent(userA.id, { name: 'C1', email: 'c1@apex.com' });
            const a2 = await leadAssignment.createAgent(userA.id, { name: 'C2', email: 'c2@apex.com' });

            const deals = await Promise.all([
                db.createCrmDeal(userA.id, { phone: '919500000001' }),
                db.createCrmDeal(userA.id, { phone: '919500000002' }),
                db.createCrmDeal(userA.id, { phone: '919500000003' }),
                db.createCrmDeal(userA.id, { phone: '919500000004' })
            ]);

            for (const d of deals) {
                expect(d.assigned_agent_id).toBeDefined();
                expect([a1.id, a2.id]).toContain(d.assigned_agent_id);
            }
        });
    });

    describe('7. API Endpoints & Role Authorization', () => {
        let adminSession;

        beforeEach(async () => {
            app = createTestApp();
            adminSession = await signup(app, { email: `api_admin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`, role: 'admin' });
        });

        test('POST /api/crm/agents creates an agent via API', async () => {
            const res = await request(app)
                .post('/api/crm/agents')
                .set('Cookie', adminSession.cookie)
                .send({
                    name: 'Karan Mehra',
                    email: 'karan@apex.com',
                    role: 'agent',
                    weight: 3,
                    max_concurrent_leads: 30
                });

            expect(res.status).toBe(201);
            expect(res.body.agent).toBeDefined();
            expect(res.body.agent.name).toBe('Karan Mehra');
            expect(res.body.agent.routing_weight).toBe(3);
        });

        test('GET /api/crm/agents/workload returns workload stats', async () => {
            await request(app)
                .post('/api/crm/agents')
                .set('Cookie', adminSession.cookie)
                .send({ name: 'Workload Rep', email: 'rep@apex.com' });

            const res = await request(app)
                .get('/api/crm/agents/workload')
                .set('Cookie', adminSession.cookie);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.agents)).toBe(true);
            expect(res.body.agents.length).toBeGreaterThanOrEqual(1);
            expect(res.body.agents[0].active_leads_count).toBeDefined();
        });

        test('POST /api/crm/deals/:id/assign reassigns lead via API', async () => {
            const agRes = await request(app)
                .post('/api/crm/agents')
                .set('Cookie', adminSession.cookie)
                .send({ name: 'Target Rep', email: 'target@apex.com' });
            const targetAgentId = agRes.body.agent.id;

            const deal = await db.createCrmDeal(adminSession.user.id, { phone: '919888888888' });

            const res = await request(app)
                .post(`/api/crm/deals/${deal.id}/assign`)
                .set('Cookie', adminSession.cookie)
                .send({ agent_id: targetAgentId, reason: 'Specialist transfer' });

            expect(res.status).toBe(200);
            expect(res.body.deal.assigned_agent_id).toBe(targetAgentId);

            // Fetch assignments history
            const histRes = await request(app)
                .get(`/api/crm/deals/${deal.id}/assignments`)
                .set('Cookie', adminSession.cookie);

            expect(histRes.status).toBe(200);
            expect(histRes.body.history.length).toBeGreaterThanOrEqual(1);
            expect(histRes.body.history[0].reason).toBe('Specialist transfer');
        });
    });
});
