-- 021_appointment_reminders.sql
-- Add appointment reminder tracking to scheduled_messages and optional project linkage to appointments.
-- Rollback:
--   DROP INDEX IF EXISTS uq_scheduled_messages_appt_reminder;
--   DROP INDEX IF EXISTS idx_scheduled_messages_appt_id;
--   ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS reminder_type;
--   ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS appointment_id;
--   ALTER TABLE appointments DROP COLUMN IF EXISTS project_id;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='project_id') THEN
        ALTER TABLE appointments ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_messages' AND column_name='appointment_id') THEN
        ALTER TABLE scheduled_messages ADD COLUMN appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_messages' AND column_name='reminder_type') THEN
        ALTER TABLE scheduled_messages ADD COLUMN reminder_type TEXT
            CHECK(reminder_type IN ('24h', '2h') OR reminder_type IS NULL);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_messages_appt_reminder
    ON scheduled_messages(appointment_id, reminder_type)
    WHERE status = 'pending' AND appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_appt_id
    ON scheduled_messages(appointment_id)
    WHERE appointment_id IS NOT NULL;
