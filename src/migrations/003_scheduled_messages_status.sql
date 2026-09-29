-- 003_scheduled_messages_status.sql: Ensure scheduled_messages status constraint includes 'sending'

DO $$
BEGIN
    -- Check if constraint allows 'sending'
    IF EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name LIKE '%scheduled_messages_status%'
    ) THEN
        -- If existing constraint is restrictive, drop and replace
        ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
        ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
            CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown'));
    END IF;
END $$;
