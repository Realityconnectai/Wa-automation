# Testing Guide

## Test database setup (required once)

The integration and security test suites write and delete real rows. They use
a **throwaway** PostgreSQL database (`whatsapp_test`) that must never be the
production database (`whatsapp_automation`). The test runner enforces this with
`src/utils/test-db-guard.js` — it will abort if `DATABASE_URL` points at a
protected database name.

### Create the test database (local Docker)

```bash
docker exec wa-postgres psql -U postgres -c "CREATE DATABASE wa_test;"
```

Run this once. The test suite recreates the schema on every run via migrations.

### Run the full suite

```bash
npm run test:db
```

This script (`scripts/run-tests-with-db.js`) sets the following env vars
before spawning Jest:

| Variable | Value set by script |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/wa_test` |
| `ALLOW_DESTRUCTIVE_TESTING` | `true` |
| `BCRYPT_ROUNDS` | `4` (fast hashing for tests) |
| `DISABLE_RATE_LIMITS` | `true` |
| `NODE_ENV` | `test` |

You can override `DATABASE_URL` to point at a different host/port:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test npm run test:db
```

### Run a single test file

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
npx jest tests/auth.security.test.js --forceExit
```

### Tests that do not need a database

These run without any DB setup:

```bash
npx jest tests/validation.test.js          # 111 tests
npx jest tests/db-safety-guard.test.js     # DB guard unit tests
npx jest tests/backdoor-regression.test.js --testNamePattern="source-code guard"
```

---

## Test suite structure

| File | What it tests | Needs DB |
|---|---|---|
| `validation.test.js` | Input validation functions in `validate.js` | No |
| `backdoor-regression.test.js` | Hardcoded login backdoor is removed | No (source guard) / Yes (HTTP tests) |
| `db-safety-guard.test.js` | DB guard rejects production targets | No (mocked) |
| `auth.security.test.js` | Full auth: signup, login, tokens, revocation | Yes |
| `auth-revocation.test.js` | Session revocation edge cases | Yes |
| `tenant-isolation.test.js` | Cross-tenant data isolation across all routes | Yes |
| `jobs-scheduler-ai.test.js` | Scheduler atomic claims, outreach limits, AI gate | Yes |
| `conversation-queue.test.js` | FIFO message ordering per conversation | Yes |
| `db-timeouts.test.js` | Query timeout enforcement | Yes |
| `security-audit-verification.test.js` | Token integrity, CORS, wa_enabled enforcement | Yes |
| `chatbot-rate-limit.test.js` | Rate-limit lead-drop fix: all messages saved, one throttle reply | Yes |
| `appointment-concurrency.test.js` | Concurrent slot bookings for same/different tenants | Yes |
| `postgres.persistence.test.js` | PostgreSQL migration idempotency, tenant isolation | Yes |

---

## CI environment variables

Add these as secrets in your CI pipeline (GitHub Actions, etc.):

```yaml
env:
  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/whatsapp_test
  ALLOW_DESTRUCTIVE_TESTING: "true"
  BCRYPT_ROUNDS: "4"
  DISABLE_RATE_LIMITS: "true"
  NODE_ENV: test
```

Example GitHub Actions service for the test DB:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: wa_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 5s
      --health-timeout 5s
      --health-retries 5
```

---

## Safety invariants

1. **Never run tests against `whatsapp_automation`** — the guard will abort.
2. `BCRYPT_ROUNDS=4` is test-only. Production uses 12. Do not change this in `.env`.
3. `DISABLE_RATE_LIMITS=true` is test-only. Production refuses to start with this set.
4. Tests clean up after themselves via `freshDatabase()` in `tests/setup.js`.
