-- 012_messages_wa_id_index.sql
-- Adds a non-unique index on messages.wa_message_id for fast delivery-ack lookups.
-- wa_message_id is nullable (not set for chatbot auto-replies) so this is a
-- partial index that skips NULLs — consistent with the partial idempotency
-- index already on this column (idx_messages_idempotency).
--
-- Rollback: DROP INDEX IF EXISTS idx_messages_wa_message_id;

CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id
ON messages(user_id, wa_message_id)
WHERE wa_message_id IS NOT NULL;
