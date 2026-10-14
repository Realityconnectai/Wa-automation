-- 020_brochure_drop_events.sql
-- Durable, tenant-scoped audit trail for automatic brochure-drop decisions.
-- Rollback: DROP TABLE IF EXISTS brochure_drop_events;

CREATE TABLE IF NOT EXISTS brochure_drop_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL CHECK(action IN ('assets_sent','assets_failed','no_assets_reply','clarification_sent')),
    asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brochure_drop_events_user_created
    ON brochure_drop_events(user_id, created_at DESC);
