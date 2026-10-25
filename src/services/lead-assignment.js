/**
 * src/services/lead-assignment.js — Multi-Agent Lead Assignment & SLA Routing
 *
 * Implements:
 * - Configurable agent routing (round-robin, workload / least-busy, manual)
 * - Atomic concurrency control to prevent race conditions & duplicate assignments
 * - Response SLA deadlines, warning status, and breach detection
 * - Automated manager escalation on SLA breach
 * - Manual reassignment with complete audit history
 * - Agent workload metrics & role-based tenant access
 */
'use strict';

const { query, queryGet, queryAll, runSql, transaction } = require('./db-pool');
const { getSetting, addCrmActivity } = require('./database');

function formatAgent(agent) {
    if (!agent) return null;
    const routing_status = agent.status === 'paused' ? 'busy' : (agent.status === 'inactive' ? 'offline' : 'available');
    return {
        ...agent,
        weight: agent.routing_weight,
        max_concurrent_leads: agent.max_active_leads,
        routing_status
    };
}

/**
 * Creates an agent in the tenant's workspace.
 */
async function createAgent(userId, {
    name,
    email = '',
    phone = '',
    role = 'agent',
    status = 'active',
    routing_status,
    routingWeight,
    routing_weight,
    weight: inWeight,
    maxActiveLeads,
    max_active_leads,
    max_concurrent_leads,
    userAccountId = null,
    user_account_id = null,
    user_id = null
}) {
    if (!name || !name.trim()) {
        const err = new Error('Agent name is required');
        err.status = 400;
        throw err;
    }

    if (email && email.trim()) {
        const existing = await queryGet(
            'SELECT id FROM agents WHERE user_id = $1 AND LOWER(email) = LOWER($2)',
            [userId, email.trim()]
        );
        if (existing) {
            const err = new Error('Agent with this email already exists in workspace');
            err.status = 409;
            throw err;
        }
    }

    const cleanRole = ['admin', 'manager', 'agent'].includes(role) ? role : 'agent';
    let cleanStatus = status;
    if (routing_status === 'busy') cleanStatus = 'paused';
    else if (routing_status === 'offline') cleanStatus = 'inactive';
    else if (routing_status === 'available') cleanStatus = 'active';
    else if (!['active', 'inactive', 'paused'].includes(cleanStatus)) cleanStatus = 'active';

    const weight = Math.max(1, Math.min(100, parseInt(inWeight || routing_weight || routingWeight, 10) || 1));
    const maxLeads = Math.max(1, Math.min(1000, parseInt(max_concurrent_leads || max_active_leads || maxActiveLeads, 10) || 20));
    const linkedUserAccountId = userAccountId || user_account_id || user_id || null;

    const res = await query(
        `INSERT INTO agents (user_id, name, email, phone, role, status, routing_weight, max_active_leads, user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [userId, name.trim(), email.trim(), phone.trim(), cleanRole, cleanStatus, weight, maxLeads, linkedUserAccountId]
    );

    if (linkedUserAccountId) {
        await query(
            'UPDATE users SET tenant_id = $1, agent_id = $2 WHERE id = $3',
            [userId, res.rows[0].id, linkedUserAccountId]
        );
    }

    return formatAgent(res.rows[0]);
}

/**
 * Lists agents for a tenant workspace.
 */
async function getAgents(userId, { status = '' } = {}) {
    let sql = 'SELECT * FROM agents WHERE user_id = $1';
    const params = [userId];
    if (status) {
        let dbStatus = status;
        if (status === 'busy') dbStatus = 'paused';
        else if (status === 'offline') dbStatus = 'inactive';
        else if (status === 'available') dbStatus = 'active';
        sql += ' AND status = $2';
        params.push(dbStatus);
    }
    sql += ' ORDER BY created_at ASC, id ASC';
    const rows = await queryAll(sql, params);
    return rows.map(formatAgent);
}

/**
 * Gets a single agent by ID within the tenant workspace.
 */
async function getAgentById(userId, agentId) {
    if (!agentId) return null;
    const row = await queryGet('SELECT * FROM agents WHERE user_id = $1 AND id = $2', [userId, agentId]);
    return formatAgent(row);
}

/**
 * Updates an agent within the tenant workspace.
 */
async function updateAgent(userId, agentId, fields = {}) {
    const existing = await queryGet('SELECT * FROM agents WHERE user_id = $1 AND id = $2', [userId, agentId]);
    if (!existing) return null;

    const normalized = { ...fields };
    if (normalized.routing_status) {
        if (normalized.routing_status === 'busy') normalized.status = 'paused';
        else if (normalized.routing_status === 'offline') normalized.status = 'inactive';
        else if (normalized.routing_status === 'available') normalized.status = 'active';
    }
    if (normalized.weight !== undefined && normalized.routing_weight === undefined) {
        normalized.routing_weight = normalized.weight;
    }
    if (normalized.max_concurrent_leads !== undefined && normalized.max_active_leads === undefined) {
        normalized.max_active_leads = normalized.max_concurrent_leads;
    }

    const allowed = ['name', 'email', 'phone', 'role', 'status', 'routing_weight', 'max_active_leads', 'user_account_id'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(normalized)) {
        if (!allowed.includes(key) || value === undefined) continue;
        if (key === 'role' && !['admin', 'manager', 'agent'].includes(value)) continue;
        if (key === 'status' && !['active', 'inactive', 'paused'].includes(value)) continue;
        if (key === 'routing_weight') {
            const w = Math.max(1, Math.min(100, parseInt(value, 10) || 1));
            sets.push(`routing_weight = $${idx++}`);
            params.push(w);
            continue;
        }
        if (key === 'max_active_leads') {
            const m = Math.max(1, Math.min(1000, parseInt(value, 10) || 20));
            sets.push(`max_active_leads = $${idx++}`);
            params.push(m);
            continue;
        }
        sets.push(`${key} = $${idx++}`);
        params.push(value);
    }

    if (sets.length === 0) return getAgentById(userId, agentId);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, agentId);
    await runSql(
        `UPDATE agents SET ${sets.join(', ')} WHERE user_id = $${idx++} AND id = $${idx++}`,
        params
    );
    return getAgentById(userId, agentId);
}

/**
 * Deletes an agent from the tenant workspace.
 * Sets any active deal assignment for this agent to NULL.
 */
async function deleteAgent(userId, agentId) {
    return transaction(async (tx) => {
        // Unassign active deals
        await tx.query(
            `UPDATE crm_deals SET assigned_agent_id = NULL
             WHERE user_id = $1 AND assigned_agent_id = $2`,
            [userId, agentId]
        );
        // Delete agent
        const res = await tx.query(
            'DELETE FROM agents WHERE user_id = $1 AND id = $2 RETURNING id',
            [userId, agentId]
        );
        return { changes: res.rowCount };
    });
}

/**
 * Returns agent workload metrics for a tenant workspace:
 * - Active open leads (stage not won/lost)
 * - Breached SLA count
 * - Won deals count
 */
async function getAgentWorkload(userId) {
    const agents = await getAgents(userId);
    if (!agents.length) return [];

    const statsRows = await queryAll(
        `SELECT
            a.id AS agent_id,
            COUNT(cd.id) FILTER (WHERE cd.stage NOT IN ('won', 'lost'))::int AS active_lead_count,
            COUNT(cd.id) FILTER (WHERE cd.sla_status IN ('sla_breached', 'escalated'))::int AS overdue_lead_count,
            COUNT(cd.id) FILTER (WHERE cd.stage = 'won')::int AS won_lead_count,
            COUNT(cd.id)::int AS total_lead_count
         FROM agents a
         LEFT JOIN crm_deals cd ON cd.assigned_agent_id = a.id AND cd.user_id = a.user_id
         WHERE a.user_id = $1
         GROUP BY a.id`,
        [userId]
    );

    const statsMap = new Map(statsRows.map(r => [r.agent_id, r]));

    return agents.map(agent => {
        const s = statsMap.get(agent.id) || {
            active_lead_count: 0,
            overdue_lead_count: 0,
            won_lead_count: 0,
            total_lead_count: 0
        };
        const capacityPct = agent.max_active_leads > 0
            ? Math.min(100, Math.round((s.active_lead_count / agent.max_active_leads) * 100))
            : 0;

        return {
            ...agent,
            active_lead_count: s.active_lead_count,
            active_leads_count: s.active_lead_count,
            overdue_lead_count: s.overdue_lead_count,
            overdue_leads_count: s.overdue_lead_count,
            won_lead_count: s.won_lead_count,
            won_leads_count: s.won_lead_count,
            total_lead_count: s.total_lead_count,
            total_leads_count: s.total_lead_count,
            capacity_pct: capacityPct,
            capacity_used_pct: capacityPct,
            has_capacity: s.active_lead_count < agent.max_active_leads
        };
    });
}

/**
 * Calculates response SLA due timestamp based on tenant setting.
 */
async function calculateSlaDueAt(userId, baseDate = new Date()) {
    const slaMinutesStr = await getSetting(userId, 'lead_sla_minutes');
    const minutes = Math.max(1, Math.min(1440, parseInt(slaMinutesStr, 10) || 15));
    const due = new Date(baseDate.getTime() + minutes * 60 * 1000);
    return due;
}

/**
 * Assigns a lead to an agent using the configured strategy or manual override.
 * Concurrency-safe: uses row-level locking on the deal and round-robin cursor.
 */
async function assignLead(userId, dealId, optionsOrAgentId = {}, maybeReason = null) {
    let opts = {};
    if (typeof optionsOrAgentId === 'object' && optionsOrAgentId !== null) {
        opts = { ...optionsOrAgentId };
    } else {
        opts = { agentId: optionsOrAgentId, reason: maybeReason || 'manual' };
    }
    const {
        strategy = null,
        agentId = null,
        assignedByUserId = null,
        reason = 'auto_round_robin'
    } = opts;
    return transaction(async (tx) => {
        // 1. Lock the deal row to prevent concurrent assignment races
        const dealRes = await tx.query(
            'SELECT * FROM crm_deals WHERE user_id = $1 AND id = $2 FOR UPDATE',
            [userId, dealId]
        );
        const deal = dealRes.rows[0];
        if (!deal) {
            const err = new Error('Deal not found');
            err.status = 404;
            throw err;
        }

        const enabledSetting = await getSetting(userId, 'lead_assignment_enabled');
        const isAssignmentEnabled = enabledSetting !== 'false';

        // If manual agentId is provided, honor it regardless of strategy setting
        let selectedAgent = null;

        if (agentId) {
            const agRes = await tx.query(
                'SELECT * FROM agents WHERE user_id = $1 AND id = $2',
                [userId, agentId]
            );
            selectedAgent = agRes.rows[0] || null;
            if (!selectedAgent) {
                const err = new Error('Assigned agent not found in workspace');
                err.status = 400;
                throw err;
            }
        } else if (!isAssignmentEnabled) {
            // Assignment disabled for tenant — leave as unassigned
            return deal;
        } else {
            // Determine strategy
            const tenantStrategy = strategy || (await getSetting(userId, 'lead_assignment_strategy')) || 'round_robin';

            if (tenantStrategy === 'manual') {
                return deal;
            }

            // Fetch active agents with current workloads
            const agentsRes = await tx.query(
                `SELECT a.*,
                    COUNT(cd.id) FILTER (WHERE cd.stage NOT IN ('won', 'lost'))::int AS active_lead_count
                 FROM agents a
                 LEFT JOIN crm_deals cd ON cd.assigned_agent_id = a.id AND cd.user_id = a.user_id
                 WHERE a.user_id = $1 AND a.status = 'active'
                 GROUP BY a.id
                 ORDER BY a.id ASC`,
                [userId]
            );
            const activeAgents = agentsRes.rows;
            if (!activeAgents.length) {
                // No active agents available
                return deal;
            }

            // Eligible agents below capacity
            const availableAgents = activeAgents.filter(a => a.active_lead_count < a.max_active_leads);
            if (!availableAgents.length) {
                // All active agents are at capacity — leave unassigned
                return deal;
            }
            const pool = availableAgents;

            if (tenantStrategy === 'workload') {
                // Pick agent with lowest active lead count
                pool.sort((a, b) => a.active_lead_count - b.active_lead_count);
                selectedAgent = pool[0];
            } else {
                // Round-robin distribution
                // Lock round-robin cursor for tenant
                let cursorRes = await tx.query(
                    'SELECT last_agent_id FROM round_robin_cursors WHERE user_id = $1 FOR UPDATE',
                    [userId]
                );
                let lastAgentId = cursorRes.rows[0]?.last_agent_id || null;

                // Build weighted array
                const weightedPool = [];
                for (const ag of pool) {
                    const w = Math.max(1, ag.routing_weight || 1);
                    for (let i = 0; i < w; i++) {
                        weightedPool.push(ag);
                    }
                }

                // Find index after last_agent_id
                let nextIndex = 0;
                if (lastAgentId) {
                    const lastIdx = weightedPool.findIndex(a => a.id === lastAgentId);
                    if (lastIdx >= 0) {
                        nextIndex = (lastIdx + 1) % weightedPool.length;
                    }
                }
                selectedAgent = weightedPool[nextIndex];

                // Update cursor
                await tx.query(
                    `INSERT INTO round_robin_cursors (user_id, last_agent_id, updated_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (user_id) DO UPDATE
                     SET last_agent_id = EXCLUDED.last_agent_id, updated_at = CURRENT_TIMESTAMP`,
                    [userId, selectedAgent.id]
                );
            }
        }

        if (!selectedAgent) return deal;

        const prevAgentId = deal.assigned_agent_id;
        const dueAt = await calculateSlaDueAt(userId);

        // Update deal with assignment and initial SLA deadline (preserving state if already responded)
        const updateRes = await tx.query(
            `UPDATE crm_deals SET
                assigned_agent_id = $1,
                assigned_at = CURRENT_TIMESTAMP,
                sla_status = CASE WHEN first_response_at IS NOT NULL THEN sla_status ELSE 'on_time' END,
                sla_response_due_at = CASE WHEN first_response_at IS NOT NULL THEN sla_response_due_at ELSE $2 END,
                updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $3 AND id = $4
             RETURNING *`,
            [selectedAgent.id, dueAt, userId, dealId]
        );
        const updatedDeal = updateRes.rows[0];

        // Record in assignment history
        await tx.query(
            `INSERT INTO lead_assignment_history (user_id, deal_id, from_agent_id, to_agent_id, assigned_by_user_id, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, dealId, prevAgentId, selectedAgent.id, assignedByUserId, reason]
        );

        // Log to CRM activities
        await addCrmActivity(
            userId,
            deal.phone,
            'assignment',
            `Lead assigned to ${selectedAgent.name} (${reason})`
        );

        return updatedDeal;
    });
}

/**
 * Reassigns an existing deal to a different agent.
 */
async function reassignLead(userId, dealId, arg3, maybeReason, maybeAssignedBy) {
    let toAgentId, reason, assignedByUserId;
    if (typeof arg3 === 'object' && arg3 !== null) {
        toAgentId = arg3.toAgentId || arg3.agentId || arg3.agent_id;
        reason = arg3.reason || 'manual_reassignment';
        assignedByUserId = arg3.assignedByUserId || null;
    } else {
        toAgentId = arg3;
        reason = maybeReason || 'manual_reassignment';
        assignedByUserId = maybeAssignedBy || null;
    }
    return assignLead(userId, dealId, {
        agentId: toAgentId,
        assignedByUserId,
        reason
    });
}

/**
 * Records first response on a deal, satisfying the SLA.
 * Called when an outgoing message is sent to a lead phone.
 */
async function recordFirstResponse(userId, phone) {
    if (!userId || !phone) return null;
    return transaction(async (tx) => {
        const dealRes = await tx.query(
            `SELECT id, first_response_at, sla_response_due_at, sla_status
             FROM crm_deals
             WHERE user_id = $1 AND phone = $2
             FOR UPDATE`,
            [userId, phone]
        );
        const deal = dealRes.rows[0];
        if (!deal || deal.first_response_at) return deal; // already responded or no deal

        const now = new Date();
        const due = deal.sla_response_due_at ? new Date(deal.sla_response_due_at) : null;
        let finalStatus = 'on_time';
        if (due && now > due) {
            finalStatus = 'sla_breached';
        }

        const updated = await tx.query(
            `UPDATE crm_deals SET
                first_response_at = CURRENT_TIMESTAMP,
                sla_status = $1,
                updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND id = $3
             RETURNING *`,
            [finalStatus, userId, deal.id]
        );

        await addCrmActivity(
            userId,
            phone,
            'sla',
            `First response recorded (${finalStatus === 'on_time' ? 'Within SLA ✅' : 'SLA Breached ⚠️'})`
        );

        return updated.rows[0];
    });
}

/**
 * Periodic / on-demand sweep to check and escalate overdue SLAs across open deals.
 */
async function checkAndEscalateOverdueSlas(userId) {
    // Proactively transition deals nearing their deadline to 'approaching_sla' (within 15 minutes)
    await runSql(
        `UPDATE crm_deals SET
            sla_status = 'approaching_sla',
            updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND first_response_at IS NULL
           AND stage NOT IN ('won', 'lost')
           AND sla_status = 'on_time'
           AND sla_response_due_at > NOW()
           AND sla_response_due_at <= NOW() + INTERVAL '15 minutes'`,
        [userId]
    );

    const overdueDeals = await queryAll(
        `SELECT cd.*, a.name AS agent_name, a.role AS agent_role
         FROM crm_deals cd
         LEFT JOIN agents a ON a.id = cd.assigned_agent_id AND a.user_id = cd.user_id
         WHERE cd.user_id = $1
           AND cd.first_response_at IS NULL
           AND cd.sla_response_due_at < NOW()
           AND cd.stage NOT IN ('won', 'lost')
           AND cd.sla_status NOT IN ('sla_breached', 'escalated')`,
        [userId]
    );

    if (!overdueDeals.length) return [];

    const escalationEnabledStr = await getSetting(userId, 'lead_escalation_enabled');
    const isEscalationEnabled = escalationEnabledStr !== 'false';
    const targetManagerIdStr = await getSetting(userId, 'lead_escalation_manager_agent_id');
    const targetManagerId = parseInt(targetManagerIdStr, 10) || null;

    // Find default manager/admin agent if not explicitly configured
    let managerAgent = null;
    if (targetManagerId) {
        managerAgent = await getAgentById(userId, targetManagerId);
    }
    if (!managerAgent) {
        managerAgent = await queryGet(
            `SELECT * FROM agents
             WHERE user_id = $1 AND role IN ('admin', 'manager') AND status = 'active'
             ORDER BY id ASC LIMIT 1`,
            [userId]
        );
    }

    const results = [];

    for (const deal of overdueDeals) {
        await transaction(async (tx) => {
            let newStatus = 'sla_breached';
            let escalateToId = null;

            if (isEscalationEnabled && managerAgent && managerAgent.id !== deal.assigned_agent_id) {
                newStatus = 'escalated';
                escalateToId = managerAgent.id;
            }

            const updatedRes = await tx.query(
                `UPDATE crm_deals SET
                    sla_status = $1,
                    escalation_level = CASE WHEN $2 THEN escalation_level + 1 ELSE escalation_level END,
                    escalated_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE escalated_at END,
                    escalated_to_agent_id = COALESCE($3, escalated_to_agent_id),
                    updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $4 AND id = $5
                 RETURNING *`,
                [newStatus, newStatus === 'escalated', escalateToId, userId, deal.id]
            );

            // Log activity
            const reasonText = newStatus === 'escalated'
                ? `Response SLA breached (due ${deal.sla_response_due_at}). Escalated to manager ${managerAgent.name}.`
                : `Response SLA breached (due ${deal.sla_response_due_at}).`;

            await addCrmActivity(userId, deal.phone, 'sla_breach', reasonText);

            if (newStatus === 'escalated' && escalateToId) {
                await tx.query(
                    `INSERT INTO lead_assignment_history (user_id, deal_id, from_agent_id, to_agent_id, reason)
                     VALUES ($1, $2, $3, $4, 'sla_escalation')`,
                    [userId, deal.id, deal.assigned_agent_id, escalateToId]
                );
            }

            results.push(updatedRes.rows[0]);
        });
    }

    return results;
}

/**
 * Returns assignment history for a given deal.
 */
async function getAssignmentHistory(userId, dealId) {
    return queryAll(
        `SELECT h.*,
                fa.name AS from_agent_name,
                ta.name AS to_agent_name,
                u.owner_name AS assigned_by_name
         FROM lead_assignment_history h
         LEFT JOIN agents fa ON fa.id = h.from_agent_id AND fa.user_id = h.user_id
         LEFT JOIN agents ta ON ta.id = h.to_agent_id AND ta.user_id = h.user_id
         LEFT JOIN users u ON u.id = h.assigned_by_user_id
         WHERE h.user_id = $1 AND h.deal_id = $2
         ORDER BY h.created_at DESC, h.id DESC`,
        [userId, dealId]
    );
}

/**
 * Returns deals that are currently overdue or breached.
 */
async function getOverdueDeals(userId, { limit = 50 } = {}) {
    return queryAll(
        `SELECT cd.*, a.name AS agent_name, a.email AS agent_email
         FROM crm_deals cd
         LEFT JOIN agents a ON a.id = cd.assigned_agent_id AND a.user_id = cd.user_id
         WHERE cd.user_id = $1
           AND cd.stage NOT IN ('won', 'lost')
           AND (
               cd.sla_status IN ('sla_breached', 'escalated')
               OR (cd.first_response_at IS NULL AND cd.sla_response_due_at < NOW())
           )
         ORDER BY cd.sla_response_due_at ASC
         LIMIT $2`,
        [userId, limit]
    );
}

module.exports = {
    createAgent,
    getAgents,
    getAgentById,
    updateAgent,
    deleteAgent,
    getAgentWorkload,
    calculateSlaDueAt,
    assignLead,
    reassignLead,
    recordFirstResponse,
    checkAndEscalateOverdueSlas,
    getAssignmentHistory,
    getOverdueDeals
};
