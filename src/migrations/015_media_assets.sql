-- 015_media_assets.sql: Project and unit media assets (brochures, photos, etc.)
-- Files are served via authenticated API routes, never from the public static folder.
-- Rollback: DROP TABLE IF EXISTS media_assets CASCADE;

CREATE TABLE IF NOT EXISTS media_assets (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    unit_id        INTEGER REFERENCES units(id) ON DELETE SET NULL,
    asset_type     TEXT NOT NULL
                   CHECK(asset_type IN ('brochure','floor_plan','photo','walkthrough','price_sheet')),
    file_name      TEXT NOT NULL,
    storage_path   TEXT NOT NULL,   -- absolute server path; never a public URL
    mime_type      TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    rera_verified  INTEGER NOT NULL DEFAULT 0,  -- 1 = RERA brochure officially verified
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assets_user        ON media_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_assets_project     ON media_assets(project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_assets_unit        ON media_assets(unit_id)
    WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_type        ON media_assets(project_id, asset_type, is_active);
