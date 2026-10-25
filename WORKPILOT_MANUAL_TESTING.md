# Workpilot — Manual Feature Verification Checklist

This document contains the complete list of all features currently implemented in the Workpilot (WhatsApp Business Automation & Real Estate CRM) codebase. Use this checklist to verify the system manually, feature by feature.

---

## 📌 Status Legend

| Status | Meaning |
| :--- | :--- |
| **`[ ] NOT TESTED`** | Default initial state; feature has not yet been manually verified. |
| **`[PASS]`** | Feature verified working as expected in the live application. |
| **`[FAIL]`** | Feature encountered an error, unexpected behavior, or broken UI/API. |
| **`[BLOCKED]`** | Testing cannot proceed due to missing external credentials or upstream dependency. |
| **`[N/A]`** | Not applicable to current deployment environment or testing scenario. |

---

## Round 1: Login, Authentication and Sessions

- [ ] **Public Signup Form (`/signup`)**: Register a new tenant account with business name, owner name, email address, and password.
- [ ] **Password Length Constraints**: Validation rejects passwords shorter than 8 characters or longer than 72 characters.
- [ ] **Email Format & Normalization**: Emails are sanitized, trimmed, converted to lowercase, and verified against standard RFC syntax.
- [ ] **Pending Approval Workflow**: Newly registered accounts are assigned `status: pending` and blocked from automatic login until an admin approves them.
- [ ] **Duplicate Email Detection**: Attempting to register an existing email returns an explicit `HTTP 409 Conflict` error without throwing a 500 error.
- [ ] **Standard Login (`/login`)**: Authenticate an active tenant account with valid email and password.
- [ ] **Timing-Attack Countermeasure**: Invalid email addresses trigger a dummy password hash computation (`burnPasswordVerification`) to prevent account enumeration via timing discrepancies.
- [ ] **Pending Account Login Gate**: Login attempt by a user with `pending` status is rejected with `HTTP 403` (`ACCOUNT_PENDING`).
- [ ] **Rejected Account Login Gate**: Login attempt by a user with `rejected` status is rejected with `HTTP 403` (`ACCOUNT_REJECTED`).
- [ ] **Suspended Account Login Gate**: Login attempt by a user with `suspended` status is rejected with `HTTP 403` (`ACCOUNT_SUSPENDED`).
- [ ] **Dual-Token Session Handling**: Login issues an `HttpOnly` refresh cookie and returns a short-lived JSON access token.
- [ ] **Session Token Rotation (`POST /api/auth/refresh`)**: Frontend transparently requests a new access token when expired using the refresh cookie.
- [ ] **Current User Profile (`GET /api/auth/me`)**: Retrieves authenticated user details without exposing password hashes or internal secrets.
- [ ] **Password Change (`POST /api/auth/change-password`)**: Validates current password, updates to new password, and rejects identical current/new passwords.
- [ ] **Stolen Session Eviction on Password Change**: Changing password immediately revokes all other active sessions and cookies across devices.
- [ ] **Global Session Invalidation (`POST /api/auth/revoke-all-sessions`)**: Increments tenant `auth_version` and invalidates all existing JWTs and refresh tokens.
- [ ] **Logout (`POST /api/auth/logout`)**: Clears the session cookie, revokes active tokens in memory, and redirects to `/login`.
- [ ] **Brute-Force Rate Limiting**: Maximum 8 attempts per account and 40 per IP within 15 minutes on login, and 10 signups per hour per IP.

---

## Round 2: User Management, Roles and Tenant Isolation

- [ ] **Admin Portal Route Protection (`/admin`)**: Access is restricted strictly to accounts with `role: admin`; regular users are redirected to `/app`.
- [ ] **Platform Statistics Overview (`GET /api/admin/stats`)**: Displays system-wide counts of total tenants, active accounts, messages sent, and storage health.
- [ ] **System Diagnostics Dashboard (`GET /api/admin/diagnostics`)**: Displays live process metrics, active WhatsApp Chromium instances, failed media sends, outreach job counts, and calendar sync states.
- [ ] **Tenant Accounts List (`GET /api/admin/users`)**: Lists all registered tenant accounts with plan, role, status, message count, and WhatsApp status.
- [ ] **Single Tenant Account Details (`GET /api/admin/users/:id`)**: Fetches full account metadata, resource usage statistics, and connection state.
- [ ] **Tenant Account Approval (`POST /api/admin/users/:id/approve`)**: Elevates a `pending` account to `active`, permitting immediate login.
- [ ] **Tenant Account Rejection (`POST /api/admin/users/:id/reject`)**: Marks an account as `rejected`, revokes any active tokens, and kills live WhatsApp sessions.
- [ ] **Account Suspension**: Changing tenant status to `suspended` immediately tears down their running WhatsApp Chromium client and SSE connections.
- [ ] **Plan & Quota Administration**: Admin updates tenant plan name and custom monthly limits (`message_limit`, `rule_limit`).
- [ ] **Role Management**: Admin changes a user role between `user` and `admin`; existing sessions for that user are revoked immediately.
- [ ] **Self-Demotion Safeguard**: An active admin cannot demote, suspend, reject, or deactivate their own currently logged-in account.
- [ ] **WhatsApp Access Toggle (`wa_enabled`)**: Setting `wa_enabled = 0` revokes WhatsApp access and halts active WhatsApp Web instances for that tenant.
- [ ] **Tenant Account Cascade Deletion (`DELETE /api/admin/users/:id`)**: Terminates WhatsApp processes and deletes the user along with all associated records across all tables.
- [ ] **Orphan Row Verification**: Deletion verifies zero orphaned records remain across tenant tables (contacts, messages, rules, scheduled, deals, inventory).
- [ ] **Strict Tenant Isolation**: Validates that all database queries are strictly scoped to `user_id` / `tenant_id` — no cross-tenant data leakage.

---

## Round 3: Dashboard, Navigation and UI

- [ ] **Responsive Sidebar Navigation**: Clean navigation between Dashboard, Messages, Leads, CRM, Chatbot, Contacts, Campaigns, Scheduled, Appointments, Properties, and Settings.
- [ ] **Mobile Hamburger Menu**: Hamburger button expands/collapses sliding mobile navigation drawer with backdrop overlay.
- [ ] **Environment Mode Indicator**: Sidebar logo area displays current mode badge (`Demo Mode` vs `Production Mode`).
- [ ] **Real-Time Connection Status Pill**: Sidebar footer status dot and label dynamically reflect WhatsApp status (`Connected`, `Disconnected`, `Connecting...`).
- [ ] **Live SSE Stream Connection (`/api/qr-stream`)**: Status updates push automatically via Server-Sent Events without requiring page refreshes.
- [ ] **Desktop Top Bar Global Search**: Search input (`#globalSearch`) filters messages, contacts, and deals in real-time.
- [ ] **Top Bar Refresh Button (`#refreshBtn`)**: Triggers an instant reload of the currently active section's dataset.
- [ ] **User Profile & Avatar**: Displays current logged-in user name and avatar initial in top bar.
- [ ] **Top Bar Logout Button (`#logoutBtn`)**: One-click sign out returning to the login page.
- [ ] **Message Metric Cards**: Displays live counts for "Sent Today", "Received Today", "Total Messages", and "Scheduled Pending" with quick navigation links.
- [ ] **Lead Scoring Summary**: Dashboard card displays Hot, Warm, and Cold lead counts with direct links to the Lead Analysis view.
- [ ] **Awaiting Analysis Badge**: Accurately counts conversations with new inbound messages that haven't yet been analyzed by AI.
- [ ] **Sales Pipeline Card**: Shows total active deals count and aggregated pipeline valuation formatted with the tenant's currency symbol (`₹`).
- [ ] **WhatsApp & AI Readiness Badges**: Shows active WhatsApp connection indicator and whether a valid Gemini API key is configured.
- [ ] **Monthly Quota Progress Bar**: Displays monthly outgoing WhatsApp messages count against the account's plan limit.
- [ ] **Global Error & Notification Banners**: Displays dismissal error banners and success toast alerts across operations.

---

## Round 4: CRM Leads and Contact Management

- [ ] **Contacts Table View**: Displays paginated contact list with name, normalized phone number, labels, opt-out status, and creation date.
- [ ] **Contact Search & Filter**: Real-time filtering by contact name, phone number, and specific label tags.
- [ ] **Contact Creation**: Add a new contact with name, phone number, email, custom labels, and notes.
- [ ] **Contact Editing & Deletion**: Update contact information (`PUT /api/contacts/:id`) or remove contact (`DELETE /api/contacts/:id`).
- [ ] **Label & Tagging System**: Manage custom contact tags (`/api/contacts/labels`) for audience segmentation (e.g., Buyer, VIP, Investor).
- [ ] **CSV Contact Import (`POST /api/contacts/import`)**: Upload CSV file with interactive column mapping for Name, Phone, Email, and Labels.
- [ ] **CSV Import Safety Bounds**: Enforces 5,000-row limit, 2MB payload ceiling, and formula injection sanitization (stripping `=`, `+`, `-`, `@`).
- [ ] **Contacts CSV Export (`GET /api/contacts/export`)**: Downloads sanitized spreadsheet CSV of all contacts.
- [ ] **Multi-Select Bulk Selection**: Quick-select all, select visible, and clear selection buttons for launching bulk outreach campaigns.
- [ ] **Manual Contact Opt-Out Toggle**: Toggle contact opt-out status (`POST /api/contacts/:id/opt-out`) with audit reason.
- [ ] **Phone Number PII Masking**: Validates that non-manager users see partially masked phone numbers (`***-***-1234`) while managers see full numbers.
- [ ] **CRM Pipeline View**: Visual pipeline / table across 7 stages (`new_lead`, `contacted`, `qualified`, `viewing_scheduled`, `negotiation`, `won`, `lost`).
- [ ] **Deal Creation Modal**: Create a deal linking an existing contact, assigned property project, deal valuation, and expected close date.
- [ ] **Real Estate Qualification Attributes**: Track deal preferences: budget range, BHK preference, property type, location, possession timeline, and loan requirement.
- [ ] **Stage Advancement**: Move deals between stages with automatic activity timeline logging.
- [ ] **Deal Notes & Activity History (`/api/crm/deals/phone/:phone/notes`)**: View and add timestamped notes, call logs, and interaction records.
- [ ] **Pause AI from Deal Modal**: Toggle automated bot pause (`POST /api/crm/deals/:id/pause-ai`) directly from the deal view during negotiations.
- [ ] **CRM Analytics Modal (`GET /api/crm/analytics`)**: View conversion rates across stages, average deal sizes, and pipeline velocity.
- [ ] **Deals CSV Export (`GET /api/crm/deals/export`)**: Download exportable CSV of all pipeline deals.

---

## Round 5: Lead Assignment, Multi-Agent Routing and SLA

- [ ] **Multi-Agent Workspace Roster (`GET /api/crm/agents`)**: View list of all agents within the tenant workspace.
- [ ] **Agent Profile Creation (`POST /api/crm/agents`)**: Add agent with name, email, phone, role (`agent`, `manager`, `admin`), max active leads, and routing weight.
- [ ] **Agent Routing Status Toggle**: Update agent status between `available`, `busy` (paused), and `offline`.
- [ ] **Lead Routing Algorithms**: Configure tenant routing mode in Settings: `round-robin`, `workload` (least-busy), or `manual`.
- [ ] **Workload Capacity Ceiling**: Lead assignment engine respects `max_active_leads` and does not assign new leads to capped agents.
- [ ] **Atomic Assignment Mutex**: Concurrency lock prevents race conditions and duplicate assignments when multiple leads arrive simultaneously.
- [ ] **First-Response SLA Deadlines**: Configure tenant response SLA window (e.g., 15m, 30m, 1h, 2h).
- [ ] **SLA Status Tracking**: Real-time SLA indicators showing Normal, SLA Warning (threshold near), or SLA Breached.
- [ ] **Overdue Deals Filter (`GET /api/crm/deals/overdue`)**: One-click dashboard view displaying all leads with breached SLAs.
- [ ] **Manager SLA Escalation**: Automated escalation flags alerting managers when an assigned agent misses the response SLA.
- [ ] **Manual Lead Reassignment (`POST /api/crm/deals/:id/assign`)**: Managers manually reassign a lead to another agent with audit reason.
- [ ] **Assignment Audit Trail (`GET /api/crm/deals/:id/assignments`)**: View complete chronological assignment and reassignment history.
- [ ] **Team Workload Overview (`GET /api/crm/agents/workload`)**: View distribution of active deals and capacity across all workspace agents.

---

## Round 6: WhatsApp Account Connection and Messaging

- [ ] **WhatsApp Web Pairing Initialization (`POST /api/whatsapp/connect`)**: Spawns headless Chromium client and begins authentication handshake.
- [ ] **Live QR Code Display**: Displays QR code modal in real-time, streaming updates via SSE until scan is completed.
- [ ] **Multi-Device Session Persistence**: Reconnects automatically on server reboot using saved session files in `.wwebjs_auth/` without re-scanning.
- [ ] **Session Hibernation (`SESSION_IDLE_TIMEOUT_MS`)**: Idle Chromium instances cleanly hibernate after configured inactivity period and revive on inbound messages.
- [ ] **WhatsApp Disconnect (`POST /api/whatsapp/disconnect`)**: Logs out WhatsApp session and cleanly terminates the associated browser process.
- [ ] **Inbound Message Capture**: Incoming messages from leads are automatically recorded in the database with timestamps and contact details.
- [ ] **Messages Conversation View**: Interactive chat list showing recent conversations, message bubbles, direction (in/out), and delivery status.
- [ ] **Manual Outbound Message Send (`POST /api/messages/send`)**: Send direct text messages to leads with phone number auto-formatting.
- [ ] **WhatsApp LID Resolution**: Message reply mechanism properly resolves WhatsApp Linked Device (LID) format to valid phone numbers.
- [ ] **Outbound Message Throttling**: Rate limiter enforces maximum 30 manual sends per minute per tenant to protect account health.
- [ ] **Clear Conversation History (`DELETE /api/messages`)**: Deletes tenant message history while keeping contacts intact.

---

## Round 7: Chatbot, AI Pause, Human Takeover and Opt-Out Compliance

- [ ] **Chatbot Master Switch**: Enable or disable the automated rule-based chatbot via Settings (`chatbot_enabled`).
- [ ] **Keyword Match Types**: Create rules supporting `exact`, `contains`, `startswith`, and `regex` matching.
- [ ] **ReDoS Validation**: System rejects catastrophic backtracking regex syntax during rule creation.
- [ ] **Chatbot Test Sandbox (`POST /api/chatbot/test`)**: Test draft messages against active rules to preview matches and responses before publishing.
- [ ] **Rule Hit Counting**: Each triggered rule increments its `hit_count` for analytics tracking.
- [ ] **Human Simulation Delays**: Automated replies simulate human typing state (`sendStateTyping`) and introduce randomized delays (1.5s–3.0s).
- [ ] **Anti-Ban Inbound Message Throttling**: Throttles rapid senders exceeding rate limit (10 msgs/min) and sends a polite customizable throttle reply.
- [ ] **Monthly Plan Limit Check**: Auto-replies cease gracefully if tenant exceeds their plan's monthly message allotment (`plan_limit_reached`).
- [ ] **Mandatory STOP Opt-Out**: Inbound `STOP`, `UNSUBSCRIBE`, `CANCEL`, `QUIT`, or `END` automatically sets contact opt-out and sends confirmation.
- [ ] **Opt-Out Scheduled Message Cancellation**: Processing an opt-out automatically cancels all pending scheduled messages for that phone.
- [ ] **Mandatory START Opt-In**: Inbound `START` or `UNSTOP` resubscribes the contact and sends an opt-in confirmation message.
- [ ] **Automated Reply Suppression**: All chatbot, AI, and brochure replies are strictly suppressed for contacts marked as opted out.
- [ ] **Human Takeover / AI Pause (`POST /api/messages/conversation/:phone/pause-ai`)**: Manual toggle to silence all AI and bot replies for a specific chat.
- [ ] **Human Takeover Enforcement**: Inbound messages on an AI-paused chat are saved to the database, but automated replies remain suspended.

---

## Round 8: Bulk Campaigns, Outreach and Scheduling

- [ ] **Campaigns List View (`GET /api/contacts/outreach`)**: Displays past and active bulk outreach jobs with status, recipient count, and progress.
- [ ] **Campaign Composer Modal**: Launch new campaign with custom name, message template, and target audience.
- [ ] **Audience Selection Modes**: Select recipients via contact labels, quick multi-select checkmarks, or ad-hoc CSV upload.
- [ ] **Dynamic Variable Interpolation**: Templates resolve merge tags: `{{name}}`, `{{first_name}}`, `{{business_name}}`, `{{city}}`.
- [ ] **Media Attachment in Outreach**: Attach a property brochure PDF, floor plan, or image to bulk campaign messages.
- [ ] **Anti-Ban Pacing & Jitter**: Outreach dispatches messages with randomized delays (5s–15s) between recipients to avoid spam detection.
- [ ] **Concurrent Outreach Job Ceiling**: Enforces global concurrency limits to prevent outbound socket and CPU exhaustion.
- [ ] **Real-Time Progress Tracking (`GET /api/contacts/outreach/:jobId`)**: Tracks sent, failed, remaining recipients, and calculates progress percentage.
- [ ] **Campaign Cancellation (`POST /api/contacts/outreach/:jobId/cancel`)**: Immediately aborts an in-flight campaign and marks remaining jobs cancelled.
- [ ] **Interrupted Campaign Crash Recovery**: Incomplete campaigns automatically resume or recover safely on server restart.
- [ ] **One-Off Scheduled Messages (`POST /api/scheduled`)**: Schedule a specific message for a future date and time.
- [ ] **Atomic Claim Cron Worker**: Background scheduler checks every minute and atomically claims due messages (`status = 'processing'`).
- [ ] **Scheduled Message Cancellation (`DELETE /api/scheduled/:id`)**: Remove a scheduled message before its dispatch time.

---

## Round 9: Gemini 3.x and AI Command Center

- [ ] **AI Configuration Settings**: Input and store Gemini API Key with masked value display (`#tab-ai`).
- [ ] **Interactive Gemini Key Validation (`POST /api/settings/test-gemini`)**: Live test button checks key validity against Google Gemini API.
- [ ] **Gemini Model Selector**: Dropdown to select specific Gemini models or set to `Auto` mode (`GET /api/settings/gemini-models`).
- [ ] **Gemini 3.x Model Support**: Verified support for `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.5-flash`, and `gemini-2.5-flash-lite`.
- [ ] **Automated Fallback Waterfall**: Seamlessly cascades to the next available model if the preferred model experiences rate limits or downtime.
- [ ] **Per-Key Circuit Breaker**: Isolates upstream Gemini outages per tenant API key, cooling down failing keys without affecting others.
- [ ] **Request Timeout Guard**: Enforces strict 30-second timeout (`GEMINI_TIMEOUT_MS`) on AI calls to prevent hung requests.
- [ ] **AI Concurrency Gate**: Limits simultaneous AI requests per tenant and globally to prevent API quota and socket exhaustion.
- [ ] **Hourly AI Rate Limiting**: Caps tenant AI requests to 120 per hour (`aiLimiter`) to prevent runaway API billing.
- [ ] **Graceful AI Degradation**: System falls back to rule-based chatbot responses if Gemini API is unavailable or unconfigured.

---

## Round 10: AI Lead Analysis and Business Intelligence

- [ ] **Single Conversation Analysis (`POST /api/leads/analyze/:phone`)**: Analyze chat history with AI from the conversation view.
- [ ] **Bulk "Analyze All" Operation (`POST /api/leads/analyze-all`)**: Process all unanalyzed conversations via background queue.
- [ ] **Debounced Auto-Analysis**: Automatically triggers lead analysis in the background once a conversation goes quiet for several minutes.
- [ ] **Lead Scoring & Intent Detection**: Assigns a numeric Lead Score (0–100), Status (`Hot`, `Warm`, `Cold`), and Sentiment (`Positive`, `Neutral`, `Negative`).
- [ ] **Real Estate Requirement Extraction**: Extracts budget range, BHK preference, property type, location preferences, and purchase timeframe.
- [ ] **Discussion Summary & Sales Advice**: Generates a concise summary of key talking points and actionable advice for human agents.
- [ ] **Leads Intelligence Table (`GET /api/leads`)**: View, search, and sort analyzed leads by score, budget, and status.
- [ ] **Analyzed Leads CSV Export (`GET /api/leads/export`)**: Download CSV containing AI-extracted parameters and lead scores.
- [ ] **AI Business Profile Synthesis (`POST /api/business/analyze`)**: Analyzes conversation history to generate tone, offerings, FAQs, and business rules.
- [ ] **Business Knowledge Configuration (`GET/PUT /api/business`)**: Manually configure business name, description, address, operating hours, and currency.
- [ ] **AI Context Injection**: Injects business knowledge and property details into chatbot prompts for accurate responses.

---

## Round 11: Google Workspace Integrations

- [ ] **Google Calendar Status Card**: Settings tab displaying OAuth connection status and synced account email.
- [ ] **Google OAuth 2.0 Flow (`GET /api/calendar/connect`)** `[REQUIRES GOOGLE OAUTH CLIENT ID & SECRET]`: Initiates Google authentication consent screen.
- [ ] **OAuth Token Callback (`GET /api/calendar/oauth/callback`)**: Exchanges authorization code for tokens and persists encrypted credentials.
- [ ] **Google Calendar Disconnection (`POST /api/calendar/disconnect`)**: Revokes calendar access and deletes stored tokens from database.
- [ ] **Automatic Token Refresh**: Transparently refreshes expired Google OAuth access tokens using stored refresh tokens.
- [ ] **Background Sync Worker (`calendar-sync.js`)**: Runs bi-directional sync every 5 minutes with manual trigger button (`#calendarSyncBtn`).
- [ ] **Calendar Event Import**: Events created in Google Calendar titled `WhatsApp: <phone> [name]` are imported into scheduled messages.
- [ ] **Outreach Event Logging**: Delivered outreach messages are logged to Google Calendar with tag `[whatsapp-automation]`.
- [ ] **Outreach Free/Busy Availability Guard**: Skips outreach sends during meetings when `check_availability` is active.
- [ ] **Appointment Calendar Sync**: Site visit appointments booked in Workpilot synchronize to the connected Google Calendar.

---

## Round 12: Appointments, Site Visits and Reminders

- [ ] **Booking Settings Management (`GET/PUT /api/appointments/settings`)**: Configure operating hours per weekday, slot duration, buffer time, and booking notice.
- [ ] **Timezone Support**: Settings support standard IANA timezones (e.g. `Asia/Kolkata`) for accurate slot calculations.
- [ ] **Dynamic Slot Calculation (`GET /api/appointments/slots`)**: Computes open site visit booking slots based on operating hours and existing bookings.
- [ ] **Site Visit Booking Creation (`POST /api/appointments`)**: Book visit with contact name, phone, project, unit, date/time, and notes.
- [ ] **Double-Booking Prevention**: PostgreSQL transaction advisory lock (`pg_advisory_xact_lock`) prevents simultaneous bookings for the same slot.
- [ ] **Appointments List View (`GET /api/appointments`)**: Displays upcoming, completed, and cancelled appointments.
- [ ] **Appointment Cancellation (`DELETE /api/appointments/:id`)**: Cancels booking and immediately cancels all associated pending reminders.
- [ ] **Automated 24-Hour Reminder Generation**: Background worker schedules a WhatsApp reminder 24 hours prior to visit.
- [ ] **Automated 2-Hour Reminder Generation**: Background worker schedules an urgent WhatsApp reminder 2 hours prior to visit.
- [ ] **Reminder Template Variable Substitution**: Renders templates with `{{name}}`, `{{property}}`, `{{time}}`, `{{location}}`, and `{{map_url}}`.
- [ ] **Instant Booking Confirmation Message**: Sends immediate WhatsApp confirmation to the lead upon appointment creation.

---

## Round 13: Property Management, Media Uploads and Brochure Automation

- [ ] **Projects Catalog View (`GET /api/inventory/projects`)**: Browse property projects with filtering by city, property type, and status.
- [ ] **Project Creation & Editing (`POST/PUT /api/inventory/projects`)**: Create project with builder name, location, RERA ID, RERA verified toggle, and price ranges.
- [ ] **Project Deletion (`DELETE /api/inventory/projects/:id`)**: Remove project and its associated inventory.
- [ ] **Units Management (`GET/POST /api/inventory/projects/:projectId/units`)**: Track unit numbers, tower/block, floor, BHK, carpet area, and pricing.
- [ ] **Unit Status State Machine**: Move units through `available` -> `hold` -> `booked` -> `sold` workflows.
- [ ] **Unit Status History (`GET /api/inventory/units/:id/history`)**: View complete historical audit log of status changes for a unit.
- [ ] **Unit Hold Expiration Cron**: Background worker (`expireStaleHolds`) automatically releases units whose hold duration has expired.
- [ ] **Unit Search Engine (`GET /api/inventory/units/search`)**: Search inventory by BHK, budget range, project, floor, and availability.
- [ ] **Media Asset Upload (`POST /api/inventory/projects/:id/assets`)**: Upload PDF brochures, floor plans, images, and MP4 walkthrough videos up to 16MB.
- [ ] **Secure Storage & Serving (`GET /api/inventory/assets/:id/file`)**: Assets are stored outside webroot (`data/assets/`) and served through authenticated routes.
- [ ] **Direct Media Send via WhatsApp**: Send a project brochure or floor plan directly to a contact's WhatsApp from the dashboard.
- [ ] **Media Send History (`GET /api/inventory/assets/:id/history`)**: View delivery history for each media asset.
- [ ] **Brochure Drop Trigger Matching**: Matches real estate inquiries (`#3BHK`, `3 BHK`, project name, `brochure`, `price list`) before AI path.
- [ ] **Automated Brochure Drop (`tryBrochureDrop`)**: Sends verified PDF brochure and walkthrough video upon matching project intent.
- [ ] **Brochure Drop Deduping Cooldown**: Frequency cap prevents sending repetitive brochures to the same contact.
- [ ] **Brochure Drop Event History (`GET /api/inventory/brochure-drops`)**: View log of all automated brochure drops.

---

## Round 14: ERP Integration, APIs, Database and Background Jobs

- [ ] **PostgreSQL 17 Database Engine**: System connects to PostgreSQL via connection pool (`db-pool.js`) with bounded connections.
- [ ] **Versioned Migrations (001–024)**: Verified that all 24 schema migrations apply cleanly on boot (`schema_migrations` table).
- [ ] **Database Connection Pool Resilience**: Statement timeout (15s) and connection acquisition timeout (5s) prevent connection lockups.
- [ ] **Numeric / BigInt JSON Serialization**: Type parsers preserve large integer precision without crashing JSON serialization.
- [ ] **Parameterized Query Enforcement**: All queries use parameter placeholders (`$1, $2, ...`), preventing SQL injection attacks.
- [ ] **Atomic Message Claim Pipeline**: Scheduler claims pending messages with `UPDATE ... WHERE status='pending' RETURNING id` preventing race conditions.
- [ ] **1-Minute Background Scheduler (`scheduler.js`)**: Executes periodic checks for pending scheduled messages and appointment reminders.
- [ ] **5-Minute Calendar Sync Worker (`calendar-sync.js`)**: Background polling for Google Calendar event synchronization.
- [ ] **Unit Hold Release Sweep**: Background routine systematically expires stale property holds.
- [ ] **SQLite to PostgreSQL Importer (`scripts/migrate-sqlite-to-postgres.js`)**: Script migrates legacy SQLite/sql.js databases to PostgreSQL.
- [ ] **Database Backup Utility (`scripts/backup-postgres.sh`)**: Script creates gzipped `.sql.gz` backups of the active database.
- [ ] **Test Database Guard (`tests/setup.js`)**: Prevents automated test suites from executing against production database names.
- [ ] **Server Durability Check (`assertPersistable`)**: Rejects incoming writes with a 503 error if the database connection enters a degraded state.

---

## Round 15: Security, Error Handling, Responsive UI and End-to-End Workflows

- [ ] **Dynamic CSP Nonce (`nonceMiddleware`)**: Strict Content Security Policy with unique per-request nonce; blocks unapproved inline scripts.
- [ ] **HTTP Security Headers**: Server responds with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `HSTS`.
- [ ] **Hardened Session Cookies**: Cookies enforced with `HttpOnly`, `SameSite=Lax`, and `Secure` flag in production environments.
- [ ] **CORS Origin Policy**: Strictly blocks browser requests originating from untrusted third-party domains with `HTTP 403 Forbidden`.
- [ ] **PII Phone Number Protection**: Recipient phone numbers are masked (`***-***-1234`) across stdout logs, API responses, and standard agent views.
- [ ] **Token Encryption at Rest (`token-crypto.js`)**: AES-256-GCM encryption protects stored Google OAuth tokens and credentials.
- [ ] **Spreadsheet Formula Injection Sanitization**: Prepends quote prefixes to cells starting with `=`, `+`, `-`, or `@` during CSV export.
- [ ] **Standardized Error Responses (`errorHandler`)**: Server returns structured JSON errors (`{ success: false, error: "..." }`) without leaking internal stack traces.
- [ ] **Responsive Breakpoint Testing**: Visual UI renders correctly across mobile (375px), tablet (768px), and desktop (1280px+) viewports.
- [ ] **End-to-End Lifecycle 1 — Lead Acquisition & Brochure Drop**: Inbound WhatsApp message matching `#3BHK` -> Contact created -> Brochure PDF delivered -> Deal logged in CRM.
- [ ] **End-to-End Lifecycle 2 — AI Qualification & Takeover**: Inbound inquiry -> Gemini answers property questions -> Agent clicks "Pause AI" -> Agent takes over conversation manually.
- [ ] **End-to-End Lifecycle 3 — Site Visit Booking & Reminders**: Lead requests visit -> Appointment booked for slot -> Confirmation sent -> 24h & 2h reminders queued and sent -> Deal marked won.
- [ ] **End-to-End Lifecycle 4 — Bulk Campaign & Opt-Out**: Campaign launched with brochure -> Recipient replies STOP -> Contact auto-unsubscribed -> Pending messages cancelled.
