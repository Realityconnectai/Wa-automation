-- 022_multi_agent_lead_assignment_sla.sql
-- Multi-agent lead distribution, round-robin cursors, manual reassignment history,
-- response SLAs, and escalation state.
-- Rollback: DROP TABLE IF EXISTS lead_assignment_history;
--           DROP TABLE IF EXISTS round_robin_cursors;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS assigned_agent_id;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS assigned_at;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS sla_status;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS sla_response_due_at;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS first_response_at;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS escalation_level;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS escalated_at;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS escalated_to_agent_id;
--           DROP TABLE IF EXISTS agents CASCADE;

-- 1. Agents table
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'manager', 'agent')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused')),
    routing_weight INTEGER NOT NULL DEFAULT 1 CHECK (routing_weight > 0),
    max_active_leads INTEGER NOT NULL DEFAULT 20 CHECK (max_active_leads > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_user_status ON agents(user_id, status);

-- 2. Extend users role check and add tenant_id / agent_id
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='tenant_id') THEN
        ALTER TABLE users ADD COLUMN tenant_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='agent_id') THEN
        ALTER TABLE users ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'manager', 'agent'));

-- 3. Extend crm_deals with assignment and SLA tracking
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='assigned_agent_id') THEN
        ALTER TABLE crm_deals ADD COLUMN assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='assigned_at') THEN
        ALTER TABLE crm_deals ADD COLUMN assigned_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='sla_status') THEN
        ALTER TABLE crm_deals ADD COLUMN sla_status TEXT NOT NULL DEFAULT 'on_time'
            CHECK (sla_status IN ('on_time', 'approaching_sla', 'sla_breached', 'escalated'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='sla_response_due_at') THEN
        ALTER TABLE crm_deals ADD COLUMN sla_response_due_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='first_response_at') THEN
        ALTER TABLE crm_deals ADD COLUMN first_response_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='escalation_level') THEN
        ALTER TABLE crm_deals ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='escalated_at') THEN
        ALTER TABLE crm_deals ADD COLUMN escalated_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='escalated_to_agent_id') THEN
        ALTER TABLE crm_deals ADD COLUMN escalated_to_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_deals_assigned_agent ON crm_deals(user_id, assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_sla_status ON crm_deals(user_id, sla_status, sla_response_due_at);

-- 4. Assignment History
CREATE TABLE IF NOT EXISTS lead_assignment_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deal_id INTEGER NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    from_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    to_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL DEFAULT 'auto_round_robin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assignment_history_deal ON lead_assignment_history(user_id, deal_id, created_at DESC);

-- 5. Round Robin Cursors (atomic distribution cursor per tenant)
CREATE TABLE IF NOT EXISTS round_robin_cursors (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
