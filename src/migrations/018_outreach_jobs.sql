-- 018_outreach_jobs.sql
-- Durable bulk outreach state. Interrupted work is marked safely rather than
-- automatically retried, preventing an uncertain delivery from being sent twice.
-- Rollback: DROP TABLE IF EXISTS outreach_recipients; DROP TABLE IF EXISTS outreach_jobs;

CREATE TABLE IF NOT EXISTS outreach_jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_template TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','cancel_requested','completed','cancelled','interrupted')),
    total INTEGER NOT NULL CHECK(total >= 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    error TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outreach_jobs_user_status ON outreach_jobs(user_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS outreach_recipients (
    id SERIAL PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES outreach_jobs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped','unknown')),
    reason TEXT DEFAULT '',
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outreach_recipients_job_status ON outreach_recipients(job_id, status, id);
CREATE INDEX IF NOT EXISTS idx_outreach_recipients_user ON outreach_recipients(user_id, job_id);
