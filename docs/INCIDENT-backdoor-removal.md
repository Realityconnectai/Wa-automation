# Incident: Hardcoded Login Backdoor — Removal and Recovery Steps

**Severity:** Critical  
**Discovered:** Audit Pass 2, October 2026  
**Fixed in:** branch `phase0-preflight`, commit `fix(auth): remove hardcoded login backdoor`  
**File affected:** `src/routes/auth.js`, POST `/api/auth/login`

---

## What was the backdoor?

Three lines in the login route bypassed bcrypt verification entirely:

```javascript
// REMOVED — do not re-add
if (!valid && user.email === 'admin@workpilot.co.in' &&
    String(password || '').toLowerCase() === 'admin@workpilot123') {
    valid = true;
}
```

**Effect:** Anyone who knew both the email address (`admin@workpilot.co.in`) and the hardcoded password (`admin@workpilot123`) could log in as that account with full admin access, regardless of what bcrypt hash was stored.

The check was case-insensitive for the password, so `ADMIN@WORKPILOT123`, `Admin@Workpilot123`, and all other case variants also worked.

**Introduced in commit:** `8646a016` ("fix(auth): support case-insensitive admin bootstrap password")

---

## What was fixed?

The three-line block was deleted. Login now uses only `verifyPassword(password, user.password_hash)` (bcrypt). No other code paths were changed.

Regression tests are in `tests/backdoor-regression.test.js`.

---

## Your manual steps after deploying this fix

Work through these in order. Do not skip steps.

### Step 1 — Assess exposure

Answer these questions before proceeding:

1. **Was the codebase ever shared externally?** (GitHub repo, zip file, email, shared drive)
   - If yes, assume the backdoor credential is known.
   - Check the git remote: `git remote -v`
   - Check if the repo is public: visit the GitHub URL and confirm it is private.

2. **Was the `admin@workpilot.co.in` account ever active on the production server?**
   - Run this query (against production DB, read-only):
     ```sql
     SELECT id, email, role, status, last_login_at, created_at
     FROM users
     WHERE LOWER(email) = 'admin@workpilot.co.in';
     ```
   - If `last_login_at` is not null, someone did log in. Could be legitimate or could be the backdoor.

3. **Check server access logs** for `POST /api/auth/login` with the backdoor email:
   ```bash
   grep -i "admin@workpilot" /var/log/caddy/access.log 2>/dev/null || \
   docker logs wa-app 2>&1 | grep -i "auth/login" | head -50
   ```
   (Log paths depend on your deployment. Adjust accordingly.)

---

### Step 2 — Change the admin password immediately

If the `admin@workpilot.co.in` account exists on production, change its password now via the `/api/auth/change-password` endpoint, or directly in the database:

**Option A — via API (preferred, keeps auth_version correct):**
1. Log in with the current real password.
2. `POST /api/auth/change-password` with `{ currentPassword, newPassword }`.
3. Choose a strong new password (16+ characters, random).

**Option B — directly in the database (use when API login is uncertain):**

```bash
# Generate a new bcrypt hash using Node (BCRYPT_ROUNDS=12 for production)
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('YOUR-NEW-PASSWORD-HERE', 12).then(h => console.log(h));
"
```

Then update in the database using a script file (never paste the hash directly in the shell — PowerShell expands `$` characters):

Create a temporary file `set-admin-password.js`:
```javascript
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    const hash = await bcrypt.hash('YOUR-NEW-PASSWORD-HERE', 12);
    await pool.query(
        `UPDATE users
         SET password_hash = $1,
             password_changed_at = NOW(),
             auth_version = COALESCE(auth_version, 1) + 1
         WHERE LOWER(email) = $2`,
        [hash, 'admin@workpilot.co.in']
    );
    console.log('Password updated and auth_version bumped.');
    await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
```

Run it: `node set-admin-password.js`  
Delete it immediately after: `del set-admin-password.js`

---

### Step 3 — Bump auth_version to revoke all existing sessions

If the Option A API path was used for the password change, `auth_version` is already bumped by `updateUser`. Skip this step.

If you used Option B (direct DB update) without including `auth_version = auth_version + 1`, run:

```sql
UPDATE users
SET auth_version = COALESCE(auth_version, 1) + 1
WHERE LOWER(email) = 'admin@workpilot.co.in';
```

This invalidates every session cookie that was ever issued for this account. Anyone who obtained a session via the backdoor will be logged out immediately on their next request.

---

### Step 4 — Deploy the fix

1. Merge `phase0-preflight` to your main/production branch (after code review).
2. Deploy as normal (`docker compose up -d --build` or your CI pipeline).
3. Verify the backdoor is gone from the running container:
   ```bash
   docker exec wa-app grep -c "admin@workpilot.co.in" /app/src/routes/auth.js
   # Expected output: 0
   ```

---

### Step 5 — Confirm the fix is live

```bash
# This must return 401, never 200
curl -s -X POST https://YOUR-DOMAIN/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@workpilot.co.in","password":"admin@workpilot123"}' \
  | python3 -m json.tool
# Expected: {"success": false, "error": "Invalid email or password."}
```

---

### Step 6 — If the backdoor was actively exploited

If Step 1 reveals suspicious logins:

1. **Suspend the affected account immediately:**
   ```sql
   UPDATE users SET status = 'suspended'
   WHERE LOWER(email) = 'admin@workpilot.co.in';
   ```

2. **Audit what the admin account did** — check `crm_activities`, `messages`, user status changes in `audit_log` (once the audit log table is built in Phase 4).

3. **Notify affected tenants** if their data was accessible via the compromised admin account.

4. **Consider rotating** the `SESSION_SECRET` in `.env` — this logs out every user on the platform but ensures no forged sessions remain valid.

---

## Grep commands to confirm the backdoor is not present

Run these before every production deploy:

```bash
# Must produce zero output:
git grep "admin@workpilot.co.in" -- "*.js"
git grep "admin@workpilot123" -- "*.js"
git grep -i "workpilot123" -- "*.js"
```

The CI pipeline should include these as a pre-deploy gate.
