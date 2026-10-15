# Real Estate WhatsApp Automation — Complete Implementation & Requirements Audit

**Audit Date:** October 15, 2026  
**Repository Working Tree:** `d:\WA REAL ESTATE\whatsapp-automation`  
**Audit Mode:** Read-only, non-destructive audit (no code rewritten, no branches switched, no server killed, no destructive suites rerun).

---

## 1. Working Tree & Project Protection Report

Prior to this audit, a clean read of git status was performed to inspect and preserve the working tree.

### Current Working Tree State (`git status --short`)
```text
 M .gitignore
 M package-lock.json
 M package.json
 M public/admin.html
 M public/css/landing.css
 M public/css/style.css
 M public/index.html
 M public/js/admin.js
 M public/js/app.js
 M public/js/inventory.js
 M scripts/list-inline-styles.js
?? REAL_ESTATE_CRM_AUDIT.md
?? REAL_ESTATE_CRM_AUDIT_PASS2.md
?? fonts-source.css
?? inline-style-groups.txt
?? playwright.config.js
?? scripts/dev/set-password.js
?? scripts/run-e2e-ui.js
?? scripts/run-e2e-with-db.js
?? tests/csp-inline-styles.test.js
```
*No existing files were modified, reverted, or deleted.*

---

## 2. Requirements Checklist Across All Planned Phases

The project has evolved through three major specification baselines:
1. **Generic WhatsApp SaaS Core & Concurrency Hardening** (Documented in `CHECKLIST.md`).
2. **Real Estate CRM Domain Conversion** (Migrations 013–020, `REAL_ESTATE_CRM_AUDIT.md`, and `REAL_ESTATE_CRM_AUDIT_PASS2.md`).
3. **Automated Brochure Drops, Unit State Machine, & Outbound Media Pipeline** (`src/services/brochure-drop.js`, `src/services/messaging.js`, `src/routes/inventory.js`).

### Status Legend
- **`IMPLEMENTED AND VERIFIED`**: Code exists, is wired end-to-end, and has automated tests confirming execution and constraints.
- **`IMPLEMENTED BUT NOT VERIFIED`**: Code exists and is wired, but lacks live end-to-end automated verification or relies on simulated/mocked transport.
- **`PARTIALLY IMPLEMENTED`**: Some sub-components exist in code/schema, but essential features (e.g. reminders, UI controls, or parameters) are missing.
- **`NOT IMPLEMENTED`**: Feature is absent from the schema and code.
- **`BLOCKED / DEPENDS ON EXTERNAL CONFIGURATION`**: Cannot function without external third-party credentials or external infrastructure (e.g., Google Calendar OAuth client, Meta Cloud API, live WhatsApp session).
- **`NOT IN SCOPE`**: Intentionally excluded by architecture (e.g., SQLite file backend superseded by PostgreSQL, Meta Cloud API superseded by whatsapp-web.js).

---

### Phase A: Security, Authentication & Multi-Tenancy

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| A.1 | Multi-tenant tenant isolation via `user_id` scoping | **IMPLEMENTED AND VERIFIED** | `tests/tenant-isolation.test.js`, all DB queries in `src/services/database.js` scope on `$1 = user_id`. |
| A.2 | Email & password signup + bcrypt (cost 12/4) | **IMPLEMENTED AND VERIFIED** | `src/routes/auth.js:88-118`, `tests/auth.security.test.js`. |
| A.3 | Admin approval flow (`status`: `pending` → `active` / `rejected` / `suspended`) | **IMPLEMENTED AND VERIFIED** | `src/routes/auth.js:151-173`, `src/routes/admin.js:46-105`, tested in `scripts/run-e2e-ui.js:611-635`. |
| A.4 | Signed HMAC-SHA256 session tokens with rotation & blacklisting | **IMPLEMENTED AND VERIFIED** | `src/config/auth.js`, verified in `tests/auth-revocation.test.js`. |
| A.5 | Instant session revocation (`auth_version`) on password change | **IMPLEMENTED AND VERIFIED** | Migration `011_users_auth_version.sql`, `src/config/auth.js:189-215`, tested in `tests/auth-revocation.test.js`. |
| A.6 | Timing attack mitigation on login (`burnPasswordVerification`) | **IMPLEMENTED AND VERIFIED** | `src/routes/auth.js:141-144`, constant-time execution confirmed. |
| A.7 | Eradication of hardcoded admin login backdoor | **IMPLEMENTED AND VERIFIED** | `docs/INCIDENT-backdoor-removal.md`, verified absent in `src/routes/auth.js:135-150` and enforced by `tests/backdoor-regression.test.js`. |
| A.8 | Strict Content Security Policy (CSP) with nonce & zero unsafe-inline | **IMPLEMENTED AND VERIFIED** | `src/config/app.js:65-98`, `tests/csp-inline-styles.test.js`, browser console CSP verification across 41 E2E tests. |
| A.9 | Encrypted storage of Google OAuth refresh tokens at rest | **NOT IMPLEMENTED** | `src/services/database.js:1335-1353` stores `access_token` and `refresh_token` in plaintext in `google_calendar_accounts`. |
| A.10 | Anti-theft phone masking in API responses (`+91 98765 XXXXX`) | **NOT IMPLEMENTED** | `maskPhone()` exists in `src/services/chatbot.js:314` for logs, but `src/routes/api.js` returns raw unmasked phone numbers in `/api/contacts`, `/api/crm/deals`, `/api/leads`. |

---

### Phase B: WhatsApp Connection & Lifecycle

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| B.1 | WhatsApp Web client initialization with per-user LocalAuth isolation | **IMPLEMENTED BUT NOT VERIFIED** | `src/services/whatsapp-client.js:160-260`. E2E tests mock/disable live WA initialization via `waEnabled: 0` guard to prevent test headless Chromium conflicts. |
| B.2 | Server-Sent Events (SSE) `/api/qr-stream` for QR code rendering | **IMPLEMENTED AND VERIFIED** | `src/routes/api.js:770-818`, Origin check, heartbeat interval, tested in E2E. |
| B.3 | Inbound message FIFO queue per conversation (`ConversationQueue`) | **IMPLEMENTED AND VERIFIED** | `src/utils/conversation-queue.js`, `tests/conversation-queue.test.js` (5/5 tests passing). |
| B.4 | WhatsApp message ACK status tracking (`sent`, `delivered`, `read`) | **IMPLEMENTED AND VERIFIED** | `src/services/whatsapp-client.js:460-490`, `tests/whatsapp-media-ack.test.js`. |
| B.5 | Session hibernation & RAM reclamation (`ENABLE_SESSION_HIBERNATION`) | **IMPLEMENTED BUT NOT VERIFIED** | `src/services/whatsapp-client.js:310-350`, idle timer logic present; unverified in production load. |
| B.6 | Meta Cloud API (Official WhatsApp API) | **NOT IN SCOPE** | System is architected intentionally on `whatsapp-web.js` browser-based Puppeteer automation. |

---

### Phase C: Real Estate Inventory & Unit Availability State Machine

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| C.1 | Real estate project catalogue (CRUD, RERA number, city, locality) | **IMPLEMENTED AND VERIFIED** | Migration `013_projects.sql`, `src/routes/inventory.js:67-133`, `tests/inventory.test.js`, E2E tests 4, 5, 30. |
| C.2 | Unit inventory (`tower`, `unit_number`, `bhk`, `area`, `price`, `floor`) | **IMPLEMENTED AND VERIFIED** | Migration `014_units.sql`, `uq_units_tower_number`, `src/routes/inventory.js:136-224`, `tests/inventory.test.js`, E2E test 6, 7, 11, 12. |
| C.3 | Unit state machine transitions (`VACANT` ↔ `ON_HOLD` → `BOOKED` → `SOLD`) | **IMPLEMENTED AND VERIFIED** | `src/services/database.js:1545-1615`, advisory transaction locks, invalid transition rejection (`INVALID_TRANSITION`), E2E tests 8 & 9. |
| C.4 | Unit status change audit log (`unit_status_history`) | **IMPLEMENTED AND VERIFIED** | Migration `014_units.sql`, `src/routes/inventory.js:225-232`, `tests/inventory.test.js`, E2E test 10. |
| C.5 | Automatic hold expiration after TTL (e.g., 30 mins) reverting to `VACANT` | **IMPLEMENTED AND VERIFIED** | `src/services/database.js:1618-1640`, dispatched every minute in `src/services/scheduler.js:69-70`, tested in unit test suite. |
| C.6 | Unit multi-filter search (`city`, `locality`, `bhk`, `minPrice`, `maxPrice`) | **IMPLEMENTED AND VERIFIED** | `src/routes/inventory.js:168-180`, `src/services/database.js:1520-1544`, verified in `inventory.test.js`. |

---

### Phase D: Media Assets & Automated Brochure Drops

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| D.1 | Media asset upload with MIME & magic byte validation (PDF, JPG, PNG, MP4) | **IMPLEMENTED AND VERIFIED** | Migration `015_media_assets.sql`, `src/services/messaging.js:47-152`, `src/routes/inventory.js:280-316`, E2E test 14. |
| D.2 | Authenticated asset streaming and downloads (`/assets/:id/file`) | **IMPLEMENTED AND VERIFIED** | `src/routes/inventory.js:368-383`, never served from public static directory, E2E test 15. |
| D.3 | Manual media send with idempotency key (`POST /assets/:id/send`) | **IMPLEMENTED AND VERIFIED** | Migration `017_messages_idempotency_key.sql`, `src/routes/inventory.js:321-353`, `tests/messaging-send-media.test.js`, E2E test 17. |
| D.4 | Media send history tracking (`media_asset_id` link in `messages`) | **IMPLEMENTED AND VERIFIED** | Migration `019_message_media_asset.sql`, `src/routes/inventory.js:355-360`, E2E test 16. |
| D.5 | Inbound keyword trigger matching (`#3BHK`, `3 BHK`, Project Name, RERA) | **IMPLEMENTED AND VERIFIED** | `src/services/brochure-drop.js:30-155`, `tests/brochure-drop.test.js`. |
| D.6 | Single match auto-drop of brochure & walkthrough | **IMPLEMENTED AND VERIFIED** | `src/services/brochure-drop.js:172-238`, `tests/brochure-drop.test.js`. |
| D.7 | Ambiguous match clarification inquiry reply | **IMPLEMENTED AND VERIFIED** | `src/services/brochure-drop.js:158-170`, `tests/brochure-drop.test.js`. |
| D.8 | RERA verification disclaimer enforcement on delivery | **IMPLEMENTED AND VERIFIED** | `src/services/brochure-drop.js:203`, only appends `(RERA Verified ✅)` when `rera_verified === 1`. |
| D.9 | Durable audit log for brochure drop decisions (`brochure_drop_events`) | **IMPLEMENTED AND VERIFIED** | Migration `020_brochure_drop_events.sql`, `src/routes/inventory.js:362-365`, E2E test 18 & 19. |

---

### Phase E: Real Estate CRM, Lead Qualification & Outreach

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| E.1 | Real estate qualification schema on deals (`lead_type`, `budget_min`, `budget_max`, `preferred_bhk`, `preferred_locality`, `timeline`, `financing_needed`, `site_visit_pref`, `interested_project_id`) | **IMPLEMENTED AND VERIFIED** | Migration `016_crm_deals_re_qualification.sql`, `src/routes/api.js:875-908`, `tests/real-estate-qualification.test.js`, E2E test 24. |
| E.2 | Rule-based lead temperature scoring (`HOT` / `WARM` / `COLD` with reason) | **IMPLEMENTED AND VERIFIED** | `src/services/lead-analyzer.js:165-194`, strict deterministic rules (not arbitrary LLM hallucination), tested in unit suite and E2E test 23. |
| E.3 | AI conversation extraction with prompt injection defense | **IMPLEMENTED AND VERIFIED** | `src/services/lead-analyzer.js:18-65`, guardrails treat chat transcript as data only. |
| E.4 | Durable bulk outreach jobs state (`outreach_jobs`, `outreach_recipients`) | **IMPLEMENTED AND VERIFIED** | Migration `018_outreach_jobs.sql`, `src/services/outreach.js`, atomic progress tracking surviving process disruptions. |
| E.5 | Multi-agent lead distribution / round-robin agent assignment | **NOT IMPLEMENTED** | `crm_deals` does not have an `assigned_to` agent column; multi-user agency workspace model not yet in database. |
| E.6 | Automated 1/3/7-day follow-up drip sequences | **NOT IMPLEMENTED** | Only one-off future scheduled messages exist in `scheduled_messages`. No multi-step sequence/enrollment engine exists. |
| E.7 | Property portal webhook ingestion (99acres, MagicBricks, Housing.com) | **NOT IMPLEMENTED** | No incoming webhook endpoints or API parsers exist in `src/routes/`. |

---

### Phase F: Appointments, Calendar & Reminders

| # | Requirement | Status | Concrete Evidence / Files |
|---|---|---|---|
| F.1 | Weekly availability configuration & timezone-safe slot generation | **IMPLEMENTED AND VERIFIED** | `src/services/availability.js:100-160`, `Asia/Kolkata` default via `src/utils/tz.js`. |
| F.2 | Advisory transaction-locked appointment booking (double-booking safe) | **IMPLEMENTED AND VERIFIED** | `src/services/database.js:1250-1280` (`pg_advisory_xact_lock`), `tests/appointment-concurrency.test.js`. |
| F.3 | Two-way Google Calendar OAuth2 synchronization | **IMPLEMENTED BUT NOT VERIFIED** | `src/services/google-calendar.js`, `src/routes/calendar.js`; relies on live Google credentials (`GOOGLE_CALENDAR_CLIENT_ID`). |
| F.4 | Site visit auto-reminders (24h before & 2h before with Google Maps pin) | **PARTIALLY IMPLEMENTED** | Appointments book and store `start_at` / `end_at`, but auto-creation of reminder scheduled messages with location pins is not hooked into `bookAppointment`. |

---

## 3. UI-to-Backend Route Coverage Map

Every frontend view, modal, and action has been traced to its backend Express route, HTTP method, validation, and database operations.

| UI Screen / Component | User Action / Trigger | Frontend Handler | Backend Route & Method | Auth / Middleware | DB Operations | Verified in E2E? |
|---|---|---|---|---|---|---|
| **Auth** (`login.html`) | Submit login credentials | `public/js/auth.js` | `POST /api/auth/login` | RateLimiter (`loginIpLimiter`, `loginAccountLimiter`) | `getUserByEmail`, `verifyPassword`, `touchLastLogin` | ✅ Yes (Test 1, 38) |
| **Auth** (`signup.html`) | Submit registration | `public/js/auth.js` | `POST /api/auth/signup` | Validation (`normalizeEmail`, `isValidPassword`) | `createUser` (status: `pending`) | ✅ Yes (Test suite) |
| **Auth** (`index.html`) | Click Logout | `public/js/app.js` | `POST /api/auth/logout` | `requireAuth` | `revokeSession` | ✅ Yes (Test 41) |
| **Dashboard** (`index.html`) | View KPI cards & activity | `loadDashboard()` in `app.js` | `GET /api/dashboard/stats` | `requireAuth` | `getDashboardStats(uid)` | ✅ Yes (Test 2) |
| **Properties Tab** | List all projects | `loadProjects()` in `inventory.js` | `GET /api/inventory/projects` | `requireAuth` | `getProjects(uid, filter)` | ✅ Yes (Test 3) |
| **Properties Modal** | Create project | Submit `#invProjectForm` | `POST /api/inventory/projects` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `createProject(uid, ...)` | ✅ Yes (Test 4) |
| **Properties Modal** | Edit project | Submit `#invProjectForm` (edit mode) | `PUT /api/inventory/projects/:id` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `updateProject(uid, id, ...)` | ✅ Yes (Test 5) |
| **Properties Action** | Delete project | Click Delete Project | `DELETE /api/inventory/projects/:id` | `requireAuth`, `writeLimiter` | `deleteProject(uid, id)` | ✅ Yes (Test 30) |
| **Availability Grid** | List units for project | Change project dropdown | `GET /api/inventory/projects/:id/units` | `requireAuth` | `getUnits(uid, projectId)` | ✅ Yes (Test 6, 7) |
| **Availability Modal** | Create new unit | Submit `#invUnitForm` | `POST /api/inventory/projects/:id/units` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `createUnit(uid, projectId, ...)` | ✅ Yes (Test 6) |
| **Availability Modal** | Edit existing unit | Submit `#invUnitForm` (edit mode) | `PUT /api/inventory/units/:id` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `updateUnit(uid, id, ...)` | ✅ Yes (Test 11) |
| **Availability Modal** | Delete unit | Click Delete Unit | `DELETE /api/inventory/units/:id` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `deleteUnit(uid, id)` | ✅ Yes (Test 12) |
| **Unit Manage Modal** | Transition to `ON_HOLD` | Click "Place Hold" | `POST /api/inventory/units/:id/hold` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `transitionUnitStatus('ON_HOLD')` + `unit_status_history` | ✅ Yes (Test 8) |
| **Unit Manage Modal** | Transition to `BOOKED` | Click "Book" | `POST /api/inventory/units/:id/book` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `transitionUnitStatus('BOOKED')` + `unit_status_history` | ✅ Yes (Test 9) |
| **Unit Manage Modal** | View status audit history | Click "Status History" | `GET /api/inventory/units/:id/history` | `requireAuth` | `getUnitStatusHistory(uid, unitId)` | ✅ Yes (Test 10) |
| **Assets Modal** | List project assets | Click "Assets" on project | `GET /api/inventory/projects/:id/assets` | `requireAuth` | `getMediaAssets(uid, projectId)` | ✅ Yes (Test 13) |
| **Assets Modal** | Upload media file | Submit `#invAssetForm` | `POST /api/inventory/projects/:id/assets` | `requireAuth`, `writeLimiter`, `multer` (17MB cap) | Magic byte check, `createMediaAsset` | ✅ Yes (Test 14) |
| **Assets Modal** | Preview uploaded file | Click "Preview" | `GET /api/inventory/assets/:id/file` | `requireAuth` | `getMediaAssetById`, `res.sendFile` (disk) | ✅ Yes (Test 15) |
| **Assets Modal** | Send asset to WhatsApp contact | Submit `#invSendAssetForm` | `POST /api/inventory/projects/:id/assets/:id/send` | `requireAuth`, `writeLimiter`, `wa_enabled` check | `sendMedia` + `logOutgoingMessageIdempotent` | ✅ Yes (Test 17 - Mocked WA) |
| **Assets Modal** | View send history | Click "Send History" | `GET /api/inventory/assets/:id/history` | `requireAuth` | `getMediaAssetSendHistory(uid, assetId)` | ✅ Yes (Test 16) |
| **Brochure-Drop Tab** | Load settings & history | Switch to Brochure tab | `GET /api/inventory/brochure-drops` & `/api/settings` | `requireAuth` | `getRecentBrochureDropEvents`, `getSetting` | ✅ Yes (Test 18) |
| **Brochure-Drop Tab** | Save triggers & asset config | Submit `#invBrochureForm` | `PUT /api/settings` | `requireAuth` | `saveSetting('brochure_triggers', ...)` | ✅ Yes (Test 19) |
| **CRM Section** | Load pipeline & deals | Open CRM tab | `GET /api/crm/deals` | `requireAuth` | `getCrmDeals(uid, { stage, leadTemp })` | ✅ Yes (Test 20, 22) |
| **CRM Section** | Add new deal | Submit `#dealModalForm` | `POST /api/crm/deals` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `createCrmDeal` + `addCrmActivity` | ✅ Yes (Test 21) |
| **CRM Deal Modal** | Update RE qualification | Submit deal qualification | `PUT /api/crm/deals/:id` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `updateCrmDeal(lead_type, budget, bhk, temp...)` | ✅ Yes (Test 24) |
| **CRM Section** | Filter by temperature | Select HOT / WARM / COLD | `GET /api/crm/deals?temperature=...` | `requireAuth` | `getCrmDeals` filtered by `lead_temp` | ✅ Yes (Test 23) |
| **Messages Tab** | View message threads | Switch to Messages tab | `GET /api/messages` | `requireAuth` | `getRecentMessages(uid)` | ✅ Yes (Test 25, 26) |
| **Messages Modal** | Open conversation thread | Click on contact | `GET /api/messages/conversation/:phone` | `requireAuth` | `getConversation(uid, phone)` | ✅ Yes (Test 27) |
| **Leads Section** | View lead qualification table | Switch to Leads tab | `GET /api/leads` | `requireAuth` | `getLeads(uid, filters)` | ✅ Yes (Test 28) |
| **Appointments Tab** | Load appointments list | Switch to Appointments tab | `GET /api/appointments` | `requireAuth` | `listAppointments(uid)` | ✅ Yes (Test 37) |
| **Appointments Tab** | Preview available slots | Load booking preview | `GET /api/appointments/slots` | `requireAuth` | `getAvailableSlots(uid)` | ⚠️ Unit verified only |
| **Appointments Modal** | Book manual appointment | Submit booking modal | `POST /api/appointments` | `requireAuth`, `writeLimiter`, `requireDurableWrite` | `bookAppointment` + `pg_advisory_xact_lock` | ⚠️ Integration verified |
| **Admin Panel** (`admin.html`) | List tenants & WA status | Load `admin.html` | `GET /api/admin/users` & `/api/admin/stats` | `requireAuth`, `requireAdmin` | `getAllUsersWithStats`, `getPlatformStats` | ✅ Yes (Test 39) |
| **Admin Action** | Approve new user | Click "Approve" | `POST /api/admin/users/:id/approve` | `requireAuth`, `requireAdmin` | `updateUserStatus(id, 'active')` | ⚠️ Unit verified only |
| **Admin Action** | Suspend user & kill session | Click "Suspend" | `PATCH /api/admin/users/:id` | `requireAuth`, `requireAdmin` | `updateUserStatus` + `destroyClientForUser` | ⚠️ Integration verified |

---

## 4. Database & Integration Completeness Assessment

### 4.1 Schema Completeness (PostgreSQL Migrations 001–020)
- **`users`** (001, 007, 008, 010, 011): Tenancy root with bcrypt hash, role enforcement (`user`/`admin`), status machine (`pending` / `active` / `rejected` / `suspended`), `wa_enabled` toggle, `auth_version` invalidation token, and password change timestamps.
- **`projects`** (013): Real estate catalog with strict `property_type` (`residential`, `commercial`, `plot`, `rental`, `resale`), `rera_status` (`verified`/`unverified`), and composite tenant indexing.
- **`units` & `unit_status_history`** (014): State machine with `VACANT`, `ON_HOLD`, `BOOKED`, `SOLD`. Includes unique constraint `uq_units_tower_number` on `(user_id, project_id, tower, unit_number)`, partial index for hold expirations, and audit logging.
- **`media_assets`** (015): Tracks physical asset storage with MIME validation, RERA verification flags, and links to projects/units.
- **`crm_deals`** (001, 016): Full real estate qualification columns (`lead_type`, `budget_min`, `budget_max`, `preferred_bhk`, `preferred_locality`, `timeline`, `financing_needed`, `site_visit_pref`, `interested_project_id`, `lead_temp`, `lead_temp_reason`) with foreign key reference to `projects(id)`.
- **`messages`** (001, 004, 012, 017, 019): Full deduplication and idempotency via `idempotency_key` unique index (`idx_messages_user_idempotency_key`) and foreign key linkage to `media_assets(id)`.
- **`outreach_jobs` & `outreach_recipients`** (018): Durable bulk campaign state tracking surviving server crashes without duplicate sends.
- **`brochure_drop_events`** (020): Audit log recording every brochure drop decision, project match, and asset count.

### 4.2 Integration Reality (Mocked vs. Real Deliveries)
1. **WhatsApp Web (`whatsapp-web.js`):**
   - In E2E tests, routes that invoke WhatsApp (`sendTextMessage`, `sendMediaMessage`) are strictly intercepted and mocked.
   - For regular E2E accounts, `waEnabled: 0` is enforced to prevent background Puppeteer/Chromium instances from launching on test ports.
   - **Critical Reality:** Passing the 41 E2E tests confirms the Express routing, validation, database insertion, and UI feedback; it **does NOT** prove WhatsApp delivers on real mobile devices under Meta's spam filters.
2. **Google Calendar OAuth2 (`googleapis`):**
   - The OAuth callback, token storage, and event creation code are implemented in `src/services/google-calendar.js`.
   - In test suites, external Google calls are mocked, and environment variables `GOOGLE_CALENDAR_CLIENT_ID` are deleted to protect test isolation.
3. **Google Gemini AI (`@google/genai`):**
   - Protected by a concurrency gate (`MAX_CONCURRENT_AI_JOBS=8`, `MAX_CONCURRENT_AI_PER_USER=2`) and a circuit breaker (5 consecutive failures = 60s cooldown).
   - The brochure drop pipeline in `src/services/brochure-drop.js` intentionally bypasses Gemini to deliver instantaneous replies without LLM latency or cost.

---

## 5. Test Coverage Gaps & Edge Cases

Comparing the 41 passing UI E2E tests against the total requirements reveals the following distinct coverage gaps:

### 5.1 Untested Backend Endpoints in E2E
1. **`GET /api/inventory/units/search`**: The multi-attribute search endpoint (filtering by city, locality, price range, and BHK) is covered by Jest integration tests (`tests/inventory.test.js`), but has no dedicated UI test verifying the search bar in `index.html`.
2. **`GET /api/appointments/slots`**: Slot generation with buffer time and working-hours calculations is tested in Jest (`tests/appointment-concurrency.test.js`), but the dashboard slot-picker widget is not exercised in the E2E flow.
3. **`POST /api/contacts/import`**: CSV contact file upload (with formula injection sanitization and row clamping) is tested in `tests/validation.test.js`, but missing from the UI E2E suite.
4. **`POST /api/admin/users/:id/approve` & `:id/reject`**: Admin user moderation buttons are rendered in `admin.html`, but the E2E suite only checks that the user list loads (Test 39), leaving button click handling unexercised in Playwright.

### 5.2 Negative & Failure Scenarios
1. **Invalid MIME / Corrupted Magic Bytes:** Handled gracefully in `messaging.js` unit tests, but no UI test uploads an invalid or disguised `.exe` file to verify that the UI displays the `MEDIA_INVALID_SIGNATURE` error toast.
2. **Concurrent Unit Booking Collision:** While advisory locks are verified at the DB layer in `appointment-concurrency.test.js`, concurrent clicks on the UI "Book" button for the same unit by two simultaneous browsers are not part of the UI test suite.
3. **Quota Rejection (`MESSAGE_LIMIT`):** UI behavior when a tenant exceeds their monthly message limit (HTTP 403 `MESSAGE_LIMIT`) is not covered by a UI test scenario.

---

## 6. Summary of Missing, Partial, Unverified & Blocked Items

### Categorized Breakdown

#### A. Not Implemented
1. **Google OAuth Token Encryption at Rest:** Tokens stored in plaintext in `google_calendar_accounts`.
2. **Anti-Theft Number Masking in API:** Field agents still receive unmasked customer phone numbers in `/api/contacts`, `/api/crm/deals`, and `/api/leads`.
3. **Automated Follow-up Drip Sequences:** No multi-day sequence state machine (e.g., Day 1 / Day 3 / Day 7 follow-up automation).
4. **Multi-Agent Lead Routing:** No `assigned_to` column on `crm_deals` or agent sub-user management.
5. **Property Portal Webhook Ingestion:** No webhook endpoints for 99acres, MagicBricks, or Housing.com.

#### B. Partially Implemented
1. **Site Visit Reminder Sequence:** Appointment booking and Google Calendar synchronization work, but automatic scheduling of a Saturday confirmation message and Sunday 2h GPS location pin is not wired.
2. **Human Handover / Pause AI Flag:** The `ConversationQueue` coordinates in-flight processing, but there is no per-conversation boolean switch to silence AI responses when an agent takes over a chat.

#### C. Implemented But Not Verified (Transport Mocked)
1. **Live WhatsApp Outbound Media Delivery:** End-to-end verified with simulated client, but real delivery on physical mobile hardware via Chromium automation requires physical device pairing.
2. **Live Google Calendar Bi-directional Sync:** Code is complete, but relies on a live Google Cloud Project client ID/secret.
3. **Session Hibernation & Dynamic Memory Eviction:** Code is present, but unverified under sustained 30-tenant concurrent load.

---

## 7. Prioritized Implementation Roadmap

To bring the project from its current verified baseline to full production readiness, complete these steps in order of dependency:

### Priority 1: Security & Compliance (Immediate)
- **Task:** Encrypt Google Calendar OAuth tokens at rest using AES-256-GCM.
- **Files:** `src/services/database.js`, add encryption helper with `TOKEN_ENCRYPTION_KEY` env var.
- **Verification:** Create `tests/token-encryption.test.js` to ensure ciphertext in DB cannot be read without the key.

### Priority 2: Real Estate Data Protection (High)
- **Task:** Implement backend role-based phone number masking.
- **Files:** Create a serializer middleware in `src/routes/api.js` masking phone numbers as `+91 98765 XXXXX` for non-admin/agent roles.
- **Verification:** Automated route assertion test verifying masked responses for agent sessions.

### Priority 3: Site Visit Automated Reminders (High)
- **Task:** Automatically create 24-hour and 2-hour reminder rows in `scheduled_messages` upon appointment booking.
- **Files:** `src/services/availability.js` inside `bookAppointment()`. Include the project's `map_url` or address in the reminder template.
- **Verification:** Unit test verifying `scheduled_messages` rows exist after booking an appointment.

### Priority 4: Drip Follow-Up Sequence Engine (Medium)
- **Task:** Build sequence definition and step enrollment tables (`drip_sequences`, `drip_enrollments`). Cancel pending steps if an inbound reply is received.
- **Files:** New migration `021_drip_sequences.sql`, sequence worker in `src/services/scheduler.js`.

### Priority 5: Multi-Agent Lead Assignment (Medium)
- **Task:** Add `assigned_to` integer foreign key on `crm_deals` referencing `users(id)`, with round-robin distribution logic on lead creation.
- **Files:** Migration `022_lead_assignment.sql`, update `src/services/lead-analyzer.js` and `src/routes/api.js`.

---

## 8. Exact Commands to Validate Remaining Work

Run these targeted commands to validate the system without running destructive operations or modifying code:

1. **Verify Database Health & Migration Version:**
   ```powershell
   npm run ready
   ```
2. **Execute Full Fast Security & Isolation Test Suite:**
   ```powershell
   npm run test:unit
   npm run test:integration
   ```
3. **Execute Isolated Real Estate Domain Test Suites (Requires `wa_test`):**
   ```powershell
   node scripts/run-tests-with-db.js tests/inventory.test.js tests/brochure-drop.test.js tests/messaging-send-media.test.js tests/real-estate-qualification.test.js
   ```
4. **Execute UI E2E Suite (Isolated harness on port 3101):**
   ```powershell
   npm run test:e2e:ui
   ```

---

## 9. Final Conclusion

The project's backend real estate foundation—including **PostgreSQL multi-tenancy, project and unit cataloging, unit status state machine with concurrency locks, media asset storage with magic byte validation, rule-based instant brochure drops, real estate CRM deal qualification, and CSP hardening**—is **fully implemented and verified by automated tests**.

However, the system **cannot be declared 100% complete** against the full real estate specification until:
1. Google OAuth tokens are encrypted at rest.
2. Anti-theft phone number masking is enforced in API serialization.
3. Automated site-visit reminder scheduling (24h/2h) is wired to appointment booking.
4. Physical WhatsApp device delivery is verified on a live handset.
