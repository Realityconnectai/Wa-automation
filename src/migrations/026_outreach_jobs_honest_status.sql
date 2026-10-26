-- 026_outreach_jobs_honest_status.sql
-- Expand outreach_jobs status constraint to allow 'completed_with_errors' and 'failed'.
-- Update historical outreach_jobs that reported 'completed' despite having failures.
-- Reversible: ALTER TABLE outreach_jobs DROP CONSTRAINT IF EXISTS outreach_jobs_status_check;
--             ALTER TABLE outreach_jobs ADD CONSTRAINT outreach_jobs_status_check CHECK (status IN ('running','cancel_requested','completed','cancelled','interrupted'));

ALTER TABLE outreach_jobs DROP CONSTRAINT IF EXISTS outreach_jobs_status_check;

ALTER TABLE outreach_jobs ADD CONSTRAINT outreach_jobs_status_check 
    CHECK (status IN ('running', 'cancel_requested', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'));

-- Fix historical jobs that have sent = 0 and failed > 0: mark as 'failed'
UPDATE outreach_jobs j
SET status = 'failed'
WHERE j.status = 'completed'
  AND (SELECT COUNT(*) FROM outreach_recipients r WHERE r.job_id = j.id AND r.status = 'sent') = 0
  AND (SELECT COUNT(*) FROM outreach_recipients r WHERE r.job_id = j.id AND r.status = 'failed') > 0;

-- Fix historical jobs that have sent > 0 and failed > 0: mark as 'completed_with_errors'
UPDATE outreach_jobs j
SET status = 'completed_with_errors'
WHERE j.status = 'completed'
  AND (SELECT COUNT(*) FROM outreach_recipients r WHERE r.job_id = j.id AND r.status = 'sent') > 0
  AND (SELECT COUNT(*) FROM outreach_recipients r WHERE r.job_id = j.id AND r.status = 'failed') > 0;
