-- 008_users_status_pending_rejected.sql: Users status check constraint allows 'pending' and 'rejected'

DO $$
BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK(status IN ('active', 'suspended', 'pending', 'rejected'));
END $$;
