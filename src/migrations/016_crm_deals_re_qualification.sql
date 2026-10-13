-- 016_crm_deals_re_qualification.sql
-- Additive real estate qualification fields on crm_deals.
-- Never overwrites existing columns.
-- Rollback: ALTER TABLE crm_deals DROP CONSTRAINT IF EXISTS fk_crm_deals_interested_project;
--           ALTER TABLE crm_deals DROP COLUMN IF EXISTS <each column below>;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='lead_type') THEN
        ALTER TABLE crm_deals ADD COLUMN lead_type TEXT
            CHECK(lead_type IN ('buy','rent','invest') OR lead_type IS NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='budget_min') THEN
        ALTER TABLE crm_deals ADD COLUMN budget_min NUMERIC
            CHECK(budget_min >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='budget_max') THEN
        ALTER TABLE crm_deals ADD COLUMN budget_max NUMERIC
            CHECK(budget_max >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='preferred_bhk') THEN
        ALTER TABLE crm_deals ADD COLUMN preferred_bhk TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='preferred_locality') THEN
        ALTER TABLE crm_deals ADD COLUMN preferred_locality TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='timeline') THEN
        ALTER TABLE crm_deals ADD COLUMN timeline TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='financing_needed') THEN
        ALTER TABLE crm_deals ADD COLUMN financing_needed TEXT
            CHECK(financing_needed IN ('yes','no','unknown') OR financing_needed IS NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='site_visit_pref') THEN
        ALTER TABLE crm_deals ADD COLUMN site_visit_pref TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='interested_project_id') THEN
        ALTER TABLE crm_deals ADD COLUMN interested_project_id INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='lead_temp') THEN
        ALTER TABLE crm_deals ADD COLUMN lead_temp TEXT DEFAULT 'COLD'
            CHECK(lead_temp IN ('HOT','WARM','COLD'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_deals' AND column_name='lead_temp_reason') THEN
        ALTER TABLE crm_deals ADD COLUMN lead_temp_reason TEXT DEFAULT '';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deals_interested_project'
    ) THEN
        ALTER TABLE crm_deals
            ADD CONSTRAINT fk_crm_deals_interested_project
            FOREIGN KEY (interested_project_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_deals_lead_temp ON crm_deals(user_id, lead_temp);
CREATE INDEX IF NOT EXISTS idx_crm_deals_lead_type ON crm_deals(user_id, lead_type);
