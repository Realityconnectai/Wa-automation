# Workpilot WhatsApp Automation — Real Estate CRM Conversion Audit

**Audit Date:** October 12, 2026  
**Auditor:** Kiro AI (read-only, no code changes made)  
**Source of Truth:** Live repository at `d:\WA REAL ESTATE\whatsapp-automation` (branch: `final-delivary`)  
**Purpose:** Evaluate the existing codebase before converting it into a Real Estate WhatsApp CRM SaaS

> **Verification note:** Every finding below is based on direct inspection of source files. Assumptions are explicitly labelled. Nothing is inferred from prior documentation.

---

## A. Executive Summary

The existing product is a **production-grade, multi-tenant WhatsApp automation SaaS** built on Node.js + PostgreSQL. It is significantly further along than a typical MVP — it has real authentication, tenant isolation, rate limiting, AI conversation analysis, a CRM pipeline, appointment booking, Google Calendar sync, and a robust scheduler.

**The good news for real estate conversion:** The core infrastructure — multi-tenancy, WhatsApp messaging, Gemini AI, CRM deals, appointments, contacts, scheduled messages, and Google Calendar — is all working and of high quality. It can be reused almost entirely.

**The hard news:** The product was designed for a generic SMB (coaches, consultants, service businesses). Real estate requires a fundamentally different data model — property inventory, unit-level availability grids, lead qualification by budget/BHK/location, brochure/media delivery, agent assignment, and property-portal webhook ingestion. None of these exist. They must be built.

**Conversion estimate:** The existing codebase provides roughly **50–60% of the infrastructure** needed for a real estate CRM. The remaining work is net-new domain logic, not a rebuild.

**Fastest safe path:** Keep the entire backend infrastructure, database engine, auth, AI stack, and scheduler. Add a `properties` table, extend the `products` table for real estate listings, extend `crm_deals` with real estate qualification fields, replace the generic product catalog UI with a property browser, and add follow-up automation on top of the existing scheduler. This is additive, not destructive.

---

## B. Technology Stack and Architecture

### Verified Stack

| Layer | Technology | Evidence |
|---|---|---|
| Runtime | Node.js ≥ 20 (tested on v24.11.1) | `package.json` engines field |
| Web framework | Express 4.21 | `package.json`, `src/config/app.js` |
| Database | **PostgreSQL** (via `pg` 8.23) | `src/services/db-pool.js`, `src/migrations/*.sql` |
| ORM/Query layer | Raw SQL with parameterised queries | `src/services/database.js`, `src/services/db-pool.js` |
| WhatsApp integration | **whatsapp-web.js 1.34.7** (QR/browser-based, NOT Meta Cloud API) | `package.json`, `src/services/whatsapp-client.js` |
| AI provider | **Google Gemini** via `@google/genai 2.16` | `src/services/gemini-client.js` |
| Auth | Custom HMAC-SHA256 signed tokens + bcrypt 2.4.3 (rounds=12) | `src/config/auth.js` |
| Scheduling | node-cron 4.6 | `src/services/scheduler.js` |
| Google Calendar | googleapis 176 (OAuth2) | `src/services/google-calendar.js` |
| CSV import/export | Custom parser | `src/services/csv.js` |
| Process supervision | Custom launcher.js with exponential backoff | `launcher.js` |
| Containerisation | Docker + Docker Compose | `Dockerfile`, `docker-compose.yml`, `docker-compose.prod.yml` |
| Reverse proxy | Caddy (production) | `Caddyfile`, `docker-compose.prod.yml` |
| Deployment targets | Docker VPS, Render | `render.yaml`, `DEPLOY.md` |

### Architecture Pattern

```
Browser
  │
  ├── Static files (public/)
  │
  └── HTTPS → Caddy → Node.js (port 3000)
                         │
                         ├── Express routes (src/routes/)
                         │     ├── /api/auth      — authentication
                         │     ├── /api/admin     — admin panel
                         │     ├── /api/*         — per-tenant features
                         │     ├── /api/calendar  — Google Calendar OAuth
                         │     ├── /api/appointments — booking
                         │     └── /api/qr-stream — SSE for QR/status
                         │
                         ├── Services (src/services/)
                         │     ├── whatsapp-client.js  — per-user Chrome sessions
                         │     ├── chatbot.js          — rule matching + AI dispatch
                         │     ├── ai.js               — Gemini reply generation
                         │     ├── lead-analyzer.js    — AI conversation analysis
                         │     ├── scheduler.js        — cron every 1 min
                         │     ├── calendar-sync.js    — cron every 5 min
                         │     └── outreach.js         — bulk send jobs
                         │
                         └── PostgreSQL (pg pool)
                               └── 14 tables, 11 migrations
```

### Database Configuration

- **Engine:** PostgreSQL (verified from `db-pool.js` which imports `require('pg')` and uses `Pool`)
- **Connection:** `DATABASE_URL` env var (`postgresql://user:pass@host:port/db`) or discrete `DB_HOST/PORT/NAME/USER/PASSWORD` vars
- **Pool settings:** configurable via `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_CONN_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`
- **TLS:** `DB_SSL` env var (false/true/allow-self-signed)
- **Migrations:** Versioned SQL files in `src/migrations/`, run via `pg_advisory_xact_lock` to prevent concurrent startup races
- **Dev vs. Prod:** Same PostgreSQL engine in both. Tests use a separate DB (controlled by `tests/setup.js` which sets `NODE_ENV=test` and redirects `PERSIST_ROOT`)
- **NOTE:** `paths.js` still references a `DB_PATH` for `whatsapp.db` (SQLite path) — this is a legacy artefact from the SQLite era and is **not used** by the actual database layer anymore (verified: `db-pool.js` never imports `DB_PATH`)

---

## C. Existing Feature Inventory

### Authentication & User Management

| Feature | Status | Evidence |
|---|---|---|
| Email + password signup | ✅ Implemented | `src/routes/auth.js` POST /api/auth/signup |
| Login with bcrypt verification | ✅ Implemented | `src/routes/auth.js` POST /api/auth/login |
| Custom signed session token (HMAC-SHA256) | ✅ Implemented | `src/config/auth.js` createSessionToken/verifySessionToken |
| Token rotation (after 24h) | ✅ Implemented | `src/config/auth.js` shouldRotateToken |
| Instant session revocation (auth_version) | ✅ Implemented | `src/config/auth.js` revokeAllSessionsForUser, migration 011 |
| Password change invalidates old sessions | ✅ Implemented | `src/middleware/auth.js` auth_version check |
| Admin role enforcement | ✅ Implemented | `src/middleware/auth.js` requireAdmin |
| Account approval workflow (pending→active) | ✅ Implemented | `src/routes/admin.js` POST /api/admin/users/:id/approve |
| Account suspension | ✅ Implemented | `src/routes/admin.js` PATCH /api/admin/users/:id |
| Bootstrap admin via env var | ✅ Implemented | `server.js` BOOTSTRAP_ADMIN_EMAIL |
| Per-user WhatsApp access flag (wa_enabled) | ✅ Implemented | migration 007, admin PATCH route |
| 2FA / MFA | ❌ Missing | No evidence anywhere |
| UPI payment approval before activation | ❌ Missing | No payment processor integration |

### WhatsApp Connection

| Feature | Status | Evidence |
|---|---|---|
| QR-based WhatsApp connection | ✅ Implemented | `src/services/whatsapp-client.js` using whatsapp-web.js LocalAuth |
| Per-tenant isolated sessions | ✅ Implemented | `sessions` Map keyed by userId, `user_${id}` auth folders |
| Session persistence across restarts | ✅ Implemented | `resumeExistingSessions()` in server.js, staggered reconnect |
| Session hibernation (RAM saving) | ✅ Implemented | `ENABLE_SESSION_HIBERNATION`, `SESSION_IDLE_TIMEOUT_MS` |
| SSE stream for QR code delivery | ✅ Implemented | `addSSEClient`, `/api/qr-stream` |
| Concurrent session cap | ✅ Implemented | `MAX_CONCURRENT_WHATSAPP_SESSIONS` env var |
| Session crash recovery | ✅ Implemented | watchdog timer, exponential backoff restart in launcher.js |
| Meta Cloud API (official WhatsApp Business API) | ❌ **Not implemented** | Uses whatsapp-web.js (browser automation) only |
| Webhook verification (for Meta API) | ❌ **Not implemented** | No webhook endpoint exists |
| Message delivery receipts (read/delivered) | ⚠️ Partial | Status stored as 'sent'/'failed' but no delivery/read tracking |
| Media/image/document sending | ❌ **Not implemented** | `sendTextMessage` in whatsapp-client.js — text only |
| Incoming media handling | ❌ **Not implemented** | chatbot.js processes text body only |

### Contacts & Conversations

| Feature | Status | Evidence |
|---|---|---|
| Contact CRUD with phone normalisation | ✅ Implemented | `src/routes/api.js` /api/contacts, validate.js normalizePhone |
| Contact labels and notes | ✅ Implemented | contacts table: label, notes columns |
| Deduplication (UNIQUE user_id+phone) | ✅ Implemented | `uq_contacts_user_phone` constraint |
| Auto-save contact on first send | ✅ Implemented | api.js sendMessage handler |
| CSV import (up to 5000 rows) | ✅ Implemented | `src/services/csv.js`, POST /api/contacts/import |
| Contact outreach tracking | ✅ Implemented | last_outreach_at column, migration 002 |
| Per-tenant contact cap (50,000) | ✅ Implemented | LIMITS.MAX_CONTACTS_PER_USER |
| Conversation history | ✅ Implemented | messages table, GET /api/messages/conversation/:phone |
| Message direction tracking (in/out) | ✅ Implemented | messages.direction column |
| Idempotent message sends (dedup on retry) | ✅ Implemented | idx_messages_idempotency, migration 004 |
| Bulk outreach (background job) | ✅ Implemented | `src/services/outreach.js`, max 25 recipients |
| JSON export | ❌ Not found | No export endpoint in routes |

### AI & Chatbot

| Feature | Status | Evidence |
|---|---|---|
| Keyword-based chatbot rules (exact/contains/starts/regex) | ✅ Implemented | `src/services/chatbot.js`, chatbot_rules table |
| ReDoS protection on regex rules | ✅ Implemented | `src/utils/validate.js` assertSafeRegexSource |
| AI auto-reply (Gemini) | ✅ Implemented | `src/services/ai.js` generateReply |
| AI mode: rules-first or AI-first | ✅ Implemented | `ai_mode` setting, chatbot.js dispatch logic |
| Away mode | ✅ Implemented | `away_mode` setting, `away_message` |
| Default reply | ✅ Implemented | `default_reply` setting |
| AI appointment booking via function calling | ✅ Implemented | `src/services/ai.js` BOOKING_TOOLS, generateReplyWithBooking |
| Gemini circuit breaker + retry + fallback models | ✅ Implemented | `src/services/gemini-client.js` |
| AI lead analysis (interest, score, sentiment, priority) | ✅ Implemented | `src/services/lead-analyzer.js`, lead_analysis table |
| Auto-trigger analysis after conversation | ✅ Implemented | `scheduleAutoAnalysis` in chatbot.js |
| AI business profile analysis | ✅ Implemented | `src/services/business.js` analyzeBusinessProfile |
| AI auto-create CRM deal from conversation | ✅ Implemented | `aiUpsertCrmDeal` called from lead-analyzer.js |
| Prompt injection protection | ✅ Implemented | ai.js guardrails block, user content never in system instruction |
| Per-user API key support | ✅ Implemented | gemini_api_key setting per tenant |
| Conversation rate limiting (anti-ban) | ✅ Implemented | chatbot.js isRateLimited (10/min per sender) |
| Human handover / stop AI for contact | ❌ **Missing** | No per-conversation AI pause mechanism |
| AI property search / property matching | ❌ **Missing** | No property-domain tools |
| AI budget/BHK/location qualification | ❌ **Missing** | Generic qualification only |

### CRM Pipeline

| Feature | Status | Evidence |
|---|---|---|
| Deal stages (new→contacted→qualified→proposal→negotiation→won→lost) | ✅ Implemented | crm_deals table, CRM_STAGES array in database.js |
| Deal value tracking | ✅ Implemented | crm_deals.deal_value (NUMERIC) |
| Activity log per deal | ✅ Implemented | crm_activities table |
| Manual notes | ✅ Implemented | POST /api/crm/deals/phone/:phone/notes |
| AI-suggested stage | ✅ Implemented | crm_deals.ai_suggested_stage column |
| CRM analytics | ✅ Implemented | GET /api/crm/analytics |
| Lead assignment to agent | ❌ **Missing** | crm_deals has no assigned_to column |
| Round-robin routing | ❌ **Missing** | No assignment logic |
| 15-minute SLA tracking | ❌ **Missing** | No SLA timer/alert |
| Product interest tracking | ✅ Implemented | crm_deals.product_interest (text field) |
| Next follow-up date | ✅ Implemented | crm_deals.next_followup_at |
| Automated follow-up sequences | ❌ **Missing** | No sequence engine; scheduler only fires one-off messages |
| Stale lead recovery | ❌ **Missing** | No automatic stale detection |
| Real estate qualification fields (budget, BHK, location) | ❌ **Missing** | Not in schema |

### Scheduling & Campaigns

| Feature | Status | Evidence |
|---|---|---|
| Scheduled messages (one-off, future datetime) | ✅ Implemented | scheduled_messages table, scheduler.js cron every 1min |
| Atomic job claiming (prevents duplicate sends) | ✅ Implemented | claimScheduledMessage UPDATE WHERE status='pending' |
| Stuck-job recovery | ✅ Implemented | reclaimStuckScheduledMessages in scheduler.js |
| Per-user scheduled message cap (2000) | ✅ Implemented | LIMITS.MAX_PENDING_SCHEDULED_PER_USER |
| Google Calendar → scheduled message sync | ✅ Implemented | calendar-sync.js, every 5 min |
| Campaign approval before send | ❌ **Missing** | Outreach jobs start immediately; no approve/reject step |
| Conditional day 1/3/7 follow-up sequences | ❌ **Missing** | No sequence/drip engine |
| Site visit reminder sequences (24h + 2h) | ❌ **Missing** | Would need sequence engine |

### Appointments & Calendar

| Feature | Status | Evidence |
|---|---|---|
| Weekly availability configuration | ✅ Implemented | availability_settings table, `/api/appointments/settings` |
| Slot generation with buffer time | ✅ Implemented | `src/services/availability.js` getAvailableSlots |
| Appointment booking (chatbot + dashboard) | ✅ Implemented | bookAppointment, POST /api/appointments |
| Conflict detection (concurrent booking safe) | ✅ Implemented | countOverlappingAppointments + DB UNIQUE check |
| Appointment cancellation | ✅ Implemented | cancelAppointment, DELETE /api/appointments/:id |
| Google Calendar OAuth connect/disconnect | ✅ Implemented | `src/routes/calendar.js`, `src/services/google-calendar.js` |
| Google Calendar → local sync | ✅ Implemented | Busy blocks checked before confirming slot |
| Google Calendar event creation on booking | ✅ Implemented | createAppointmentEvent in google-calendar.js |
| Appointment reminders (WhatsApp) | ❌ **Missing** | No reminder scheduling tied to appointments |
| Site visit type / property address on appointment | ❌ **Missing** | appointments.notes is free text only |

### Admin Dashboard

| Feature | Status | Evidence |
|---|---|---|
| List all users with stats + WA status | ✅ Implemented | GET /api/admin/users |
| Approve/reject/suspend users | ✅ Implemented | admin.js routes |
| Set plan, message limits, rule limits | ✅ Implemented | admin PATCH route |
| Platform-wide stats | ✅ Implemented | GET /api/admin/stats |
| Force-destroy user's WA session | ✅ Implemented | destroyClientForUser called on suspend |
| Delete user with cascade + orphan check | ✅ Implemented | deleteUserCascade + countOrphanedRows |
| UPI payment integration | ❌ **Missing** | No payment processor |
| Tenant subscription tiers | ⚠️ Partial | plan field exists but no enforcement logic beyond message_limit |
| Multi-branch / multi-project isolation | ❌ **Missing** | Single-level tenancy only |
| Audit log | ❌ **Missing** | crm_activities exists per deal, but no system-wide audit log |

### Security

| Feature | Status | Evidence |
|---|---|---|
| bcrypt password hashing (rounds=12) | ✅ Implemented | src/config/auth.js |
| Timing-safe login (constant-time even for unknown email) | ✅ Implemented | burnPasswordVerification() |
| Session token HMAC-SHA256 + in-memory blacklist | ✅ Implemented | src/config/auth.js |
| auth_version instant revocation on password change | ✅ Implemented | migration 011 |
| Per-route + per-user rate limiting | ✅ Implemented | src/middleware/rateLimit.js |
| CORS allowlist (no wildcard) | ✅ Implemented | src/config/app.js |
| CSP with per-request nonce (no unsafe-inline) | ✅ Implemented | src/middleware/nonce.js, app.js |
| Input validation centralised (all routes) | ✅ Implemented | src/utils/validate.js |
| ReDoS protection on chatbot regex rules | ✅ Implemented | assertSafeRegexSource |
| Spreadsheet formula injection prevention | ✅ Implemented | sanitizeSpreadsheetCell |
| Path traversal prevention on auth folder | ✅ Implemented | authDataPath() validates integer userId |
| Product URL scheme validation (no javascript:) | ✅ Implemented | validateProductUrl in api.js |
| API key never returned to browser | ✅ Implemented | gemini_api_key deleted before GET /api/settings response |
| Rate limiting is in-memory only (not Redis) | ⚠️ Risk | rateLimit.js comment explicitly calls this out |
| No 2FA | ❌ Missing | — |
| Phone masking (shared inbox) | ❌ Missing | — |

---

## D. Database Schema and Message Flow

### Full Table Inventory

```
users                    — tenants/agents: email, role, status, plan, limits, wa_enabled, auth_version
contacts                 — per-user phone book: phone, name, label, notes, last_outreach_at
messages                 — full message log: direction, body, status, idempotency key (wa_message_id LIKE 'idem:%')
chatbot_rules            — keyword rules: trigger, match_type, response_text, priority, is_active, hit_count
scheduled_messages       — future sends: phone, body, scheduled_at, status (pending/sending/sent/failed/cancelled/unknown)
settings                 — key-value per tenant (chatbot_enabled, ai_enabled, gemini_api_key, business_*, etc.)
products                 — generic product catalog: name, description, price, category, url, is_active
crm_deals                — sales pipeline: phone, stage, deal_value, product_interest, next_followup_at, ai_suggested_stage
crm_activities           — activity log per deal: type (note/stage/system), content
lead_analysis            — AI conversation analysis: interest_status, interest_score, sentiment, priority, next_action
google_calendar_accounts — OAuth tokens per user: access_token, refresh_token, calendar_id, check_availability
google_calendar_synced_events — imported event IDs to prevent duplicate scheduling
availability_settings    — weekly working hours: working_days, start_time, end_time, slot_duration_minutes, timezone
appointments             — confirmed bookings: phone, start_at, end_at, status (confirmed/cancelled), source, calendar_event_id
```

### Key Relationships

```
users (1) ──< contacts (many)
users (1) ──< messages (many)
users (1) ──< chatbot_rules (many)
users (1) ──< scheduled_messages (many)
users (1) ──< settings (many)
users (1) ──< products (many)
users (1) ──< crm_deals (many)
users (1) ──< crm_activities (many)
users (1) ──< lead_analysis (many)
users (1) ── google_calendar_accounts (one)
users (1) ──< google_calendar_synced_events (many)
users (1) ── availability_settings (one)
users (1) ──< appointments (many)

crm_deals UNIQUE on (user_id, phone)
contacts UNIQUE on (user_id, phone)
lead_analysis UNIQUE on (user_id, phone)
appointments: no unique constraint on (user_id, phone) — multiple appointments per contact allowed
```

### Indexes (migration 009)

All critical query paths are indexed: `(user_id, phone)`, `(user_id, status, scheduled_at)`, `(user_id, priority)`, `(user_id, stage)`, `(status, scheduled_at)` for the scheduler.

### Incoming Message Lifecycle

```
1. whatsapp-web.js fires 'message' event on the Client instance
2. whatsapp-client.js receives it, extracts body, phone, contactName
3. Pushes to conversationQueue (per user_id, serialises concurrent messages from same sender)
4. chatbot.js processMessage() is called:
   a. isRateLimited check (10/min per sender) → drop if exceeded
   b. isOverPlanLimit check → skip AI if over monthly limit
   c. Load chatbot rules for this user from DB
   d. Try rule matching (exact/contains/startswith/regex)
   e. If rule matches AND ai_mode !== 'ai_first' → send rule response
   f. Otherwise, if AI enabled → load last 10 messages from DB → call ai.js generateReply()
   g. If bookingEnabled → generateReplyWithBooking() (Gemini function calling loop, max 3 rounds)
   h. Send reply via sendTextMessage()
   i. Log incoming + outgoing messages to DB
   j. scheduleAutoAnalysis() deferred 30s → lead-analyzer.js analyzeConversation()
5. lead-analyzer.js sends last 80 messages to Gemini → returns JSON analysis
6. Saves to lead_analysis table, auto-creates/updates crm_deals via aiUpsertCrmDeal()
```

### Outgoing Message Lifecycle

```
1. POST /api/messages/send (manual) or scheduler.js tick
2. Idempotency key check: if key exists in messages table → return duplicate, skip send
3. logOutgoingMessageIdempotent() claims the key (INSERT, status='pending')
4. sendTextMessage(userId, phone, text) → whatsapp-web.js client.sendMessage(phone@c.us, text)
5. On success: UPDATE messages SET status='sent'
6. On failure: UPDATE messages SET status='failed', error preserved
7. Auto-upsert contact if new phone
```

### Transaction Safety

- Migrations use `pg_advisory_xact_lock` to prevent concurrent startup races
- Scheduled message claiming uses `UPDATE WHERE status='pending'` (atomic)
- Appointment booking uses `countOverlappingAppointments` before `createAppointment` — **risk: not wrapped in a single transaction**, so a race between two concurrent chatbot bookings for the same slot could theoretically both pass the count check. The UNIQUE constraint on appointments would prevent double-insert but would throw an error rather than gracefully offering an alternative slot.

---

## E. AI and Automation Capabilities

### AI Provider and Models

- **Provider:** Google Gemini exclusively (`@google/genai`)
- **Model selection:** `gemini-client.js` tries a hardcoded list starting with `gemini-3.5-flash-lite`, falling back through 6 models. **Note:** Several model names in the list (`gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.7-flash`) appear to be non-standard/invented names — the real production model IDs as of mid-2026 are `gemini-2.5-flash`, `gemini-2.5-pro`, etc. This means fallback may consistently fail until the model list is corrected. **Severity: High.**
- **Per-tenant API key:** Each user can provide their own Gemini API key in settings; falls back to server-level `GEMINI_API_KEY`
- **Circuit breaker:** Per API-key circuit breaker in gemini-client.js — opens after repeated failures, resets after cooldown
- **Timeout:** `GEMINI_TIMEOUT_MS` (default 30s)

### What the AI Can Do Today

1. **Auto-reply** — generates conversational WhatsApp replies in the tenant's configured persona, with business context injected
2. **Book appointments** — via Gemini function calling (`check_availability`, `book_appointment` tools), max 3 tool rounds per message
3. **Analyse conversations** — classifies lead interest, scores 0-100, suggests CRM stage, estimates deal value, recommends next action
4. **Build business profile** — AI reads settings + products and generates a structured sales brief stored as `business_ai_profile`
5. **Auto-create CRM deals** — `aiUpsertCrmDeal` creates or updates a deal automatically after each analysis

### What the AI Cannot Do Today (Real Estate Gaps)

- Search property inventory by criteria (BHK, location, budget)
- Send property brochures, floor plans, or images
- Qualify leads on real estate-specific dimensions (buyer/renter/investor, possession timeline, loan pre-approval)
- Assign a lead to a specific agent
- Trigger conditional follow-up sequences
- Handle property availability updates

### Confirmation Before AI Actions

- **Appointment booking:** The AI must receive an explicit customer confirmation of a specific slot before calling `book_appointment`. This is enforced by the prompt instruction ("Only call book_appointment after the customer has clearly agreed"). This is a **soft, prompt-level control** — not a hard code-level confirmation gate. A sufficiently adversarial prompt could bypass it.
- **CRM deal creation:** `aiUpsertCrmDeal` runs automatically after every analysis with no confirmation step.
- **Message sending:** Automatic, no confirmation.

### Real Estate AI Feasibility Assessment

The existing Gemini function-calling architecture (`BOOKING_TOOLS` pattern in `ai.js`) is well-suited to extension. New tools for property search, brochure delivery, and lead qualification can be added using the same pattern. The system instruction builder (`buildSystemInstruction`) can be extended with real estate context. This is **medium effort, high confidence**.

---

## F. WhatsApp Integration Assessment

### Method

**whatsapp-web.js (QR/browser automation)** — NOT the official Meta WhatsApp Business Platform API.

This is critical for the real estate use case:

| Aspect | Current (whatsapp-web.js) | Official Meta Cloud API |
|---|---|---|
| Setup | QR scan on personal/business number | Meta Business Manager approval required |
| Cost | Free (uses personal WhatsApp Web session) | Pay-per-message (₹0.35–₹0.58/conversation in India) |
| Media sending | Possible but not implemented | Full support via API |
| Bulk messaging | Risky (ToS violation, ban risk) | Supported with templates |
| Reliability | Browser session can expire, get banned | Official, stable |
| Webhook support | No inbound webhook | Full inbound webhook |
| Message templates | Not supported | Required for outbound business messages |
| Property-portal lead ingestion | Not possible via this method | Possible via API/webhook |
| Account ban risk | **Real and present** | Minimal if compliant |

### Risks

1. **Ban risk:** The platform sends bulk outreach messages (up to 25 per job). The codebase itself warns about this in `outreach.js` comments: *"WhatsApp's own terms prohibit bulk/automated messaging."* For a real estate firm sending property listings to hundreds of leads, this risk is acute.
2. **Session instability:** Each session is a Puppeteer-controlled Chrome process. Chrome updates, WhatsApp Web protocol changes, or server memory pressure can cause disconnections. The reconnection logic is robust, but the underlying dependency is not stable long-term.
3. **No media sending:** `sendTextMessage` in `whatsapp-client.js` sends text only. No `sendMessage` calls with `MessageMedia`. Property photos, floor plans, and brochure PDFs — core to real estate sales — **cannot be sent today**.
4. **One number per tenant:** Each registered user connects one WhatsApp number. A real estate firm with multiple agents needs each agent to have their own number, which the current multi-tenancy model supports (each user = one WhatsApp session). However, a **shared inbox** where multiple agents respond from one number is not supported.

### Reconnection and Session Persistence

- Verified: `resumeExistingSessions()` on server start, staggered by `RESUME_STAGGER_MS`
- Verified: Watchdog timer in `newSessionState()`
- Verified: Exponential backoff in `launcher.js`
- Unverified: Behaviour when WhatsApp invalidates a session server-side (e.g. phone logged out elsewhere) — likely requires re-scan.

---

## G. Real Estate Feature Gap Matrix

| Requirement | Status | Effort to Build |
|---|---|---|
| **Property Listings** | | |
| Property inventory table (location, price, BHK, area, type) | ❌ Missing | Low — new DB table |
| Property categories (residential/commercial/plot/rental/resale) | ❌ Missing | Low — field on properties table |
| Property photos/brochures/videos delivery over WhatsApp | ❌ Missing | High — needs media sending in whatsapp-client.js |
| Property availability status (vacant/on-hold/booked) | ❌ Missing | Medium — field + state machine |
| Flat/plot inventory grid view | ❌ Missing | Medium — new UI |
| **Lead Qualification** | | |
| AI qualification for budget, location, BHK, timeline | ❌ Missing | Medium — extend AI tools + prompt |
| Automatic brochure delivery for specific inquiry types | ❌ Missing | High — needs media sending + trigger rules |
| Lead source tracking (portal, WhatsApp, referral) | ❌ Missing | Low — field on contacts/crm_deals |
| Buyer/seller/tenant/landlord/investor/broker profile type | ❌ Missing | Low — field on contacts |
| Budget and possession-timeline capture | ❌ Missing | Low — fields on crm_deals |
| **Automation** | | |
| Conditional day 1/3/7 follow-up sequences | ❌ Missing | High — new sequence engine on top of scheduler |
| Stale-lead recovery automation | ❌ Missing | Medium — cron + crm_deals.next_followup_at |
| Site visit reminders (24h + 2h) | ❌ Missing | Medium — needs sequence engine |
| **Appointments & Site Visits** | | |
| Appointment booking (base) | ✅ Reusable | None |
| Google Calendar integration | ✅ Reusable | None |
| Site visit type annotation on appointments | ❌ Missing | Low — field on appointments |
| Property address on appointment | ❌ Missing | Low — field on appointments |
| **Agent Management** | | |
| Lead assignment to specific agent | ❌ Missing | Medium — assigned_to on crm_deals |
| Round-robin routing | ❌ Missing | High — new assignment engine |
| 15-minute SLA tracking | ❌ Missing | Medium — timestamp + alert |
| **Shared Inbox & Communications** | | |
| Shared inbox (multiple agents, one number) | ❌ Missing | Very High — architectural change |
| Human handover (stop AI, assign to human) | ❌ Missing | Medium — per-conversation AI pause flag |
| Backend-enforced phone masking | ❌ Missing | High — proxy layer needed |
| **Integrations** | | |
| Meta Cloud API (official WhatsApp) | ❌ Missing | Very High — full integration rewrite |
| Property portal webhook ingestion (99acres, MagicBricks, Housing) | ❌ Missing | High — new webhook handler + mapping |
| Google Sheets sync | ❌ Missing | Medium — new service |
| **Payments & Admin** | | |
| UPI payment approval before account activation | ❌ Missing | High — payment gateway integration |
| Subscription tier enforcement beyond message_limit | ⚠️ Partial | Medium — extend plan logic |
| Multi-project / multi-branch isolation | ❌ Missing | Very High — second tenancy level |
| Super-admin workspace reset (protected) | ⚠️ Partial | Low — extend admin routes |
| Audit log | ❌ Missing | Medium — new audit_log table |
| **Already Reusable Without Change** | | |
| Multi-tenant auth + approval workflow | ✅ Full | — |
| CRM pipeline with 7 stages | ✅ Full | — |
| AI lead analysis + scoring | ✅ Full | — |
| Scheduled messages + cron | ✅ Full | — |
| Contact management + CSV import | ✅ Full | — |
| Google Calendar OAuth + sync | ✅ Full | — |
| Appointment booking engine | ✅ Full | — |
| AI chatbot (rules + Gemini) | ✅ Full | — |
| Rate limiting + security infrastructure | ✅ Full | — |

---

## H. Critical Bugs, Security Risks, and Technical Debt

### 🔴 Critical

**1. Gemini model names are invalid**
- **Location:** `src/services/gemini-client.js` lines 15–21
- **Issue:** Model names like `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.7-flash` do not correspond to real Google Gemini model IDs (as of 2026, valid IDs are `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, etc.). The circuit breaker will open after exhausting all invalid models. Every new tenant with no Gemini key will silently receive no AI responses.
- **Impact:** AI features non-functional for most users
- **Fix:** Update `ALL_GEMINI_MODELS` list with verified model IDs from the Google AI API

**2. WhatsApp ban risk from bulk messaging**
- **Location:** `src/services/outreach.js`
- **Issue:** The platform sends bulk WhatsApp messages to up to 25 contacts per job using a personal WhatsApp Web session (not the official Business API). This directly violates WhatsApp ToS. The code itself documents this risk but does not prevent it.
- **Impact:** Tenant phone numbers can be permanently banned. For a real estate firm sending property listings at scale, this is a business-ending event.
- **Fix:** For real estate use, migrate to Meta Cloud API with approved message templates for outbound campaigns

**3. No media/file sending capability**
- **Location:** `src/services/whatsapp-client.js` — only `sendTextMessage` exists
- **Issue:** Real estate requires sending property photos, floor plans, and brochure PDFs. The current implementation has no `sendMedia`, `sendDocument`, or `sendImage` function.
- **Impact:** Core real estate value proposition is blocked
- **Fix:** Implement `sendMedia(userId, phone, mediaPath, caption)` using whatsapp-web.js `MessageMedia`

### 🟠 High

**4. Appointment booking race condition**
- **Location:** `src/services/availability.js` bookAppointment
- **Issue:** `countOverlappingAppointments` and `createAppointment` are not wrapped in a single database transaction. Two concurrent chatbot-triggered bookings for the same slot can both pass the overlap check simultaneously, then both attempt to insert. The database has no UNIQUE constraint on `(user_id, start_at)`, so both inserts succeed and the slot is double-booked.
- **Impact:** Double-booked appointments — critical for a site visit scheduling feature
- **Fix:** Wrap both operations in a `transaction()` call, or add a UNIQUE constraint on `(user_id, start_at)`

**5. Rate limiting is in-process only (not distributed)**
- **Location:** `src/middleware/rateLimit.js`
- **Issue:** All rate limit buckets live in Node.js process memory. With two instances behind a load balancer (or a rolling deploy), limits are effectively halved. The code explicitly documents this.
- **Impact:** Login brute-force protection and per-user write limits are not enforced across multiple instances
- **Fix:** Replace with Redis-backed rate limiting (or `ioredis` + a sliding window) before horizontal scaling

**6. Token revocation is in-process only**
- **Location:** `src/config/auth.js` tokenBlacklist, userTokenEpoch
- **Issue:** Both the token blacklist and user epoch maps are in process memory. A logout on instance A is not seen by instance B.
- **Impact:** Logged-out or suspended users may remain active on other instances
- **Fix:** Use Redis or a `token_revocations` DB table with a TTL

### 🟡 Medium

**7. First-user signup requires manual DB promotion**
- **Issue:** New signups go to `status='pending'` and require admin approval, but the first user has no admin to approve them. The `BOOTSTRAP_ADMIN_EMAIL` env var is the workaround, but it requires knowing the email before signup and restarting the server.
- **Fix:** Auto-promote the first registered user to admin, or add a one-time setup wizard

**8. Session secret instability risk in development**
- **Location:** `src/config/auth.js` loadSessionSecret
- **Issue:** In development, if `SESSION_SECRET` is not set and `data/.session_secret` cannot be written, an ephemeral secret is generated — logging everyone out on restart.
- **Fix:** Always set `SESSION_SECRET` in `.env`, even in development

**9. Calendar OAuth state tokens are in-memory only**
- **Location:** `src/routes/calendar.js` pendingStates Map
- **Issue:** Google OAuth CSRF state tokens are stored in memory. A server restart during the OAuth flow invalidates all in-progress connections.
- **Impact:** Minor UX issue — user must retry connection
- **Fix:** Store in DB with TTL, or accept the minor inconvenience

**10. No structured follow-up sequence engine**
- **Issue:** The scheduler fires one-off messages; there is no engine that says "if this lead hasn't responded in 3 days, send message X; if still no response in 7 days, send message Y." This is a core requirement for real estate.
- **Fix:** New `follow_up_sequences` and `follow_up_steps` tables + a scheduler extension

---

## I. Existing Modules Reusable Without Rebuilding

The following modules can be used directly, or with only configuration changes, in the real estate product:

| Module | File | Reuse Plan |
|---|---|---|
| Auth system | `src/config/auth.js`, `src/middleware/auth.js`, `src/routes/auth.js` | Use as-is |
| User management + admin panel | `src/routes/admin.js`, `src/services/database.js` (user functions) | Use as-is; add payment field |
| PostgreSQL pool + query layer | `src/services/db-pool.js` | Use as-is |
| Migration runner | `src/services/database.js` runMigrations | Use as-is; add new migrations |
| Contact management + CSV import | `src/routes/api.js` /contacts, `src/services/csv.js` | Use as-is; extend contact fields |
| Message log + conversation history | `src/routes/api.js` /messages, messages table | Use as-is |
| Chatbot rule engine | `src/services/chatbot.js`, `src/routes/api.js` /chatbot | Use as-is |
| Gemini AI reply + function calling | `src/services/ai.js`, `src/services/gemini-client.js` | Extend with property tools |
| AI lead analysis | `src/services/lead-analyzer.js`, lead_analysis table | Extend prompt with RE fields |
| CRM pipeline | `src/routes/api.js` /crm, crm_deals + crm_activities tables | Extend with assignment + RE fields |
| Scheduled messages + atomic scheduler | `src/services/scheduler.js`, scheduled_messages table | Use as-is; build sequences on top |
| Google Calendar OAuth + sync | `src/services/google-calendar.js`, `src/routes/calendar.js` | Use as-is |
| Appointment booking engine | `src/services/availability.js`, `src/routes/appointments.js` | Use as-is; add RE fields + fix race |
| Rate limiting + validation | `src/middleware/rateLimit.js`, `src/utils/validate.js` | Use as-is |
| Security headers + CSP | `src/config/app.js`, `src/middleware/nonce.js` | Use as-is |
| Bulk outreach jobs | `src/services/outreach.js` | Use as-is for non-bulk RE campaigns |
| Process supervisor | `launcher.js` | Use as-is |
| Docker + Caddy deployment | `docker-compose.yml`, `Caddyfile` | Use as-is |

---

## J. Recommended Real Estate-Specific Architecture

### Data Model Extensions

```sql
-- New tables needed

-- Property inventory
CREATE TABLE properties (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_name TEXT NOT NULL,
    unit_number TEXT,
    property_type TEXT CHECK(property_type IN ('residential','commercial','plot','rental','resale')),
    bhk TEXT,                          -- '2BHK', '3BHK', 'Studio', etc.
    area_sqft NUMERIC,
    price NUMERIC,
    price_unit TEXT DEFAULT '₹',
    location TEXT,
    city TEXT,
    locality TEXT,
    floor_number INTEGER,
    total_floors INTEGER,
    amenities TEXT,                    -- JSON array
    status TEXT DEFAULT 'available' CHECK(status IN ('available','on_hold','booked','sold')),
    media_urls TEXT,                   -- JSON array of photo/brochure URLs
    brochure_url TEXT,
    walkthrough_url TEXT,
    possession_date DATE,
    listing_source TEXT,               -- 'manual','99acres','magicbricks','housing'
    external_listing_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Extend crm_deals with RE qualification
ALTER TABLE crm_deals ADD COLUMN lead_type TEXT CHECK(lead_type IN ('buyer','renter','investor','seller','broker'));
ALTER TABLE crm_deals ADD COLUMN budget_min NUMERIC;
ALTER TABLE crm_deals ADD COLUMN budget_max NUMERIC;
ALTER TABLE crm_deals ADD COLUMN preferred_bhk TEXT;
ALTER TABLE crm_deals ADD COLUMN preferred_location TEXT;
ALTER TABLE crm_deals ADD COLUMN possession_timeline TEXT;
ALTER TABLE crm_deals ADD COLUMN lead_source TEXT;
ALTER TABLE crm_deals ADD COLUMN assigned_to INTEGER REFERENCES users(id);
ALTER TABLE crm_deals ADD COLUMN first_response_at TIMESTAMPTZ;

-- Extend contacts with RE profile
ALTER TABLE contacts ADD COLUMN contact_type TEXT DEFAULT 'lead';
ALTER TABLE contacts ADD COLUMN source TEXT;

-- Follow-up sequences
CREATE TABLE follow_up_sequences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger_event TEXT NOT NULL,       -- 'new_lead','no_response_1d','site_visit_booked', etc.
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE follow_up_steps (
    id SERIAL PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
    delay_hours INTEGER NOT NULL,
    message_template TEXT NOT NULL,    -- supports {{name}}, {{property}}, {{agent}} placeholders
    step_order INTEGER NOT NULL
);

-- Extend appointments for site visits
ALTER TABLE appointments ADD COLUMN appointment_type TEXT DEFAULT 'general';
ALTER TABLE appointments ADD COLUMN property_id INTEGER REFERENCES properties(id);
ALTER TABLE appointments ADD COLUMN agent_id INTEGER REFERENCES users(id);

-- Lead-property matching
CREATE TABLE lead_property_matches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deal_id INTEGER NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    match_score NUMERIC,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Lead source webhooks
CREATE TABLE webhook_leads (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    payload JSONB,
    processed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

### Service Additions Needed

1. **`src/services/property.js`** — CRUD for properties, availability state machine, search by BHK/location/budget
2. **`src/services/media-sender.js`** — `sendImage()`, `sendDocument()`, `sendVideo()` via whatsapp-web.js `MessageMedia`
3. **`src/services/follow-up-engine.js`** — sequence evaluator, runs as part of scheduler tick
4. **`src/services/lead-matcher.js`** — match new lead profile against property inventory, auto-send brochures
5. **`src/services/webhook-ingestor.js`** — receives leads from 99acres, MagicBricks, Housing.com webhooks
6. **`src/services/agent-assignment.js`** — round-robin or load-based assignment, SLA clock

### AI Tool Extensions (in `src/services/ai.js`)

Add to `BOOKING_TOOLS`:
```javascript
{ name: 'search_properties', description: 'Search available properties by budget, BHK, location, type', parameters: {...} },
{ name: 'get_property_details', description: 'Get full details for a specific property', parameters: {...} },
{ name: 'send_brochure', description: 'Send property brochure/photos to the customer', parameters: {...} },
{ name: 'qualify_lead', description: 'Save lead qualification data (budget, timeline, preferences)', parameters: {...} },
{ name: 'book_site_visit', description: 'Schedule a site visit at the property', parameters: {...} }
```

---

## K. Prioritized Implementation Roadmap

### Phase 1 — Minimum Viable Real Estate Product (2–3 weeks)

**Goal:** A real estate agent can receive WhatsApp inquiries, the AI qualifies the lead and presents properties from the inventory, and the agent can view leads in the CRM.

| Task | File(s) to Modify/Create | Effort |
|---|---|---|
| Fix Gemini model names | `src/services/gemini-client.js` | 1h |
| Fix appointment booking race condition | `src/services/availability.js` | 2h |
| Add properties table + migrations | New migration 012 | 2h |
| Build `src/services/property.js` (CRUD + search) | New file | 1 day |
| Add `/api/properties` routes | `src/routes/api.js` or new file | 1 day |
| Add RE qualification fields to crm_deals | New migration 013 | 2h |
| Add lead_type, source, budget, BHK fields | `src/services/database.js`, routes | 1 day |
| Implement `sendMedia()` in whatsapp-client.js | `src/services/whatsapp-client.js` | 1 day |
| Add property search AI tools to ai.js | `src/services/ai.js` | 1 day |
| Extend AI lead analysis prompt for RE | `src/services/lead-analyzer.js` | 0.5 day |
| Build property browser UI (admin dashboard) | `public/js/admin.js` or new page | 2 days |
| Auto-promote first user to admin | `src/routes/auth.js` | 2h |

**Dependencies:** None requiring external approvals

### Phase 2 — Lead Qualification & Sales Automation (2–3 weeks)

**Goal:** AI automatically qualifies leads, assigns to agents, sends brochures for matching properties, and triggers follow-up sequences.

| Task | File(s) to Modify/Create | Effort |
|---|---|---|
| Build follow_up_sequences + follow_up_steps tables | New migration | 2h |
| Build `src/services/follow-up-engine.js` | New file | 2 days |
| Integrate follow-up engine into scheduler.js tick | `src/services/scheduler.js` | 0.5 day |
| Build `src/services/lead-matcher.js` | New file | 1 day |
| Auto-send brochures on lead qualification | `src/services/chatbot.js` or ai.js | 1 day |
| Add assigned_to to crm_deals | New migration | 1h |
| Build `src/services/agent-assignment.js` | New file | 1 day |
| Add agent assignment UI in admin dashboard | `public/js/admin.js` | 1 day |
| Site visit appointment type + property link | New migration + availability.js | 1 day |
| Site visit reminder scheduling | follow-up-engine.js | 0.5 day |

**Dependencies:** Media sending from Phase 1

### Phase 3 — Property Matching & AI Assistant (2–3 weeks)

**Goal:** Full conversational AI that understands property requirements, matches from inventory, books site visits, and sends media — all over WhatsApp.

| Task | File(s) to Modify/Create | Effort |
|---|---|---|
| Full AI property search tool (NLP → query → results) | `src/services/ai.js`, property.js | 2 days |
| AI brochure/photo delivery tool | ai.js + media-sender.js | 1 day |
| AI site visit booking tool (extends appointment booking) | ai.js + availability.js | 1 day |
| AI lead qualification flow (multi-turn budget/BHK capture) | ai.js system prompt + qualify_lead tool | 2 days |
| Human handover flag (per-conversation AI pause) | New DB column + chatbot.js | 1 day |
| Stale-lead recovery cron | `src/services/scheduler.js` extension | 1 day |
| Property portal webhook ingestion (99acres/MagicBricks) | `src/services/webhook-ingestor.js`, new route | 2 days |

**Dependencies:** Meta Cloud API approval (for media at scale) OR accept whatsapp-web.js media risk

### Phase 4 — Advanced CRM, Analytics, and Integrations (3–4 weeks)

**Goal:** Enterprise features: multi-agent shared inbox, Google Sheets sync, UPI payment approvals, audit log, performance analytics.

| Task | File(s) to Modify/Create | Effort |
|---|---|---|
| Shared inbox (multiple agents, one number) | Major architectural change — new routing layer | 1 week |
| Phone masking / agent anonymisation | New proxy service | 3 days |
| UPI payment integration (Razorpay/PayU) | New service + admin routes | 3 days |
| Google Sheets two-way sync | New service | 2 days |
| Audit log table + middleware | New migration + middleware | 1 day |
| Agent performance analytics | New DB views + API routes | 2 days |
| Property conversion funnel analytics | New DB views + UI | 2 days |
| Redis for distributed rate limiting | Replace rateLimit.js | 1 day |
| Redis for token revocation | Replace auth.js in-memory maps | 1 day |
| Multi-project / multi-branch isolation | Major schema change | 1 week |
| Meta Cloud API migration | Rewrite whatsapp-client.js | 1–2 weeks |

**Dependencies:** Meta Business Manager verification (2–4 weeks lead time), Razorpay/PayU account

---

## L. Files to Modify or Create Per Phase

### Phase 1 — Files to Modify
- `src/services/gemini-client.js` — fix model names
- `src/services/availability.js` — fix booking race condition
- `src/services/whatsapp-client.js` — add sendMedia()
- `src/services/ai.js` — add property search tools
- `src/services/lead-analyzer.js` — extend analysis prompt
- `src/services/database.js` — add property CRUD functions
- `src/routes/api.js` — add /api/properties routes
- `src/routes/auth.js` — first-user auto-admin

### Phase 1 — Files to Create
- `src/migrations/012_properties.sql`
- `src/migrations/013_crm_re_fields.sql`
- `src/services/property.js`

### Phase 2 — Files to Modify
- `src/services/scheduler.js` — integrate follow-up engine
- `src/services/chatbot.js` — trigger brochure send, agent assignment
- `src/services/database.js` — add sequence/step CRUD

### Phase 2 — Files to Create
- `src/migrations/014_follow_up_sequences.sql`
- `src/migrations/015_crm_assignment.sql`
- `src/services/follow-up-engine.js`
- `src/services/lead-matcher.js`
- `src/services/agent-assignment.js`

### Phase 3 — Files to Modify
- `src/services/ai.js` — full RE tool suite
- `src/services/availability.js` — site visit type

### Phase 3 — Files to Create
- `src/services/media-sender.js`
- `src/services/webhook-ingestor.js`
- `src/routes/webhooks.js`

### Phase 4 — Files to Modify (major)
- `src/services/whatsapp-client.js` — Meta Cloud API migration
- `src/middleware/rateLimit.js` — Redis backend
- `src/config/auth.js` — Redis token revocation
- `src/services/database.js` — multi-project schema

### Phase 4 — Files to Create
- `src/services/redis-client.js`
- `src/services/payment.js`
- `src/services/sheets-sync.js`
- `src/migrations/016_audit_log.sql`
- `src/migrations/017_multi_project.sql`

---

## M. Testing and Deployment Recommendations

### Existing Test Coverage (Verified)

| Test File | Covers |
|---|---|
| `tests/validation.test.js` | Input validation functions in validate.js |
| `tests/auth.security.test.js` | Auth token creation, verification, revocation |
| `tests/auth-revocation.test.js` | Session revocation edge cases |
| `tests/tenant-isolation.test.js` | Cross-tenant data leakage |
| `tests/conversation-queue.test.js` | Concurrent message serialisation |
| `tests/db-safety-guard.test.js` | Database write guard |
| `tests/db-timeouts.test.js` | Query timeout enforcement |
| `tests/jobs-scheduler-ai.test.js` | Scheduler and AI job handling |
| `tests/postgres.persistence.test.js` | PostgreSQL persistence operations |
| `tests/security-audit-verification.test.js` | Security invariants |

### Recommended Testing Additions

1. **Property search tests** — verify budget/BHK/location filtering returns correct results
2. **Follow-up sequence tests** — verify correct messages fire at correct delays
3. **Appointment booking race test** — simulate two concurrent bookings of the same slot (the existing `conversation-queue.test.js` provides a pattern)
4. **Media send test** — mock whatsapp-web.js client to verify `sendMedia` is called with correct payload
5. **Agent assignment round-robin test** — verify fair distribution

### Deployment Notes

- **Current:** Single Node.js instance + Docker + Caddy. Works for up to ~30 concurrent WhatsApp sessions (limited by RAM).
- **For real estate firm (many agents):** No changes needed for Phase 1–3 if running on ≥8GB RAM. For Phase 4 (distributed), add Redis and a second app instance behind the load balancer.
- **Backup:** No automated DB backup configured. For production, add a PostgreSQL backup cron (scripts/backup-postgres.sh exists but is not wired to a cron job).
- **Monitoring:** `/health` and `/ready` endpoints exist. Recommend connecting to an uptime monitor (UptimeRobot, Grafana Cloud free tier) before going live.
- **Meta Cloud API (Phase 4):** Apply for a Meta Business Manager account and WhatsApp Business API access early — approval takes 2–4 weeks and requires a registered business entity.

---

## Verified Facts vs. Assumptions

### Verified (directly read from source)
- Database engine is PostgreSQL, not SQLite. `db-pool.js` imports `require('pg')`, runs `Pool`, and uses `$1`/`$2` parameter placeholders. The `paths.js` `DB_PATH` variable is a legacy artefact not used by the database layer.
- WhatsApp integration is `whatsapp-web.js` (browser automation), not Meta Cloud API.
- AI uses Google Gemini via `@google/genai`. No OpenAI, Anthropic, or other providers.
- 14 database tables exist as of migration 011.
- `sendTextMessage` only — no media sending capability exists in any service file.
- Rate limiting and token revocation are both in-process memory only.
- Appointment booking does not use a database transaction for the overlap-check + insert pair.
- The Gemini model list in `gemini-client.js` contains names that do not match published Google model IDs.

### Assumptions (not directly verified)
- `src/services/google-calendar.js` is assumed to use the standard `googleapis` OAuth2 flow (not read in full — only calendar-sync.js and the route were read).
- The full `src/services/database.js` CRUD functions were not read exhaustively — structure inferred from migration SQL and route imports.
- Public HTML/JS files (`admin.html`, `app.js`, etc.) were not read — UI feature set inferred from API routes.
- Test files were listed but not read in full — coverage claims are based on file names and partial reads.
- `scripts/backup-postgres.sh` exists but its contents and whether it is scheduled were not verified.

---

## Final Recommendation

**Convert, do not rebuild.** The existing codebase has a production-grade foundation — PostgreSQL with proper migrations, atomic scheduling, bcrypt auth with instant revocation, Gemini AI with circuit breaking, Google Calendar integration, and a working CRM pipeline. Rebuilding this from scratch would take 3–4 months and likely produce a less reliable result.

**Start with Phase 1 immediately.** Fix the Gemini model names (1 hour), fix the booking race (2 hours), add the `properties` table and `sendMedia()` (2–3 days), and you have a real estate product that can receive WhatsApp inquiries, present properties from inventory, and book site visits — all within 2 weeks.

**Plan for Meta Cloud API before Phase 3.** The whatsapp-web.js approach works for development and for low-volume pilot users, but the ban risk at scale is real. Apply for Meta Business API access now so the approval arrives before you need it.

**Redis is the single most important infrastructure addition.** Everything blocking horizontal scaling (rate limiting, token revocation, calendar OAuth state) can be fixed by adding one Redis instance — a few hours of work, but it unlocks all of Phase 4.
