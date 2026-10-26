-- 025_media_assets_source_of_truth.sql
-- Adds durable database-backed media storage, SHA-256 verification, and URL source tracking.
-- Reversible: ALTER TABLE media_assets DROP COLUMN IF EXISTS data, DROP COLUMN IF EXISTS sha256, DROP COLUMN IF EXISTS source_type, DROP COLUMN IF EXISTS source_url, DROP COLUMN IF EXISTS fetched_at, DROP COLUMN IF EXISTS uploaded_by;

ALTER TABLE media_assets
    ADD COLUMN IF NOT EXISTS data BYTEA,
    ADD COLUMN IF NOT EXISTS sha256 TEXT,
    ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'upload',
    ADD COLUMN IF NOT EXISTS source_url TEXT,
    ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_media_assets_source_type'
    ) THEN
        ALTER TABLE media_assets 
        ADD CONSTRAINT chk_media_assets_source_type CHECK (source_type IN ('upload', 'url'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_project ON media_assets(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_sha256 ON media_assets(sha256);
