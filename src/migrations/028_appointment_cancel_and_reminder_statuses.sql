-- 028_appointment_cancel_and_reminder_statuses.sql
-- Add cancelled_at and cancelled_by to appointments for audit tracking.
-- Add skipped_past and skipped_unreachable statuses to scheduled_messages.
-- Update unique index on scheduled_messages(appointment_id, reminder_type).

DO $$ BEGIN
    -- 1. Appointments audit tracking
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='cancelled_at') THEN
        ALTER TABLE appointments ADD COLUMN cancelled_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='cancelled_by') THEN
        ALTER TABLE appointments ADD COLUMN cancelled_by TEXT;
    END IF;

    -- 2. Scheduled messages status check
    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check 
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped', 'skipped_past', 'skipped_unreachable', 'unknown'));
END $$;

-- 3. Update unique index for appointment reminders:
-- Prevent duplicate non-cancelled rows per (appointment_id, reminder_type)
DROP INDEX IF EXISTS uq_scheduled_messages_appt_reminder;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_messages_appt_reminder
    ON scheduled_messages(appointment_id, reminder_type)
    WHERE status != 'cancelled' AND appointment_id IS NOT NULL;
