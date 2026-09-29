-- 002_contacts_outreach.sql: Add last_outreach_at column to contacts

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'last_outreach_at'
    ) THEN
        ALTER TABLE contacts ADD COLUMN last_outreach_at TIMESTAMPTZ;
    END IF;
END $$;
