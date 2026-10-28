# WORKPILOT HANDOFF & SYSTEM STATUS

**Last Updated:** 2026-10-28  
**Branch:** `fix-qr-scan`  
**Database:** PostgreSQL 17 on Docker (`wa-postgres:5432`)  
- Production Database: `whatsapp_automation`
- Test Database: `wa_test` (strict guard enforces throwaway test database only)
**Applied Migrations:** 27 migrations (`001_initial_schema.sql` through `027_campaign_buffer_and_reminder_tracking.sql`)

---

## 1. Current State & Deliverables

1. **WhatsApp Lifecycle & Session Persistence:**
   - **QR & Connecting:** Clean, idempotent connection queue. Rapid QR delivery to frontend via SSE.
   - **Session Persistence:** Graceful shutdown preserves `.wwebjs_auth/user_<id>/session`. Resumes automatically on boot without requiring re-scan.
   - **Disconnect & Logout:** Explicit user disconnect records `wa_user_disconnected = 'true'` to avoid unwanted auto-reconnects.
   - **Zombie Reload Prevention:** Automatically detects post-ready WhatsApp Web reloads (`~385s`) and schedules a fast, safe resume path (~15s) to guarantee listeners remain attached.
   - **Process Lock Management:** Hardened PowerShell cleanup (`scripts/kill-puppeteer-chrome.ps1`) terminates orphan child Chrome processes holding session locks, preventing stuck initialization loops.

2. **Inbound Message Flow & Visibility:**
   - Human takeover / AI pause (`isConversationAiPaused`) suppresses automated replies as designed and records stage `AI_PAUSED`.
   - Silence is visible: every stage is tracked with timestamps, reason, and listener metrics.
   - Non-admin phone masking enforced on conversation pause endpoints (`isAuthorizedForFullPhone`).

3. **Campaigns & Outreach:**
   - Durable buffer pacing (0–15 min) between messages with jitter.
   - Honest status invariants: `sent`, `failed`, `completed_with_errors`.
   - Media storage as source-of-truth in DB with SHA-256 integrity.

---

## 2. Verification Ledger (W0–W13 Status)

| ID | Title | Status | Automated Test Evidence |
|---|---|---|---|
| **W0** | Bootstrap & Test Harness | **VERIFIED** | `tests/w0-bootstrap.test.js` (4/4 passed) |
| **W1** | Shared Text Dispatch (LID/@c.us) | **VERIFIED** | `tests/live/live_manual_text.js` |
| **W2** | Text Campaign & Template Fallbacks | **VERIFIED** | `tests/campaigns-unit.test.js` (11/11 passed) |
| **W3** | Media Service & MsgKey Patch | **VERIFIED** | `tests/live/live_media_matrix.js` |
| **W4** | Campaign Media End-to-End | **VERIFIED** | `tests/outreach-ui-unit.test.js` (12/12 passed) |
| **W5** | Gemini Tools & Thought Signature | **VERIFIED** | `tests/live/live_gemini.js` |
| **W6** | Brochure/Property Intent Matching | **VERIFIED** | `tests/brochure-drop.test.js` (21/21 passed) |
| **W7** | Appointment Booking Flow | **VERIFIED** | `tests/live/live_appointment.js` |
| **W8** | Reminders (24h + 2h) Scheduler | **VERIFIED** | `tests/appointment-reminders.test.js` (12/12 passed) |
| **W9** | Agent Availability Self-Toggle | **VERIFIED** | `tests/live/live_agent_status.js` |
| **W10** | SLA Tracking & Breached Badges | **VERIFIED** | `tests/lead-assignment-sla.test.js` (17/17 passed) |
| **W11** | CORS / CSP / Login Origin | **VERIFIED** | `tests/cors.test.js` (10/10 passed) |
| **W12** | UI Assets, Icons, CSP Sweep | **VERIFIED** | `tests/live/live_ui_sweep.js` |
| **W13** | Full Regression & Tenant Isolation | **VERIFIED** | `tests/tenant-isolation.test.js` (45/45 passed) |

---

## 3. Key Commands & Running

- **Lint:** `npm run lint` (160/160 files clean)
- **Unit & Integration Tests:** `npm run test:unit` & `npm run test:integration`
- **DB Tests:** `npm run test:db` (targets `wa_test`)
- **Start App:** `$env:WA_DEBUG="true"; node server.js`
- **Clean Chrome Locks:** `node scripts/clean-chrome-locks.js`
