-- 024_outreach_job_media_asset.sql
-- Links an outreach job to an optional media asset (brochure, floor plan, photo, etc.).
-- ON DELETE SET NULL ensures campaign history remains intact if an inventory asset is deleted.
-- Rollback: DROP INDEX IF EXISTS idx_outreach_jobs_media_asset;
--           ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS media_asset_id;

ALTER TABLE outreach_jobs
    ADD COLUMN IF NOT EXISTS media_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_jobs_media_asset
    ON outreach_jobs(user_id, media_asset_id, started_at DESC)
    WHERE media_asset_id IS NOT NULL;
