-- 007_users_wa_enabled.sql: Admin-controlled WhatsApp access flag

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'wa_enabled'
    ) THEN
        ALTER TABLE users ADD COLUMN wa_enabled INTEGER DEFAULT 0;
    END IF;
END $$;
