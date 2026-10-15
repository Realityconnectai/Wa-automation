-- 023_phase1_compliance_safety.sql: Opt-out enforcement and Human takeover / AI pause
-- Rollback:
-- ALTER TABLE contacts DROP COLUMN IF EXISTS is_opted_out;
-- ALTER TABLE contacts DROP COLUMN IF EXISTS opted_out_at;
-- ALTER TABLE contacts DROP COLUMN IF EXISTS opt_out_reason;
-- ALTER TABLE contacts DROP COLUMN IF EXISTS is_ai_paused;
-- ALTER TABLE contacts DROP COLUMN IF EXISTS ai_paused_until;
-- ALTER TABLE crm_deals DROP COLUMN IF EXISTS is_ai_paused;
-- ALTER TABLE crm_deals DROP COLUMN IF EXISTS ai_paused_until;
-- ALTER TABLE crm_deals DROP COLUMN IF EXISTS ai_paused_at;
-- ALTER TABLE crm_deals DROP COLUMN IF EXISTS ai_pause_reason;

DO $$
BEGIN
    -- Contacts persistent opt-out columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'is_opted_out') THEN
        ALTER TABLE contacts ADD COLUMN is_opted_out BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'opted_out_at') THEN
        ALTER TABLE contacts ADD COLUMN opted_out_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'opt_out_reason') THEN
        ALTER TABLE contacts ADD COLUMN opt_out_reason TEXT DEFAULT '';
    END IF;

    -- Contacts AI pause columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'is_ai_paused') THEN
        ALTER TABLE contacts ADD COLUMN is_ai_paused BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_paused_until') THEN
        ALTER TABLE contacts ADD COLUMN ai_paused_until TIMESTAMPTZ;
    END IF;

    -- CRM deals AI pause / human takeover columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_deals' AND column_name = 'is_ai_paused') THEN
        ALTER TABLE crm_deals ADD COLUMN is_ai_paused BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_deals' AND column_name = 'ai_paused_until') THEN
        ALTER TABLE crm_deals ADD COLUMN ai_paused_until TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_deals' AND column_name = 'ai_paused_at') THEN
        ALTER TABLE crm_deals ADD COLUMN ai_paused_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'crm_deals' AND column_name = 'ai_pause_reason') THEN
        ALTER TABLE crm_deals ADD COLUMN ai_pause_reason TEXT DEFAULT '';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_user_opted_out ON contacts(user_id, is_opted_out);
CREATE INDEX IF NOT EXISTS idx_crm_deals_user_ai_paused ON crm_deals(user_id, is_ai_paused);
