-- 005_calendar_composite_pk.sql: Composite PK (user_id, event_id) on google_calendar_synced_events

DO $$
BEGIN
    -- Ensure primary key is (user_id, event_id)
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'google_calendar_synced_events'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'user_id'
    ) THEN
        -- If old single-column PK exists, update it
        ALTER TABLE google_calendar_synced_events DROP CONSTRAINT IF EXISTS google_calendar_synced_events_pkey;
        ALTER TABLE google_calendar_synced_events ADD PRIMARY KEY (user_id, event_id);
    END IF;
END $$;
