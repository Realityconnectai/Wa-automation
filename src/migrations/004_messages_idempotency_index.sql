-- 004_messages_idempotency_index.sql: Unique partial index for message idempotency keys

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
ON messages(user_id, wa_message_id)
WHERE wa_message_id LIKE 'idem:%';
