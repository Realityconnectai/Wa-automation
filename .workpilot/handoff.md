# WORKPILOT AUTONOMOUS LOOP — CAMPAIGN UX, BUFFER, DEAL MODAL POLISH & APPOINTMENT REMINDERS HANDOFF

**Current Status:** Stages S0–S6 and S9 are **`COMPLETE & VERIFIED`**. Stage S7/S8 (live delivery to real devices) is marked **`LIVE_PENDING_HUMAN`** awaiting owner-approved allowlist numbers.  
**Timestamp:** 2026-10-26T18:25:00+05:30  
**Environment:** Windows, Node.js v24.11.1, PostgreSQL 17 on Docker (`wa-postgres`:5432)  
**PostgreSQL Schema Version:** 27 (Migrations 001–027 applied)  

---

### 1. Root Causes Confirmed & Fixed

1. **S0 Premature "Failed" Status on Launch:**
   - **Root Cause:** `public/js/app.js:2827` used a two-state ternary `${r.status === 'sent' ? 'ok' : 'fail'}`. For new pending recipients, `status === 'sent'` evaluated to `false`, assigning `.fail` (red) and printing `"failed"` because `r.reason` was empty string `""`.
   - **Resolution:** Replaced with multi-state badge and styling mapping supporting `pending`, `sending`, `sent`, `failed`, `skipped`, and `cancelled`. Recipients now show neutral amber "Pending" immediately upon launch.
2. **`Send failed: t: t` (Aaryan, 105957396857003):**
   - **Root Cause:** Minified WhatsApp Web throws exception objects with `name: 't'` and `message: 't'`. In Node/V8, `err.toString()` is `"t: t"`. In `outreach.js:209`, the check `if (!detail || detail === 't' || detail.length <= 1)` evaluated to `false` on `"t: t"`, setting `failReason = "Send failed: t: t"`.
   - **Resolution:** Implemented `serializeSendError(err, phone)` catching all regex matches of `/^(evaluation failed:\s*)?t(\s*:\s*t)?$/i` and unresolvable LIDs, mapping them to `RECIPIENT_UNRESOLVABLE` with clear error reasons.
3. **Escalation Truthfulness in CRM Deal Modal:**
   - **Root Cause:** In `src/services/lead-assignment.js`, `checkAndEscalateOverdueSlas` sets `sla_status = 'escalated'` and `escalated_to_agent_id = managerAgent.id`, but intentionally does NOT reassign the lead (`assigned_agent_id` remains Rahul Sharma; manager is notified). History rendered a misleading arrow `Rahul Sharma -> Escalation Manager`.
   - **Resolution:** Rendered truthfully as `"Escalated to Escalation Manager (notified)"`.

---

### 2. Solutions Implemented

1. **Database Migration 027 (`src/migrations/027_campaign_buffer_and_reminder_tracking.sql`):**
   - Added `buffer_minutes`, `buffer_jitter`, `next_send_at` to `outreach_jobs`.
   - Added `next_send_at` to `outreach_recipients` and expanded status check to include `'cancelled'`.
   - Added `wa_message_id`, `attempts` to `scheduled_messages` and expanded status check to include `'skipped'`.
2. **Selectable Message Buffer (1–15 min):**
   - Server-side validation enforcing 0–15 min.
   - Pacing calculation with bounds clamping (30s to 15m) and ±20% jitter.
   - Durable `interruptibleDelay` polling DB every 1s for early cancellation. First message sends immediately; subsequent sends wait buffer delay. Skips do not wait; failed sends wait.
   - Startup crash recovery: `reclaimInterruptedOutreachJobs()` reclaims stuck `sending` rows to `pending`.
   - Frontend UI: "Delay Between Messages" card with select (0–15 min), quick-pick buttons (`Default`, `1 min`, `2 min`, `3 min`, `5 min`, `10 min`, `15 min`), dynamic finish time estimate, and countdown badge (`"Next message in 2m 30s"`).
3. **CRM Deal Modal Polish (S5A):**
   - Styled form controls for Reassign form (`select` and `input` equal 38px height, matching focus rings, non-truncated placeholder "Reason (optional)").
   - Vertically centered labels and pills for "Assigned Agent:" and "SLA Status:" (`.deal-assignment-header-item`).
   - Dynamic relative overdue indicator (`"(overdue by 1h 12m)"`) for breached/escalated SLAs.
   - Assignment history formatted into a structured scrollable list with humanized text.
   - 14-16 digit internal IDs labeled as "WhatsApp ID:" with source badge.
   - Action buttons unified (Save Changes without oversized glow, Human Takeover, and Delete Deal separated to the right with confirmation dialog). Double-click protection enabled.
   - Aligned Qualification Temperature badge (`COLD`) and rule explanation row.
4. **Appointment Reminders (24h & 2h) Tracking (S5B):**
   - **Audit Map:** Documented in `WORKPILOT_DEBUG_DECISIONS.md`. Notice >24h creates both reminders; notice 2h–24h skips 24h; notice <2h skips both. Short-notice cases saved as `status = 'skipped'` with reason.
   - **Appointments Table:** Added "Reminders" column showing compact indicator `24h ✓ · 2h ⏱`.
   - **Appointment Details Modal:** Added "Appointment Reminders (24h & 2h)" panel with 24 Hours Before and 2 Hours Before cards displaying exact scheduled time in IST, status chip, and green tick ONLY on confirmed WhatsApp delivery.

---

### 3. Automated Verification & Test Results (S6)

- `npx jest tests/campaign-buffer-pending.test.js`: **10/10 PASS** (Buffer calculation, jitter, bounds, error un-truncation, status invariants).
- `npx jest tests/appointment-reminders.test.js`: **12/12 PASS** (24h & 2h generation, short-notice skip, cancellation, reschedule, timezone formatting).
- `npx jest tests/campaigns-unit.test.js`: **11/11 PASS**.
- `npx jest tests/csp-inline-styles.test.js`: **2/2 PASS** (0 CSP violations).
- `npm run lint`: **137/137 JS files passed syntax validation**.
- `scripts/diag/wiring-probe.js`: **PASS** (Zero circular imports, session exports intact).
- Browser Subagent: Visual check of deal modal, appointment reminders panel, and campaign delay buffer completed cleanly with screenshots captured.

---

### 4. Next Step: Live Verification (S7/S8)

To execute live sends with owner-approved allowlisted devices:
1. Provide owner test recipient numbers in `WORKPILOT_DEBUG_DECISIONS.md`:
   ```yaml
   TEST_RECIPIENTS:
     PRIMARY: "+91__________"
     SECONDARY: "+91__________"
     INVALID: "+910000000000"
   ```
2. Scan WhatsApp QR code in Settings if session is disconnected.
3. Trigger test campaign with 1 min buffer and disposable appointment to observe live WhatsApp message delivery on the device.
