-- 011_users_auth_version.sql: Add auth_version to users for instant collision-free token revocation

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'auth_version'
    ) THEN
        ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
    END IF;
END $$;
