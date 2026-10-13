-- 017_messages_idempotency_key.sql
-- Keep an API idempotency key separate from the provider's WhatsApp message id.
-- This lets retries be deduplicated after the provider id replaces the pending
-- value used during an outbound send.
-- Rollback: DROP INDEX IF EXISTS idx_messages_user_idempotency_key;
--           ALTER TABLE messages DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_idempotency_key
ON messages(user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
