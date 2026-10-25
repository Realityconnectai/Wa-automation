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
| **W4** | Campaign media end-to-end | **INVESTIGATING** | W2, W3 | Media campaign dispatch + counters |
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
