-- 019_message_media_asset.sql
-- Links an outbound message to the inventory asset it delivered.
-- Rollback: DROP INDEX IF EXISTS idx_messages_user_media_asset;
--           ALTER TABLE messages DROP COLUMN IF EXISTS media_asset_id;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS media_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_user_media_asset
    ON messages(user_id, media_asset_id, created_at DESC)
    WHERE media_asset_id IS NOT NULL;
