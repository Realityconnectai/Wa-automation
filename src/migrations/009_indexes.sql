-- 009_indexes.sql: Tenant-scoped and performance indexes

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_phone ON messages(user_id, phone);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_dir_created ON messages(user_id, direction, created_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_user_status ON scheduled_messages(user_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_status_at ON scheduled_messages(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_user_updated ON contacts(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_chatbot_rules_user ON chatbot_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_rules_user_active ON chatbot_rules(user_id, is_active, priority);
CREATE INDEX IF NOT EXISTS idx_lead_analysis_user_phone ON lead_analysis(user_id, phone);
CREATE INDEX IF NOT EXISTS idx_lead_analysis_priority ON lead_analysis(user_id, priority);
CREATE INDEX IF NOT EXISTS idx_crm_deals_user_phone ON crm_deals(user_id, phone);
CREATE INDEX IF NOT EXISTS idx_crm_deals_user_stage ON crm_deals(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_activities_user_phone ON crm_activities(user_id, phone);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_appointments_user_start ON appointments(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_user_status ON appointments(user_id, status);
