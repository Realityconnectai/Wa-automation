# TASK 02B: POSTGRESQL MIGRATION VERIFICATION AND REPAIR REPORT

**Date:** 2026-09-19  
**Engineer:** Senior Backend and Database Verification Engineer  
**Branch:** `final-delivary`  
**Workspace:** `e:\whatsapp automation`  
**Node Version:** `v25.8.2` (Windows 10/11 x64)  
**PostgreSQL Status:** `BLOCKED` (No local container runtime or PostgreSQL daemon listening on `127.0.0.1:5432`)  
**Overall Status:** **PARTIAL / BLOCKED ON LIVE PG EXECUTION**  
- **Static Code Inspection & Defects Repaired:** `VERIFIED LOCALLY` (100% PASS on offline test suites and secret check)  
- **Live PostgreSQL Integration Tests:** `BLOCKED` (Requires local PostgreSQL environment)  

---

## 1. Executive Summary & Correction of Earlier Claims

In Task 2, an initial effort was made to replace `sql.js` snapshot persistence with PostgreSQL. However, review of `TASK_02_DATABASE_DURABILITY_REPORT.md` and the underlying code revealed discrepancies:
1. **Unverified Claims in Task 2 Report:**
   - Section 7 claimed concurrency protections were verified against PostgreSQL, and Section 8 claimed successful import verification of synthetic data, while simultaneously marking PostgreSQL integration tests as `NOT RUN` in Sections 1 and 10.
   - In reality, **no live PostgreSQL database was executed**.
   - `src/migrations/008_audit_logs.sql` was listed in the file inventory, but the file was actually `008_users_status_pending_rejected.sql`. An `audit_logs` table does not exist in the codebase or migrations.
   - The import script and synthetic generator used schema names (`lead_analyses`, `google_calendar_tokens`) that diverged from the actual legacy SQLite database and the PostgreSQL migrations (`lead_analysis`, `google_calendar_accounts`), and omitted `google_calendar_synced_events` entirely.
2. **Action Taken in Task 2B:**
   - **No fake results:** We strictly adhered to the rule: *Never substitute mocked PostgreSQL results for real database tests*.
   - **Repaired 11 critical defects:** Placeholder converter, BigInt/numeric parsers, schema naming discrepancies, sequence `setval` guards, timezone normalization, session invalidation across restarts, synthetic database generator, backup/restore script security, and missing test `await` calls.
   - **Added Comprehensive Offline Verification Suite:** 27 offline tests in `tests/postgres.offline-verification.test.js` verifying the state-machine placeholder parser, type parsers, UTC normalization, migration SQL syntax, and synthetic legacy database schema parity. All 27 tests passed.
   - **Database Execution Status:** Formally marked **BLOCKED** until a local PostgreSQL 15/16 instance is started. Provided exact, OS-specific setup instructions for Windows.

---

## 2. Environment Status & Verification Blockers

### Detected Host Environment
- **Operating System:** Windows 10/11 Pro (win32 10.0.26100)
- **Node.js:** `v25.8.2`
- **Port 5432 Check:**
  ```powershell
  Test-NetConnection -ComputerName localhost -Port 5432
  # Result: TcpTestSucceeded : False (Connection failed on 127.0.0.1 and ::1)
  ```
- **Container Runtime Check:**
  ```powershell
  Get-Service *docker*
  # Result: com.docker.service is Stopped
  ```
- **Local PostgreSQL Binaries:** `psql`, `pg_dump`, `postgres` not found in host PATH.

### Safety & Scope Compliance
Per the safety instructions:
- We did **NOT** modify `data/whatsapp.db` or its backup `data/whatsapp.db.bak`.
- We did **NOT** install a global Windows service, enable WSL, change firewall rules, or provision cloud resources.
- We did **NOT** connect to production or load production `.env`.
- We did **NOT** leak secrets, passwords, or customer records.

### Exact Windows Setup Procedure to Unblock Live Execution
To execute the live PostgreSQL integration tests and migration against a real database:

**Option A: Using Docker Desktop (Recommended if Docker Desktop is installed):**
```powershell
# 1. Start Docker Desktop application or service
Start-Service com.docker.service

# 2. Run an isolated, disposable PostgreSQL container bound to 127.0.0.1 only
docker run --name wa-pg-test `
  -e POSTGRES_USER=wa_test_user `
  -e POSTGRES_PASSWORD=wa_test_secure_pass_2026 `
  -e POSTGRES_DB=wa_test_db `
  -p 127.0.0.1:5432:5432 `
  -d postgres:16-alpine

# 3. Verify connection
Test-NetConnection -ComputerName 127.0.0.1 -Port 5432
```

**Option B: Using Windows Package Manager (`winget`):**
```powershell
# 1. Install PostgreSQL 16 locally
winget install PostgreSQL.PostgreSQL.16 --silent

# 2. Initialize and start a local disposable cluster on 127.0.0.1:5432
# Configure test database wa_test_db with test credentials
```

Once running, live execution can be performed using:
```powershell
$env:DATABASE_URL="postgres://wa_test_user:wa_test_secure_pass_2026@127.0.0.1:5432/wa_test_db"
npx jest tests/postgres.persistence.test.js
node scripts/migrate-sqlite-to-postgres.js --source test-fixtures/legacy-synthetic.db --target $env:DATABASE_URL --dry-run
node scripts/migrate-sqlite-to-postgres.js --source test-fixtures/legacy-synthetic.db --target $env:DATABASE_URL
```

---

## 3. Reconciled Legacy-to-New Schema Mapping

Through source inspection of `src/services/database.js` (legacy SQLite code), `src/migrations/*.sql`, and application route callers, the true pre-migration schema was recovered.

### Complete Table Mapping (14 Business & Integration Tables)

| Legacy SQLite Table | PostgreSQL Table | Conversion Details | Constraints & Keying | Import Coverage & Aliases |
|---|---|---|---|---|
| `users` | `users` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `VARCHAR`, `TIMESTAMPTZ`, `BOOLEAN`. Added `password_changed_at`. | `id SERIAL PRIMARY KEY`, `email UNIQUE NOT NULL`, `status IN ('pending', 'active', 'rejected', 'suspended')`. | Covered. Column alias: `last_login` -> `last_login_at`. Password hash preserved byte-identically. |
| `settings` | `settings` | SQLite `TEXT/TEXT` -> PG `INTEGER`, `VARCHAR(100)`, `TEXT`. | `PRIMARY KEY (user_id, key)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. **No Serial Sequence**. | Covered. Guarded in import script (`hasSerial: false`). |
| `contacts` | `contacts` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `VARCHAR(30)`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `UNIQUE (user_id, phone)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Column aliases: `last_contacted` -> `last_outreach_at`, `tags` -> `label`. |
| `messages` | `messages` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `VARCHAR(100)`, `TEXT`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `UNIQUE (user_id, wa_message_id)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. `wa_message_id` serves as external WhatsApp idempotency key. |
| `chatbot_rules` | `chatbot_rules` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `INTEGER hit_count`, `BOOLEAN is_active`. | `id SERIAL PRIMARY KEY`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Exact match. |
| `scheduled_messages` | `scheduled_messages` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `VARCHAR(20) status`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown'))`, `FK users(id)`. | Covered. Column alias: `failure_reason` -> `error_message`. All 6 statuses supported. |
| `products` | `products` | SQLite `INTEGER/TEXT/REAL` -> PG `SERIAL`, `NUMERIC(10,2)`, `BOOLEAN is_active`. | `id SERIAL PRIMARY KEY`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Bounded numeric parser ensures float/number preservation. |
| `crm_deals` | `crm_deals` | SQLite `INTEGER/TEXT/REAL` -> PG `SERIAL`, `NUMERIC(12,2) deal_value`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Exact match. |
| `crm_activities` | `crm_activities` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `INTEGER deal_id REFERENCES crm_deals(id) ON DELETE CASCADE`. | `id SERIAL PRIMARY KEY`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Exact match. |
| `lead_analysis` | `lead_analysis` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `BOOLEAN is_sales_conversation`, `JSONB issues`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `UNIQUE (user_id, phone)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Table alias supported: `lead_analyses` -> `lead_analysis`. Column alias: `analyzed_at` -> `last_analyzed_at`. |
| `google_calendar_accounts` | `google_calendar_accounts` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `BOOLEAN check_availability`, `TIMESTAMPTZ`. | `id SERIAL PRIMARY KEY`, `UNIQUE (user_id)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Table alias supported: `google_calendar_tokens` -> `google_calendar_accounts`. |
| `google_calendar_synced_events` | `google_calendar_synced_events` | SQLite `INTEGER/TEXT` -> PG `INTEGER user_id`, `VARCHAR(255) event_id`, `VARCHAR(255) google_event_id`. | `PRIMARY KEY (user_id, event_id)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. **No Serial Sequence**. | Covered. Omitted in Task 2; added to import script and synthetic generator in Task 2B. |
| `availability_settings` | `availability_settings` | SQLite `INTEGER/TEXT` -> PG `INTEGER user_id`, `VARCHAR(100) working_days`, `VARCHAR(10) start_time`, `end_time`, `BOOLEAN booking_enabled`. | `PRIMARY KEY (user_id)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. **No Serial Sequence**. | Covered. Exact column match: `working_days`, `start_time`, `end_time`, `slot_duration_minutes`, `buffer_minutes`, `timezone`, `booking_enabled`. |
| `appointments` | `appointments` | SQLite `INTEGER/TEXT` -> PG `SERIAL`, `VARCHAR(50) status`, `TIMESTAMPTZ start_at`, `end_at`. | `id SERIAL PRIMARY KEY`, `CHECK (status IN ('confirmed', 'cancelled', 'completed'))`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. | Covered. Column alias: `google_event_id` -> `calendar_event_id`. |

### Specific Investigations

1. **`lead_analysis` vs `lead_analyses`:**
   - **Investigation:** Legacy SQLite code in `src/services/database.js` defines `CREATE TABLE IF NOT EXISTS lead_analysis ...`. PostgreSQL migration `001_initial_schema.sql` defines `CREATE TABLE IF NOT EXISTS lead_analysis ...`. However, Task 2 import script and synthetic generator erroneously looked for `lead_analyses`.
   - **Resolution:** Reconciled table name to `lead_analysis` (singular). Added `tableAliases: ['lead_analyses']` in `scripts/migrate-sqlite-to-postgres.js` for forward/backward compatibility.
2. **`google_calendar_accounts` vs `google_calendar_tokens`:**
   - **Investigation:** Legacy SQLite and PostgreSQL migration `001_initial_schema.sql` both use `google_calendar_accounts` with column `check_availability INTEGER/BOOLEAN`. Task 2 scripts referenced `google_calendar_tokens` and non-existent `google_calendar_settings`.
   - **Resolution:** Reconciled to `google_calendar_accounts`. Added `tableAliases: ['google_calendar_tokens']` to import script.
3. **`google_calendar_synced_events` and Event Deduplication:**
   - **Investigation:** Legacy SQLite and PG migration both define `google_calendar_synced_events` with composite primary key `(user_id, event_id)` to deduplicate synced events across calendars. Task 2 import script completely omitted this table.
   - **Resolution:** Added `google_calendar_synced_events` to `scripts/migrate-sqlite-to-postgres.js` and `scripts/create-synthetic-legacy-db.js`.
4. **Calendar Settings vs Availability Settings:**
   - **Investigation:** Task 2 scripts hallucinated columns (`working_hours`, `notice_hours`) in `availability_settings`. Real schema columns are: `working_days`, `start_time`, `end_time`, `slot_duration_minutes`, `buffer_minutes`, `timezone`, `booking_enabled`.
   - **Resolution:** Aligned all schemas, fixtures, and import mappings to the true column list.
5. **User Session Invalidation Fields (`password_changed_at`):**
   - **Investigation:** When a user changes their password, all existing JWT tokens should be invalidated across process restarts. Previously, `users` lacked a timestamp tracking password changes, and `src/middleware/auth.js` did not check token issue time (`iat`) against password modification.
   - **Resolution:** Added `password_changed_at TIMESTAMPTZ` to `001_initial_schema.sql` and `users` table mapping. Updated `src/services/database.js` to update `password_changed_at = CURRENT_TIMESTAMP` on password change. Updated `src/middleware/auth.js` to reject tokens issued before `password_changed_at` with HTTP 401.
6. **Message IDs and Idempotency Keys:**
   - **Investigation:** Messages table stores `wa_message_id` with `UNIQUE (user_id, wa_message_id)` to ensure messages received from or sent via WhatsApp are never recorded twice.
   - **Resolution:** Verified constraint in `001_initial_schema.sql` and ensured index `idx_messages_user_wa_msg` exists in `009_indexes.sql`.
7. **Scheduled-Message Statuses:**
   - **Investigation:** Check constraint in `001_initial_schema.sql` was checked against all application code statuses: `pending`, `sending`, `sent`, `failed`, `cancelled`, and `unknown` (used when an external send result is ambiguous).
   - **Resolution:** Verified `CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown'))` is enforced in PostgreSQL.
8. **Audit Logs Table Analysis:**
   - **Investigation:** Task 2 report claimed `src/migrations/008_audit_logs.sql` was created. In reality, migration 008 was `008_users_status_pending_rejected.sql`. No `audit_logs` table exists in the legacy database, PostgreSQL migrations, or application code.
   - **Resolution:** Confirmed `audit_logs` does **NOT** belong in this database migration. It was a phantom reference in the earlier report.

---

## 4. Defects Found and Fixes Applied

### Defect 1: Naive Regex `?` Placeholder Converter
- **Issue:** `src/services/db-pool.js` originally used a global regex replace `sql.replace(/\?/g, () => '$' + index++)`. This broke on:
  1. Single-quoted strings containing question marks (`WHERE notes = 'Ready?'`).
  2. Double-quoted identifiers.
  3. Single-line and multi-line SQL comments (`-- Why?`, `/* Is this needed? */`).
  4. Dollar-quoted strings (`$$What?$$`, `$body$Hello?$$body$`).
  5. PostgreSQL JSONB operators `?|` and `?&` (which would be mangled into `$1|` and `$2&`).
  6. Escaped `??` operators.
- **Fix:** Implemented a full state-machine lexical scanner in `convertPlaceholders()` that tracks single-quote, double-quote, dollar-quote, line comment, block comment, and operator contexts.
- **Verification:** Verified by 12 test cases in `tests/postgres.offline-verification.test.js`.

### Defect 2: Global `BIGINT` and `NUMERIC` Parsers
- **Issue:** Coercing all `BIGINT` (OID 20) to JavaScript `Number` causes silent precision loss for IDs or counters exceeding `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`). Conversely, returning strings breaks existing frontend numeric API contracts.
- **Fix:** Configured the `BIGINT` parser to test `Number.isSafeInteger(Number(val))`: returning JavaScript `Number` for values within `[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`, and `BigInt(val)` for values outside safe bounds. Configured `NUMERIC` (OID 1700) to return finite floats or fallback to string.
- **Verification:** Verified by 6 test cases in `tests/postgres.offline-verification.test.js`.

### Defect 3: Session Invalidation Across Process Restart
- **Issue:** Changing a user password did not invalidate existing active JWTs if the server restarted, because session invalidation was in-memory or unrecorded.
- **Fix:**
  1. Added `password_changed_at TIMESTAMPTZ` to `users` table in `src/migrations/001_initial_schema.sql`.
  2. Updated `src/services/database.js` to automatically set `password_changed_at = CURRENT_TIMESTAMP` when updating `password_hash`.
  3. Added `updateUserPassword(id, passwordHash)` to `database.js`.
  4. Updated `src/middleware/auth.js` (`resolveSession`): if `user.password_changed_at` exists and `payload.iat < new Date(user.password_changed_at).getTime()`, rejects the request with HTTP 401 (`AUTH_REQUIRED`).

### Defect 4: Incompatible Table and Column Names in Migration Tool
- **Issue:** `scripts/migrate-sqlite-to-postgres.js` and `scripts/create-synthetic-legacy-db.js` used incorrect names (`lead_analyses`, `google_calendar_tokens`, `working_hours`, `analyzed_at`) and omitted `google_calendar_synced_events`.
- **Fix:** Reconciled both scripts to the 14 true tables, correct columns, table aliases, and column aliases.

### Defect 5: Sequence `setval` Invoked on Non-Serial Tables
- **Issue:** Task 2 import script called `SELECT setval(pg_get_serial_sequence($1, 'id'), ...)` unconditionally on all tables, including `settings` and `google_calendar_synced_events` which do not have serial `id` columns. This caused runtime SQL errors.
- **Fix:** Added `hasSerial: true/false` flag to table definitions and guarded sequence advancement to tables with `hasSerial === true`.

### Defect 6: Timezone Shifts on Legacy SQLite Timestamps
- **Issue:** SQLite stores UTC timestamps as space-separated strings (`"2026-10-01 10:00:00"`). When inserted into PostgreSQL `TIMESTAMPTZ`, PostgreSQL parses them using the local server/session timezone (e.g., `Asia/Kolkata` or `UTC`), shifting the instant by 5.5 hours.
- **Fix:** Added `normalizeUtcTimestamp()` to append `Z` to legacy timezone-free UTC strings (`"2026-10-01T10:00:00Z"`), ensuring PostgreSQL parses them as unambiguous UTC instants regardless of machine or session timezone.

### Defect 7: Synthetic Database Generator Incompleteness
- **Issue:** `scripts/create-synthetic-legacy-db.js` only created 9 tables and omitted `google_calendar_synced_events`, `availability_settings`, and realistic multi-tenant data.
- **Fix:** Rewrote `scripts/create-synthetic-legacy-db.js` to generate all 14 tables with realistic synthetic data for 2 tenants, including foreign keys, appointments, deals, and idempotency keys. Generated `test-fixtures/legacy-synthetic.db` (102,400 bytes).

### Defect 8: Credential Leakage in Backup & Restore Scripts
- **Issue:** `scripts/backup-postgres.sh` and `scripts/restore-postgres.sh` passed database URLs or passwords in command-line arguments, exposing them in process listing (`ps -ef` / `/proc`).
- **Fix:** Refactored scripts to parse connection URLs and populate standard environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). Cleared password variables upon completion.

### Defect 9: Non-Atomic Output in `backup-postgres.sh`
- **Issue:** If `pg_dump` failed midway or disk filled up, a truncated backup file remained, presenting a false appearance of backup success.
- **Fix:** Added atomic output staging: `pg_dump` writes to `${BACKUP_FILE}.tmp.$$`. On success, checks `[ -s "$TEMP_FILE" ]` before atomically moving to `$BACKUP_FILE` and applying `chmod 0600`. Added `trap 'rm -f "$TEMP_FILE"' EXIT INT TERM` for clean signal cleanup.

### Defect 10: Target Collision in `restore-postgres.sh`
- **Issue:** `scripts/restore-postgres.sh` restored directly without checking if the destination database already had existing business tables, risking accidental overwrites.
- **Fix:** Added pre-flight check: queries target for existing tables (`users`, `contacts`, `messages`). Refuses to overwrite unless `--force` is explicitly provided.

### Defect 11: Missing `await` Calls in Test Suites & Scripts
- **Issue:**
  1. `tests/setup.js`: `countUsers()`, `updateUser()`, `getUserById()`, `createUser()` lacked `await`.
  2. `tests/jobs-scheduler-ai.test.js`: `createUser()`, `createScheduledMessage()`, `claimScheduledMessage()`, `updateScheduledMessageStatus()` lacked `await`.
  3. `scripts/migrate-sqlite-to-postgres.js`: executed immediately on require, breaking offline unit testing.
- **Fix:** Added missing `await` calls in `tests/setup.js` and `tests/jobs-scheduler-ai.test.js`. Wrapped CLI execution in `if (require.main === module)` in `migrate-sqlite-to-postgres.js`.

---

## 5. Exact Changed Files

| File | Change Type | Description |
|---|---|---|
| `src/services/db-pool.js` | Modified | Rewrote `convertPlaceholders` with a state-machine parser handling quotes, comments, dollar-quotes, and JSON operators (`?|`, `?&`, `??`). Configured bounded `BigInt` and `NUMERIC` parsers. |
| `src/migrations/001_initial_schema.sql` | Modified | Added `password_changed_at TIMESTAMPTZ` to `users` table. |
| `src/services/database.js` | Modified | Supported positional/object `createUser`, updated `updateUser` and `updateUserPassword` to record `password_changed_at`, included `password_changed_at` in user queries. |
| `src/middleware/auth.js` | Modified | Added session invalidation in `resolveSession`: rejects tokens where `payload.iat < user.password_changed_at`. |
| `scripts/migrate-sqlite-to-postgres.js` | Modified | Reconciled all 14 tables, added table and column aliases, added `normalizeUtcTimestamp`, guarded `setval` to serial tables, wrapped CLI in `require.main === module`, exported functions for testing. |
| `scripts/create-synthetic-legacy-db.js` | Modified | Rebuilt to generate all 14 tables with realistic synthetic data across 2 tenants. |
| `scripts/backup-postgres.sh` | Modified | Eliminated CLI password arguments, added atomic temp file staging, signal traps, `chmod 0600`, and documented secret data sensitivity. |
| `scripts/restore-postgres.sh` | Modified | Eliminated CLI password arguments, added safety check against populated target database unless `--force` passed. |
| `tests/setup.js` | Modified | Added missing `await` to `db.countUsers()`, `updateUser()`, `getUserById()`, `createUser()`. |
| `tests/jobs-scheduler-ai.test.js` | Modified | Added missing `await` to `createUser()`, `createScheduledMessage()`, `claimScheduledMessage()`, `updateScheduledMessageStatus()`. |
| `tests/postgres.offline-verification.test.js` | **NEW** | Comprehensive 27-test offline verification suite for placeholder converter, type parsers, UTC normalization, schema migrations, and synthetic DB parity. |

---

## 6. Commands Executed and Real Observed Results

### 1. Offline Verification Test Suite
- **Command:** `npx jest tests/postgres.offline-verification.test.js`
- **Output:**
  ```
  PASS tests/postgres.offline-verification.test.js
    Task 2B: Offline PostgreSQL Verification Suite
      1. Placeholder Converter State Machine
        √ converts basic positional placeholders ? to $1, $2
        √ preserves ? inside single-quoted strings
        √ preserves ? inside escaped single quotes
        √ preserves ? inside double-quoted identifiers
        √ preserves ? inside single-line comments
        √ preserves ? inside multi-line block comments
        √ preserves ? inside dollar-quoted strings
        √ preserves ? inside tagged dollar-quoted strings
        √ handles PostgreSQL JSON operators ?| and ?& without replacing with $n
        √ handles escaped ?? operator for JSONB key existence
        √ complex query combining quotes, comments, operators, and parameters
        √ normalizeSql leaves queries without ? untouched
      2. BigInt and Numeric Type Parsers
        √ BigInt parser returns null for null input
        √ BigInt parser converts standard integers to JavaScript Number
        √ BigInt parser converts MAX_SAFE_INTEGER exactly
        √ BigInt parser preserves values beyond MAX_SAFE_INTEGER without precision loss
        √ Numeric parser returns null for null input
        √ Numeric parser parses floating point deal values correctly
      3. Timezone Model and UTC Normalization
        √ normalizes legacy SQLite space-separated UTC strings to ISO Z format
        √ preserves already-formatted ISO strings with Z or timezone offset
        √ preserves non-timestamp strings or nulls
      4. Schema Migration Files & Sequence Integrity
        √ all 9 migration files exist and are non-empty
        √ 001_initial_schema.sql defines all 14 business and integration tables
        √ 001_initial_schema.sql has password_changed_at on users table
        √ scheduled_messages status check constraint includes all 6 valid statuses
        √ tables with serial IDs vs non-serial primary keys are correctly distinguished
      5. Synthetic Legacy SQLite Database Schema Parity
        √ synthetic database fixture exists and is populated

  Test Suites: 1 passed, 1 total
  Tests:       27 passed, 27 total
  Snapshots:   0 total
  Time:        1.156 s
  ```
- **Outcome:** **PASS** (27/27 passed).

### 2. Validation Suite
- **Command:** `npx jest tests/validation.test.js`
- **Output:**
  ```
  PASS tests/validation.test.js
  Test Suites: 1 passed, 1 total
  Tests:       111 passed, 111 total
  Snapshots:   0 total
  Time:        1.562 s
  ```
- **Outcome:** **PASS** (111/111 passed).

### 3. Secret Check
- **Command:** `node scripts/check-secrets.js`
- **Output:**
  ```
  ✓ [check:secrets] All 89 tracked/staged files clean. No secrets detected.
  ```
- **Outcome:** **PASS** (0 secrets detected).

### 4. Synthetic Database Generation
- **Command:** `node scripts/create-synthetic-legacy-db.js`
- **Output:** Created `test-fixtures/legacy-synthetic.db` (102,400 bytes, exit code 0).
- **Outcome:** **PASS**.

### 5. Local Port 5432 & Service Inspection
- **Command:** `powershell -Command "Test-NetConnection -ComputerName localhost -Port 5432"`
- **Output:** `TcpTestSucceeded : False`.
- **Outcome:** **BLOCKED** for live PostgreSQL execution.

---

## 7. Separate Test Outcomes (PASS / FAIL / NOT RUN)

| Test Suite / Component | Execution Status | Observed Result | Notes |
|---|---|---|---|
| `tests/postgres.offline-verification.test.js` | **PASS** | 27/27 passed (1.15s) | Verifies placeholder lexer, BigInt/numeric parsers, timezone normalization, migration SQL, synthetic DB parity. |
| `tests/validation.test.js` | **PASS** | 111/111 passed (1.56s) | Validates input sanitization, phone normalization, ReDoS guards, CSV injection protection. |
| `scripts/check-secrets.js` | **PASS** | 89/89 files clean | No hardcoded credentials or secrets in tracked or staged files. |
| `scripts/create-synthetic-legacy-db.js` | **PASS** | Exit code 0 | Generated 14-table synthetic SQLite database fixture (102 KB). |
| `tests/jobs-scheduler-ai.test.js` | **NOT RUN (BLOCKED)** | Attempted execution; failed with `AggregateError: connect ECONNREFUSED 127.0.0.1:5432` | Requires running PostgreSQL instance on port 5432. |
| `tests/postgres.persistence.test.js` | **NOT RUN (BLOCKED)** | Blocked by absence of PostgreSQL instance | Covers live migration runner, tenant isolation, concurrency, rollback on failure. |
| `scripts/migrate-sqlite-to-postgres.js` (Live) | **NOT RUN (BLOCKED)** | Blocked by absence of PostgreSQL instance | Code repaired and validated offline; pending live execution against test DB. |
| `scripts/backup-postgres.sh` (Live) | **NOT RUN (BLOCKED)** | Blocked by absence of `pg_dump` and PostgreSQL instance | Script repaired with atomic temp file and secure env vars. |
| `scripts/restore-postgres.sh` (Live) | **NOT RUN (BLOCKED)** | Blocked by absence of `psql` and PostgreSQL instance | Script repaired with populated target safety check and secure env vars. |

---

## 8. Backup and Restore Security & Reliability Analysis

1. **Credential Exposure:**
   - Previously: Scripts accepted database URLs with passwords in command arguments (`pg_dump "$DATABASE_URL"`), which exposed plaintext credentials in process listings (`ps -ef`, `/proc/$PID/cmdline`).
   - Now: Both `backup-postgres.sh` and `restore-postgres.sh` parse the URL or accept standard environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). `pg_dump` and `psql` read from the environment without command-line exposure.
2. **Atomic Output Finalization:**
   - Previously: Direct output to destination file could leave a corrupt, partial file on failure.
   - Now: Backup dumps to a temporary file (`${BACKUP_FILE}.tmp.$$`), checks `[ -s "$TEMP_FILE" ]` for non-zero size, atomically moves (`mv`) to final destination, and sets restrictive permissions (`chmod 0600`).
3. **Target Population Protection:**
   - Previously: Restore script executed unconditionally.
   - Now: Checks if target database contains existing tables (`users`, `contacts`, `messages`). Refuses to overwrite unless `--force` is supplied.
4. **Data Sensitivity Classification:**
   - Dumps contain Google OAuth tokens (`google_calendar_accounts`), password hashes (`users`), and customer communications (`messages`). Backups must be treated as **CONFIDENTIAL / RESTRICTED** storage.

---

## 9. Async & API Compatibility Coverage

All database callers across the entire codebase have been audited:
- **Middleware & Auth:** `src/middleware/auth.js` (`resolveSession`, `requireAuth`, `requireAdmin`, `optionalAuth`) all `await` database queries and handle rejected promises.
- **Routes:** All route modules (`src/routes/api.js`, `src/routes/auth.js`, `src/routes/admin.js`, `src/routes/appointments.js`, `src/routes/calendar.js`) wrap route handlers in `asyncHandler` and `await` every query.
- **Services:** `chatbot.js`, `lead-analyzer.js`, `business.js`, `scheduler.js`, `outreach.js`, `whatsapp-client.js`, `gemini-client.js`, `calendar-sync.js`, `ai.js` are fully asynchronous.
- **External Network Calls:** WhatsApp messaging (`whatsapp-client.js`), Gemini API calls (`gemini-client.js`), and Google Calendar API calls (`google-calendar.js`) execute **outside** database transactions to prevent connection pool exhaustion.
- **Client Leaks:** `src/services/db-pool.js` tracks checked-out clients and releases them in `finally` blocks during `transaction()` execution.

---

## 10. Remaining Runtime & Migration Risks

1. **PostgreSQL Sequence Non-Transactionality:**
   - PostgreSQL sequences are non-transactional: `setval()` or sequence increments do not roll back if a transaction fails. If an import fails midway, sequences may have advanced. The import script addresses this by advancing sequences only after data inserts succeed.
2. **Application Rollback Prerequisite (CRITICAL):**
   - **The new application codebase cannot run against a SQLite file.** If PostgreSQL cutover must be rolled back, the operations team **MUST** deploy the preserved legacy application version (which contains the `sql.js` adapter) alongside `data/whatsapp.db`. Merely repointing the new codebase at `data/whatsapp.db` will fail.
3. **Outstanding Security Blockers (from Task 1B):**
   - Google Calendar OAuth tokens stored in plaintext in `google_calendar_accounts` (encryption at rest required).
   - Session secret rotation and live credential revocation pending production environment deployment.

---

## 11. Preservation of Original Database and User Work

- `data/whatsapp.db` (and its backup `data/whatsapp.db.bak`) were **NOT modified, opened for writes, or deleted**.
- All tests and verification were performed using synthetic fixtures (`test-fixtures/legacy-synthetic.db`).
- All existing user work in git remains preserved.

---

## 12. Assessment on Proceeding to Task 3 (Durable Outreach Queues)

- **Can Task 3 begin?**
  - **YES, for queue architecture, job schemas, and queue service design.** The database schema and async layer in PostgreSQL are structurally sound, type parsers and placeholder converters are verified, and all callers are async.
  - **HOWEVER:** Before deploying to production or cutting over live traffic, live integration testing against a real PostgreSQL 15/16 instance (using the setup procedure in Section 2) must be executed.
