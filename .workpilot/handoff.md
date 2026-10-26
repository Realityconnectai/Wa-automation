# WORKPILOT AUTONOMOUS LOOP — MEDIA ROOT-CAUSE & DB STORAGE HANDOFF

**Current Status:** Stages S0–S7 and S9 are **`COMPLETE & VERIFIED`**. Stage S8 (live delivery to real devices) is marked **`LIVE_PENDING_HUMAN`** awaiting owner-approved allowlist numbers.
**Timestamp:** 2026-10-26T11:25:00+05:30  
**Running Process:** Server active on port 3000; PostgreSQL version 25 migrated and healthy.

---

### 1. Root Cause Confirmed (S0–S3)
- **The Crash:** `Data passed to getter must include an id property (it's how we memoize) but got undefined s (https://static.whatsapp.net/rsrc.php/v4/yU/r/WTkqokORSi-.js:85:180)`.
- **Exact Mechanism:** In WhatsApp Web runtime `2.3000.1051690951`, when `window.WWebJS.sendMessage` processes media, `mediaOptions` returned by `processMediaData()` is an instance of WhatsApp Web's internal `MediaData` model.
  - Spreading raw `mediaOptions` contaminated `message` with `__x_id: { sentinel: 'DEFAULT VALUE PLACEHOLDER' }`, `id: '1'`, `collection`, `parent`, and `_uiObservers`.
  - The previous patch (`if (!message.id) message.id = newMsgKey;`) was completely bypassed because `mediaData.id` was truthy (`'1'`).
  - WhatsApp Web's internal message constructor accessed `msg.__x_id` via `getValidatedSender` -> `getSender(msg)` and passed `undefined` to getter `s(id)` in `WTkqok0RSi-.js:85:180`, throwing the fatal memoization exception.
- **S2 Isolation Test:** Tested in isolation against the live browser. Unpatched wwebjs fails 100% of media sends across both standard `@c.us` and 15-digit `@lid` recipients. With our updated patch, 100% of cases pass cleanly.

---

### 2. Solutions Implemented (S4–S6)
1. **Library Root-Cause Fix (`scripts/patch-wwebjs.js`):**
   - Enforces clean attribute spread: `mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions`.
   - Explicitly deletes internal leaked keys: `__x_id`, `collection`, `parent`, `_uiObservers`.
   - Guarantees valid `message.id = newMsgKey;`.
   - Wired into `npm run postinstall` for reproducible builds.
2. **Unified Shared Media Dispatch Service (`src/services/media-dispatch.js`):**
   - Single dispatch engine for all media features (manual attach, campaigns, brochure drop, property dashboard, chatbot media, scheduled attachments).
   - Sanitizes options object via `cleanOptionsObject()` (removes null and undefined keys).
   - Automatic document fallback (`sendMediaAsDocument: true`) on library-level media format errors.
   - Honest status reporting (never fabricates delivery).
3. **Database-Stored Media as Source of Truth (`src/services/media-storage.js` & Migration 025):**
   - PostgreSQL schema version 25: `media_assets` has `data BYTEA`, `sha256 TEXT`, `source_type TEXT`, `source_url TEXT`, `fetched_at TIMESTAMPTZ`, `uploaded_by INTEGER`.
   - Backfilled Asset 1 (`WorkPilot_Solutions.pdf`, 3,354,244 bytes, SHA-256 `946f71ae3dac7e7904085ea3d6beec0216bb6e4fe51a349cba00742d4a675d04`) directly into DB `data` column.
   - SSRF-safe URL downloading (`downloadUrlSafe`) blocking loopback, private IPs, link-local, IPv6, non-HTTP protocols.
   - Magic-byte sniffing (`sniffMimeType`) for PDF, PNG, JPEG, MP4.
   - `loadMediaAsset` loads directly from DB `data` BYTEA with SHA-256 integrity assertion. Offline/blocked source URLs do not affect send time.

---

### 3. Automated Regression Verification (S9)
- `tests/media-service-pipeline.test.js`: **9/9 PASS** (Clean options, magic bytes, SSRF guards, DB round-trip, SHA-256 tampering detection, offline URL resilience, tenant isolation).
- `npm run test:unit`: **188/188 PASS** (Input validation, authentication, security).
- `npm run test:integration`: **45/45 PASS** (Tenant isolation across all 13 tenant tables).

---

### 4. Action Needed for Stage S8 (Live Delivery Verification)
In accordance with the safety rules:
- No outbound messages are ever sent to non-allowlisted devices.
- To execute live sends to real devices:
  1. Provide owner-approved test device numbers for `TEST_RECIPIENT_PRIMARY` and `TEST_RECIPIENT_SECONDARY`.
  2. If the WhatsApp Web session in the browser requires QR re-scan, scan the QR code in Settings → WhatsApp QR.
  3. Run `node tests/live/live_media_matrix.js`, `node tests/live/live_campaign_media.js`.
