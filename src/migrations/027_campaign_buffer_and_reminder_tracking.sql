-- 027_campaign_buffer_and_reminder_tracking.sql
-- Campaign send buffer (0-15 min, jitter, next_send_at) + cancelled recipient status
-- Appointment reminder tracking: skipped status, wa_message_id, attempts
--
-- Rollback:
--   ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS buffer_minutes;
--   ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS buffer_jitter;
--   ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS next_send_at;
--   ALTER TABLE outreach_recipients DROP COLUMN IF EXISTS next_send_at;
--   ALTER TABLE outreach_recipients DROP CONSTRAINT IF EXISTS outreach_recipients_status_check;
--   ALTER TABLE outreach_recipients ADD CONSTRAINT outreach_recipients_status_check CHECK (status IN ('pending','sending','sent','failed','skipped','unknown'));
--   ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS wa_message_id;
--   ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS attempts;
--   ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
--   ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check CHECK (status IN ('pending','sending','sent','failed','cancelled','unknown'));

DO $$ BEGIN
    -- 1. outreach_jobs buffer fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='outreach_jobs' AND column_name='buffer_minutes') THEN
        ALTER TABLE outreach_jobs ADD COLUMN buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0 AND buffer_minutes <= 15);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='outreach_jobs' AND column_name='buffer_jitter') THEN
        ALTER TABLE outreach_jobs ADD COLUMN buffer_jitter BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='outreach_jobs' AND column_name='next_send_at') THEN
        ALTER TABLE outreach_jobs ADD COLUMN next_send_at TIMESTAMPTZ;
    END IF;

    -- 2. outreach_recipients buffer & cancelled status
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='outreach_recipients' AND column_name='next_send_at') THEN
        ALTER TABLE outreach_recipients ADD COLUMN next_send_at TIMESTAMPTZ;
    END IF;

    ALTER TABLE outreach_recipients DROP CONSTRAINT IF EXISTS outreach_recipients_status_check;
    ALTER TABLE outreach_recipients ADD CONSTRAINT outreach_recipients_status_check 
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'unknown'));

    -- 3. scheduled_messages reminder tracking fields & skipped status
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_messages' AND column_name='wa_message_id') THEN
        ALTER TABLE scheduled_messages ADD COLUMN wa_message_id TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_messages' AND column_name='attempts') THEN
        ALTER TABLE scheduled_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    END IF;

    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check 
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped', 'unknown'));

END $$;
