-- 006_scheduled_messages_unknown.sql: Allow 'unknown' status in scheduled_messages

DO $$
BEGIN
    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
        CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown'));
END $$;
