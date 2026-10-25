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
| **W1** | Shared text dispatch service (LID/@c.us/502) | **INVESTIGATING** | W0 | Phone normalization, `@c.us` vs `@lid` fallback, real message ID capture |
| **W2** | Text-only campaign | **OPEN** | W1 | Pacing, isolation, name template fallback, counters |
| **W3** | Shared media service ("id property... undefined") | **OPEN** | W1 | `MessageMedia` construction, `newMsgKey` preserve in injected utils |
| **W4** | Campaign media end-to-end | **OPEN** | W2, W3 | Media campaign dispatch + counters |
| **W5** | Gemini/AI tools & `thought_signature` | **OPEN** | W0 | Gemini 2.5/3.x thought signature preservation on multi-turn function calls |
| **W6** | Brochure/property intent | **OPEN** | W3, W5 | Intent matching, PDF asset lookup, honest failure response |
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
