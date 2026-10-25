# WORKPILOT DEBUG DECISIONS & SYSTEM REGISTER

**Last Updated:** 2026-10-26T02:05:00+05:30  
**Environment:** Windows, Node.js v24.11.1, PostgreSQL 17 on Docker (`wa-postgres`:5432)  
**Backend:** Express on `http://localhost:3000` (PID launcher.js daemon)  
**Allowed Frontend Origin:** `https://enunciate-graves-dry.ngrok-free.dev`

---

## 1. §0 Test Fixtures & Allowlist Register

```yaml
TEST_RECIPIENTS:
  PRIMARY: "BLOCKED_PENDING_USER_INPUT" # Owner to provide standard phone number
  SECONDARY: "BLOCKED_PENDING_USER_INPUT" # Owner to provide @lid or 2nd device
  INVALID: "+910000000000"
TEST_TENANT: "aryan@gmail.com" # User ID 3 (Admin / Real Estate CRM)
TEST_PROJECT: "R2PROPERTY / Imperial Heights"
FRONTEND_ORIGIN: "https://enunciate-graves-dry.ngrok-free.dev"
```

> [!IMPORTANT]
> **Safety Rule**: No real outbound WhatsApp message will be sent to any destination not present in the allowlist. All live test items remain `BLOCKED` or `LIVE_PENDING_HUMAN` until the primary test number is provided.

---

## 2. Master Work Item Ledger & Dependency Matrix

| ID | Title | Status | Depends On | Last Error / Notes |
|---|---|---|---|---|
| **W0** | Bootstrap & Test Harness & Un-truncate Errors | **VERIFIED** | — | Fixed: allowlist safety harness, un-truncated error propagation in backend & frontend |
| **W1** | Shared text dispatch service (LID/@c.us/502) | **LIVE_PENDING_HUMAN** | W0 | Phone normalization, `@c.us` vs `@lid` fallback, real message ID capture (Automated checks PASS, awaiting live device send) |
| **W2** | Text-only campaign | **LIVE_PENDING_HUMAN** | W1 | Pacing, isolation, name template fallback, counters (Automated checks PASS, awaiting live device send) |
| **W3** | Shared media service ("id property... undefined") | **LIVE_PENDING_HUMAN** | W1 | `MessageMedia` construction, `newMsgKey` preserve in injected utils (Automated checks PASS, awaiting live device send) |
| **W4** | Campaign media end-to-end | **LIVE_PENDING_HUMAN** | W2, W3 | Media campaign dispatch + counters (Automated checks PASS, awaiting live device send) |
| **W5** | Gemini/AI tools & `thought_signature` | **VERIFIED** | W0 | Gemini 2.5/3.x thought signature preservation on multi-turn function calls |
| **W6** | Brochure/property intent | **INVESTIGATING** | W3, W5 | Intent matching, PDF asset lookup, honest failure response |
| **W7** | Appointment booking flow | **OPEN** | W1, W5 | Intent to real slot query, booking persistence, double-booking rejection |
| **W8** | Reminders 24h + 2h scheduling | **OPEN** | W1, W7 | Reminder job generation, time calculation, cancellation handling |
| **W9** | Agent availability toggle | **OPEN** | W0 | Set Busy/Available UI state, double-toast fix, routing skip |
| **W10** | SLA breached badges | **OPEN** | W0 | SLA rules, first-response tracking, UI badge alignment |
| **W11** | CORS / CSP / Login | **OPEN** | W0 | Ngrok origin handling, strict headers, credentials |
| **W12** | UI assets, icons, CSS & CSP inline sweep | **OPEN** | W11 | Zero CSP violations, icon font/SVG self-hosting, CSS audit |
| **W13** | Full cross-feature regression | **OPEN** | ALL | Complete system verification across tenants |

---

## 3. Investigation & Change History

### Iteration 1 — 2026-10-26 (W0 Bootstrap & Error Truncation: VERIFIED)
- **Target:** W0 Bootstrap & Error Truncation
- **Root Cause (CONFIRMED):** In minified WhatsApp Web code, thrown error objects frequently take the variable name `t` (`throw t`). When `outreach.js` constructed `Send failed: ${err.message}`, it stored `'Send failed: t'`, discarding the stack/code. Furthermore, `src/utils/errors.js` treated HTTP 502 as a generic internal server error and masked the error message to `'Something went wrong on our side. Please try again.'`. In the frontend, `public/js/app.js` crashed on non-JSON HTTP error responses and lacked guards for single-character error codes in toasts.
- **Files Changed:**
  - [`tests/live/harness.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/harness.js): Implemented `assertRecipientAllowlisted(number)` safety guard.
  - [`tests/live/harness.test.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/harness.test.js): 4/4 safety tests passing.
  - [`src/utils/errors.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/utils/errors.js): Allowed 502 upstream errors through with redacted message and un-truncated single-character error codes.
  - [`src/services/outreach.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/outreach.js): Added fallback to `err.code`, `err.stack`, or `err.name` when `err.message` is `'t'` or single-character.
  - [`public/js/app.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/public/js/app.js): Added safe JSON error parsing in `api()` and un-truncation in `showToast()`.
  - [`tests/w0-bootstrap.test.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/w0-bootstrap.test.js): Automated test suite verifying allowlist lockout, 502 upstream pass-through, and single-character error un-truncation. (4/4 passed).
- **Status Change:** `W0` → **`VERIFIED`**. Next: `W1`.

### Iteration 2 — 2026-10-26 (W1 Shared Text Dispatch: LIVE_PENDING_HUMAN)
- **Target:** W1 Shared text dispatch service (Phone / LID / JID resolution & rejection)
- **Root Cause (CONFIRMED):**
  1. Multi-device contacts with 14-15 digit LIDs were failing with `No LID for user (502)` because `resolveDestinationChatId` defaulted to `${digits}@c.us` when contact metadata was not found. WhatsApp Web has no `@c.us` user mapping for LID numbers.
  2. Unregistered 12-digit Indian numbers (`+91...`) and dummy/zero numbers (`+910000000000`) were falling through to `@c.us` and causing upstream crashes instead of clean 400 validation rejections.
- **Files Changed:**
  - [`src/services/whatsapp-client.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/whatsapp-client.js): Added zero-number pattern validation throwing `INVALID_RECIPIENT` (400), clean `RECIPIENT_NOT_ON_WHATSAPP` (400) for unregistered 12-digit numbers, defaulted 14-15 digit IDs to `@lid`, and added bidirectional `@c.us` <-> `@lid` retry in `sendTextMessage()`.
  - [`tests/live/live_manual_text.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_manual_text.js): Live verification script verifying negative rejection of dummy numbers, test harness lockout, 12-digit registration check, and LID resolution.
- **Verification:**
  - `tests/live/live_manual_text.js` executed: all 4 automated steps passed.
  - `tests/bugfixes-verification.test.js` executed: 6/6 passed.
- **Status Change:** `W1` → **`LIVE_PENDING_HUMAN`** (Automated checks complete; live send awaiting §0 allowlist input from operator). Next: `W2`.

### Iteration 3 — 2026-10-26 (W2 Text Campaign: LIVE_PENDING_HUMAN)
- **Target:** W2 Text-only campaign (Template rendering, name fallback, per-recipient isolation, counters)
- **Root Cause (CONFIRMED):** Template variable substitution in `renderTemplate` lacked whitespace trimming, broke on null/empty names, and did not support `{{first_name}}` or `{{phone}}`.
- **Files Changed:**
  - [`src/services/outreach.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/outreach.js): Enhanced `renderTemplate` with null safety, whitespace trimming, first-name extraction, and phone placeholder substitution; exported `renderTemplate`.
  - [`tests/live/live_campaign_text.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_campaign_text.js): Live script testing template rendering with name, empty name, missing name, counter aggregation against database, and negative recipient isolation.
- **Verification:**
  - `tests/live/live_campaign_text.js` executed: all 4 automated steps passed.
  - `tests/campaigns-unit.test.js` executed: 11/11 passed.
- **Status Change:** `W2` → **`LIVE_PENDING_HUMAN`** (Automated checks complete; live campaign dispatch awaiting §0 allowlist input from operator). Next: `W3`.

### Iteration 4 — 2026-10-26 (W3 Shared Media Service: LIVE_PENDING_HUMAN)
- **Target:** W3 Shared media service ("id property ... got undefined" in WhatsApp Web injected Utils.js)
- **Root Cause (CONFIRMED):** Spreading `mediaOptions.toJSON()` after `id: newMsgKey` in `whatsapp-web.js` injected `Utils.js` overwrote `message.id` with `undefined`. When WhatsApp Web's memoized collection getter `Msg.get(message.id)` ran, it threw `Data passed to getter must include an id property ... but got undefined`.
- **Files Changed:**
  - [`scripts/patch-wwebjs.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/scripts/patch-wwebjs.js): Created automated, reproducible postinstall patch script.
  - [`package.json`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/package.json): Added `"postinstall": "node scripts/patch-wwebjs.js"` hook.
  - [`patches/whatsapp-web.js+1.34.7.patch`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/patches/whatsapp-web.js+1.34.7.patch): Committed reproducible patch.
  - [`tests/live/live_media_matrix.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_media_matrix.js): Live script verifying injected patch presence, postinstall hook, magic-byte media validation, and tampered signature rejection.
- **Verification:**
  - `npm run postinstall` ran: confirmed patch applied.
  - `tests/live/live_media_matrix.js` executed: all 4 automated steps passed.
  - `npx jest tests/outreach-media-unit.test.js` executed: 13/13 passed.
- **Status Change:** `W3` → **`LIVE_PENDING_HUMAN`** (Automated checks complete; live media dispatch awaiting §0 allowlist input from operator). Next: `W4`.

### Iteration 5 — 2026-10-26 (W4 Campaign Media End-to-End: LIVE_PENDING_HUMAN)
- **Target:** W4 Campaign media end-to-end + counters
- **Root Cause (CONFIRMED):** Campaign media required durable persistence of `media_asset_id` on `outreach_jobs` and strict tenant isolation so tenants cannot attach media belonging to other users.
- **Files Changed:**
  - [`tests/live/live_campaign_media.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_campaign_media.js): Live script testing active media assets (WorkPilot_Solutions.pdf and TECH_EVENTS.jpeg), tenant isolation on media assets, media campaign creation with `media_asset_id`, and cleanup.
- **Verification:**
  - `tests/live/live_campaign_media.js` executed: all 4 automated steps passed.
  - `npx jest tests/outreach-ui-unit.test.js` executed: 12/12 passed.
- **Status Change:** `W4` → **`LIVE_PENDING_HUMAN`** (Automated checks complete; live media campaign dispatch awaiting §0 allowlist input from operator). Next: `W5`.

### Iteration 6 — 2026-10-26 (W5 Gemini AI Tools & Thought Signature: VERIFIED)
- **Target:** W5 Gemini AI tools (`thought_signature` preservation, multi-turn tool calling, honest fallback)
- **Root Cause (CONFIRMED):** Gemini 2.5/3.x returns candidate `functionCall` parts alongside an internal `thoughtSignature`. When `ai.js` constructed synthetic parts for round 2, it omitted `thoughtSignature`, triggering `HTTP 400: Function call is missing a thought_signature in functionCall parts`. Preserving `response.candidates[0].content` resolved the turn-2 crash.
- **Files Changed:**
  - [`src/services/ai.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/ai.js): Preserved `response.candidates[0].content` with `thoughtSignature` and `callId` across tool loop turns.
  - [`tests/live/live_gemini.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_gemini.js): Live verification script performing real multi-turn tool calls (`check_availability` returning real slots), verifying zero thought signature errors, and testing honest failure rejection.
- **Verification:**
  - `tests/live/live_gemini.js` executed: all 3 automated steps passed against live Gemini API.
- **Status Change:** `W5` → **`VERIFIED`**. Next: `W6`.

### Iteration 7 — 2026-10-26 (W6 Brochure Intent & Context Matching: LIVE_PENDING_HUMAN)
- **Target:** W6 Brochure/property intent (`mujhe boruchure share kro iska`, context `noida`)
- **Root Cause (CONFIRMED):**
  1. `DEFAULT_TRIGGERS` only matched exact spelling `brochure`, failing on common Indian / Hinglish typo variants (`boruchure`, `broucher`, `share kro`, `bhejo`).
  2. Stored `brochure_triggers` setting completely erased `DEFAULT_TRIGGERS` instead of augmenting them.
  3. `projectReferences(project)` only mapped `name`, `rera_number`, and `listing_url`, ignoring `city` ('NOIDA') and `locality` ('NOIDA JUNCTION').
  4. Pronoun/anaphoric context like `"iska"` was unresolved because `matchProjects` did not inspect recent conversation history for prior location/project context.
- **Files Changed:**
  - [`src/services/brochure-drop.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/brochure-drop.js):
    - Added typo variants (`/\bb[or]{1,2}u?ch[eu]r[es]*\b/i`) and Hinglish phrasing (`share kro`, `bhejo`, `details`) to `DEFAULT_TRIGGERS`.
    - Combined `DEFAULT_TRIGGERS` with custom tenant triggers in `getTriggers`.
    - Added `project.city` and `project.locality` to `projectReferences`.
    - Implemented reverse (newest-to-oldest) conversation history context inspection in `matchProjects(userId, text, phone)` with word-boundary matching.
  - [`tests/live/live_brochure_chat.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_brochure_chat.js): Built comprehensive live test verifying:
    1. Typo / Hinglish trigger recognition.
    2. Conversational context resolution ("Noida" in prior turn → matches project "NEW").
    3. Media asset dispatch (`WorkPilot_Solutions.pdf`) with post-dispatch confirmation and zero meeting-offer substitution.
    4. Missing-asset honest fallback (Bhopal project with 0 assets replies truthfully without meeting offer).
    5. Ambiguous query clarification listing candidate projects.
- **Verification:**
  - `tests/live/live_brochure_chat.js` executed: all 5 steps passed.
  - `npx jest tests/brochure-drop.test.js` executed: 21/21 passed.
- **Status Change:** `W6` → **`LIVE_PENDING_HUMAN`** (Automated checks complete; live media brochure dispatch awaiting §0 allowlist input from operator). Next: `W7`.

### Iteration 8 — 2026-10-26 (W7 Appointment Booking Lifecycle: VERIFIED)
- **Target:** W7 Appointment booking (intent -> real slots -> collect details -> confirm slot -> persist -> double-booking rejection -> cancel/reschedule)
- **Root Cause (CONFIRMED):**
  1. AI tool loop had `check_availability` and `book_appointment`, but lacked `reschedule_appointment` and `cancel_appointment` tool declarations and execution handlers for chatbot inbound flows.
  2. Rescheduling required durable atomic transaction logic in `database.js` (`updateAppointment` with advisory locking and conflict checking) and `availability.js` (`rescheduleAppointment` invalidating old reminders and scheduling updated ones).
  3. `appointments` router lacked a `PATCH /:id` endpoint for dashboard and programmatic rescheduling.
- **Files Changed:**
  - [`src/services/database.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/database.js): Added `updateAppointment` and `getLatestAppointmentForPhone`.
  - [`src/services/availability.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/availability.js): Added `rescheduleAppointment` with full conflict re-validation and reminder rescheduling.
  - [`src/services/ai.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/ai.js): Added `reschedule_appointment` and `cancel_appointment` to `BOOKING_TOOLS` and `generateReplyWithBooking`.
  - [`src/routes/appointments.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/routes/appointments.js): Added `PATCH /api/appointments/:id` endpoint for rescheduling.
  - [`tests/live/live_appointment.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_appointment.js): Comprehensive live test for intent detection, slot booking, DB persistence, double-booking rejection (`SLOT_TAKEN`), rescheduling with reminder invalidation, and cancellation.
- **Verification:**
  - `tests/live/live_appointment.js` executed: all 5 steps passed.
  - `node --test tests/bugfixes-verification.test.js` executed: 6/6 passed.
  - `npx jest tests/appointment-reminders.test.js` executed: 12/12 passed.
- **Status Change:** `W7` → **`VERIFIED`**. Next: `W8`.

### Iteration 9 — 2026-10-26 (W8 Site Visit Reminders 24h + 2h: VERIFIED)
- **Target:** W8 Reminders 24h + 2h (job creation, timezone/UTC math, scheduler running, due-query, locking, bounded retries, reschedule/cancel invalidates jobs, short-notice policy, never mark sent before dispatch success)
- **Root Cause (CONFIRMED):**
  1. `scheduled_messages` schema requires strict compliance with existing columns: `appointment_id` (FK to appointments), `reminder_type`, and `error_message`.
  2. Short-notice policies correctly govern lead time: >24h lead time schedules both 24h and 2h reminders; 10h lead time schedules only the 2h reminder; <2h lead time schedules 0 reminders.
  3. Worker restart / crash recovery (`reclaimStuckScheduledMessages`) reliably marks interrupted in-flight messages as `failed` with clear reason ("Interrupted while sending...").
  4. Rescheduling and appointment cancellation reliably suppress due reminders with status `cancelled` ("Appointment is no longer active or was cancelled").
  5. Invalid recipient phones fail safely with status `failed` ("Stored phone number is not valid") without infinite stuck retry loops.
- **Files Created / Verified:**
  - [`tests/live/live_reminders.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_reminders.js): 6-step automated test suite covering advance lead-time variations, scheduler execution, PostgreSQL row status progression to `sent`, idempotency on next tick, worker crash reclamation, cancellation suppression, and invalid phone bounded failures.
  - `.workpilot/evidence/W8/evidence.json`: Detailed machine-readable test execution output.
- **Verification:**
  - `tests/live/live_reminders.js` executed: all 6 steps passed.
  - `npx jest tests/appointment-reminders.test.js` executed: 12/12 unit tests passed.
- **Status Change:** `W8` → **`VERIFIED`**. Next: `W9`.

### Iteration 10 — 2026-10-26 (W9 Agent Availability: VERIFIED)
- **Target:** W9 Agent availability (Set Busy toast but card stays available, repeated toasts: wrong ID? DB write? stale state? polling overwrite? double submit? toast before confirmation? Verify routing honors status)
- **Root Cause (CONFIRMED):**
  1. **Backend Payload Whitelist Omission:** In [`src/routes/api.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/routes/api.js), `PUT /crm/agents/:id` explicitly whitelisted fields from `req.body`, but completely omitted `routing_status`, `weight`, and `max_concurrent_leads`. When the frontend sent `{ routing_status: 'busy' }`, `updateAgent` was called with `{}`. The database row was never updated, yet HTTP 200 was returned.
  2. **Agent Self-Update Permission:** `PUT /crm/agents/:id` was guarded exclusively by `requireManagerOrAdmin`, preventing logged-in agent user accounts from toggling their own availability status.
  3. **Frontend Double-Submit:** In [`public/js/app.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/public/js/app.js), the toggle button was not disabled during the in-flight request, allowing rapid clicks to trigger repeated API calls and toasts. Furthermore, `loadAgentWorkload()` was invoked following the false 200, reloading the unchanged DB row and flipping the UI back to `available`.
- **Files Changed:**
  - [`src/routes/api.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/routes/api.js): Added `routing_status`, `weight`, and `max_concurrent_leads` to allowed fields in `PUT /crm/agents/:id` and `POST /crm/agents`. Updated role authorization to allow agents to update their own `routing_status`/`status`.
  - [`public/js/app.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/public/js/app.js): Updated `toggleAgentStatus` and click handler to disable button during API execution, await server state confirmation, and prevent duplicate submissions.
  - [`tests/bugfixes-verification.test.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/bugfixes-verification.test.js): Added missing `require('dotenv').config()` for database tests.
  - [`tests/live/live_agent_status.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_agent_status.js): Live test verifying Set Busy HTTP PUT, DB `status = 'paused'`, GET workload returning `busy`, lead routing skipping busy agent, Set Available HTTP PUT, DB `status = 'active'`, and tenant isolation (Tenant B 404).
- **Verification:**
  - `tests/live/live_agent_status.js` executed: all steps passed (Set Busy, routing skip, Set Available, tenant isolation).
  - `node --test tests/bugfixes-verification.test.js` executed: 6/6 tests passed.
  - `npx jest tests/lead-assignment-sla.test.js` executed: 17/17 tests passed.
- **Status Change:** `W9` → **`VERIFIED`**. Next: `W10`.

### Iteration 11 — 2026-10-26 (W10 SLA Breached Badges & Tracking: VERIFIED)
- **Target:** W10 SLA breached badges (verify rules/timestamps first — breaches may be legitimate; fix only if calculation, first-response tracking, reassignment handling, sweep, or UI mapping is wrong)
- **Root Cause (CONFIRMED):**
  1. **Enum String Mismatch Across Stack:**
     - Database migration 022 and `src/routes/api.js` enforced `['on_time', 'approaching_sla', 'sla_breached', 'escalated']`.
     - `public/index.html` dropdown filter and `public/js/app.js` `getSlaBadge()` checked `'sla_on_time'` and `'sla_approaching'`.
     - As a result, deals on time rendered no badge at all, and selecting "On Time" or "Approaching" in the CRM filter resulted in an HTTP 400 validation error.
  2. **First-Response Tracking Guard Defect:**
     - In [`src/services/database.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/database.js), `logMessage()` checked `isHuman` using `typeof arg2 === 'object'`. Shorthand calls `logMessage(userId, phone, 'outgoing', text)` were treated as non-human, completely skipping `recordFirstResponse`.
     - Furthermore, `recordFirstResponse` was executed as an unawaited floating promise (`.catch(() => {})`), introducing race conditions with subsequent database reads.
  3. **Reassignment Corruption:**
     - [`src/services/lead-assignment.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/lead-assignment.js) `assignLead` unconditionally set `sla_status = 'on_time'` and `sla_response_due_at = first_response_at`, corrupting already responded deals.
  4. **Approaching SLA Sweep Omission:**
     - `checkAndEscalateOverdueSlas()` only swept overdue deals, never transitioning leads within the 15-minute warning window to `'approaching_sla'`.
- **Files Changed:**
  - [`src/routes/api.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/routes/api.js): Added legacy/canonical normalization for `sla_status` query parameter.
  - [`public/index.html`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/public/index.html): Fixed `crmSlaFilter` options to canonical values (`on_time`, `approaching_sla`).
  - [`public/js/app.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/public/js/app.js): Updated `getSlaBadge()` to support canonical values, distinguish on-time ("Responded") vs late response ("Responded Late"), and dynamic overdue/approaching calculation.
  - [`src/services/database.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/database.js): Updated `isHuman` logic and awaited `recordFirstResponse`.
  - [`src/services/lead-assignment.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/services/lead-assignment.js): Preserved responded deal state in `assignLead`, and added approaching SLA proactive transition in `checkAndEscalateOverdueSlas`.
  - [`tests/live/live_sla.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_sla.js): Live verification testing on-time response, escalation sweep, late response, reassignment preservation, approaching SLA transition, and API filtering.
- **Verification:**
  - `tests/live/live_sla.js` executed: all 6 steps passed.
  - `node --test tests/bugfixes-verification.test.js` executed: 6/6 tests passed.
  - `npx jest tests/lead-assignment-sla.test.js` executed: 17/17 tests passed.
- **Status Change:** `W10` → **`VERIFIED`**. Next: `W11`.

### Iteration 12 — 2026-10-26 (W11 CORS / CSP / Login Origin: VERIFIED)
- **Target:** W11 CORS/CSP/login (ngrok origin): config-driven allowed origins, preflight, credentials, headers on error responses, identify CSP script source (app vs. browser extension); no unsafe-inline shortcut
- **Root Cause (CONFIRMED):**
  1. `src/config/cors.js` previously only parsed `ALLOWED_ORIGINS`, neglecting `FRONTEND_ORIGIN`.
  2. Content-Security-Policy header in `src/config/app.js` lacked `blob:` in `img-src` (causing browser violations when rendering client-side image/PDF attachment previews via `URL.createObjectURL(blob)`), and `connect-src` was strictly `'self'`, blocking external API/SSE origins.
  3. `errorHandler` in `src/utils/errors.js` lacked explicit fallback attachment of CORS headers on unexpected 4xx/5xx exceptions.
- **Files Changed:**
  - [`src/config/cors.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/config/cors.js): Enhanced `getAllowedOrigins()` to automatically incorporate `process.env.FRONTEND_ORIGIN`.
  - [`src/config/app.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/config/app.js): Added `blob:` to CSP `img-src` and dynamically allowed HTTP/HTTPS origins in `connect-src`.
  - [`src/utils/errors.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/src/utils/errors.js): Guaranteed `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials: true` on error responses for allowed origins without ever resorting to `*`.
  - [`tests/live/live_auth_cors.js`](file:///d:/WA%20REAL%20ESTATE/whatsapp-automation/tests/live/live_auth_cors.js): 6-step test verifying origin allowlist, preflight OPTIONS (204), bad credentials error preservation (401), authenticated call (200), unapproved origin blocking (403), and strict CSP validation (per-request nonces, no unsafe-inline, blob: support).
- **Verification:**
  - `tests/live/live_auth_cors.js` executed: all 6 steps passed.
  - `npx jest tests/cors.test.js` executed: 10/10 tests passed.
- **Status Change:** `W11` → **`VERIFIED`**. Next: `W12`.






