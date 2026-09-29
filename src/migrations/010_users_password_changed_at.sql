-- 010_users_password_changed_at.sql: Ensure password_changed_at exists on users table for session invalidation

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password_changed_at'
    ) THEN
        ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
    END IF;
END $$;
