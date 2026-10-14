/**
 * src/services/database.js — PostgreSQL-backed persistence layer.
 *
 * Implements:
 *   - Relational multi-tenant schema with versioned migrations (001–009).
 *   - Asynchronous query operations with connection pooling (via db-pool.js).
 *   - Atomic scheduled message claims (UPDATE ... WHERE status = 'pending' RETURNING id).
 *   - Concurrency-safe appointment bookings with tenant-level advisory locks.
 *   - Complete tenant isolation across all 13 tenant tables.
 *   - API contract preservation (numeric counts, status enums, JSON response shapes).
 */

const fs = require('fs');
const path = require('path');
const {
    initPool,
    getPool,
    query,
    queryAll,
    queryGet,
    runSql,
    transaction,
    getPersistHealth,
    assertPersistable,
    closePool,
    sanitizeErrorMessage
} = require('./db-pool');
const {
    encryptToken,
    decryptToken,
    isEncrypted,
    getEncryptionKey
} = require('../utils/token-crypto');


// ─── Versioned Migrations ───────────────────────────────────

const MIGRATION_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Ensures the schema_migrations table exists.
 */
async function ensureMigrationsTable(client = null) {
    await query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `, [], client);
}

/**
 * Returns set of applied migration versions.
 */
async function getAppliedMigrations(client = null) {
    await ensureMigrationsTable(client);
    const rows = await queryAll('SELECT version FROM schema_migrations', [], client);
    return new Set(rows.map(r => r.version));
}

/**
 * Returns current schema version.
 */
async function getSchemaVersion() {
    try {
        await ensureMigrationsTable();
        const row = await queryGet('SELECT MAX(version) as v FROM schema_migrations');
        return row && row.v ? row.v : 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Applies all pending versioned SQL migrations inside transactions.
 * Uses a transaction-level advisory lock to prevent concurrent startup races.
 */
async function runMigrations() {
    return transaction(async (tx) => {
        // Advisory lock using a 64-bit integer hash to serialize migrations across concurrent nodes
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['whatsapp_automation_migrations']);

        await ensureMigrationsTable(tx.client);
        const applied = await getAppliedMigrations(tx.client);

        if (!fs.existsSync(MIGRATION_DIR)) {
            return [];
        }

        const files = fs.readdirSync(MIGRATION_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort();

        const ran = [];

        for (const file of files) {
            const match = file.match(/^(\d+)_(.+)\.sql$/);
            if (!match) continue;

            const version = parseInt(match[1], 10);
            const name = match[2].replace(/_/g, ' ');

            if (applied.has(version)) continue;

            const filePath = path.join(MIGRATION_DIR, file);
            const sql = fs.readFileSync(filePath, 'utf8');

            try {
                await tx.query(sql);
                await tx.query(
                    'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
                    [version, name]
                );
                ran.push(version);
                console.log(`   🧱 Migration ${version} applied: ${name} (${file})`);
            } catch (err) {
                const wrapped = new Error(
                    `Migration ${version} (${file}) failed: ${err.message}. ` +
                    `Refusing to start against a partially migrated database.`
                );
                wrapped.code = 'MIGRATION_FAILED';
                wrapped.detail = err.detail || err.message;
                throw wrapped;
            }
        }

        return ran;
    });
}

// ─── Initialize & Teardown ──────────────────────────────────

async function initDatabase() {
    initPool();

    // Run versioned migrations
    await runMigrations();

    // Provision bootstrap admin if configured
    await ensureBootstrapAdmin();

    // Migrate any legacy plaintext Google Calendar OAuth tokens
    try {
        const { migrated } = await migratePlaintextCalendarTokens();
        if (migrated > 0) {
            console.log(`🔐 Google Calendar: migrated ${migrated} account(s) to encrypted OAuth tokens.`);
        }
    } catch (err) {
        if (err.message && err.message.includes('TOKEN_ENCRYPTION_KEY is required in production')) {
            const countRow = await queryGet('SELECT COUNT(*)::int as cnt FROM google_calendar_accounts');
            if (countRow && countRow.cnt > 0) {
                throw err;
            }
            console.warn('⚠️  [token-crypto] TOKEN_ENCRYPTION_KEY is not set in production. Google Calendar encryption is not active.');
        } else {
            throw err;
        }
    }

    return getPool();
}

function getDb() {
    const pool = getPool();
    if (!pool) throw new Error('Database pool not initialized. Call initDatabase() first.');
    return pool;
}

async function closeDatabase() {
    await closePool();
}

// Legacy alias for compatibility with test teardowns
function stopPersistence() {
    closePool().catch(() => {});
}

// Legacy alias: in PostgreSQL, WAL / transaction commit makes writes durable immediately
function forcePersist() {
    // No-op for PostgreSQL since transactions are already durable
}

// ─── Default per-user settings ──────────────────────────────

const DEFAULT_SETTINGS = {
    chatbot_enabled: 'true',
    default_reply: 'Thank you for your message! I will get back to you shortly. 🙏',
    business_name: '',
    owner_name: '',
    ai_mode: 'ai_first',
    away_message: 'I am currently away from my phone right now. I will catch up and reply to you as soon as I am back!',
    away_mode: 'false',
    ai_enabled: 'true',
    ai_system_prompt: 'You are an intelligent AI replying on WhatsApp on behalf of your owner.\n\nGuidelines:\n- Talk naturally, casually, and helpfully just like a real person chatting on WhatsApp.\n- Keep replies brief (1-3 sentences max) and conversational.\n- Do NOT sound like a rigid corporate robot.\n- If asked personal questions or specific plans you don\'t know, politely say you\'ll pass the message to the owner.',
    gemini_api_key: '',
    business_website: '',
    business_description: '',
    business_industry: '',
    business_target_customers: '',
    business_offers: '',
    business_currency: '₹',
    business_ai_profile: ''
};

async function ensureDefaultSettings(userId, client = null) {
    const existing = await queryAll('SELECT key FROM settings WHERE user_id = $1', [userId], client);
    if (existing.length > 0) return;

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await query(
            'INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO NOTHING',
            [userId, key, value],
            client
        );
    }
}

// ─── User / Account Helpers ─────────────────────────────────

async function getUserByEmail(email) {
    if (!email) return null;
    return queryGet('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [String(email).trim()]);
}

async function getUserById(id) {
    if (!id) return null;
    return queryGet('SELECT * FROM users WHERE id = $1', [id]);
}

async function countUsers() {
    const row = await queryGet('SELECT COUNT(*) as count FROM users');
    return row ? row.count : 0;
}

/**
 * Creates a user and seeds default settings inside a transaction.
 * Supports both object argument { email, passwordHash, ... } and positional arguments (email, passwordHash, role, ...).
 */
async function createUser(arg1, maybePasswordHash, maybeRole, maybeStatus) {
    let email, passwordHash, businessName, ownerName, role, status, plan, messageLimit, ruleLimit, waEnabled;
    if (typeof arg1 === 'object' && arg1 !== null) {
        ({
            email,
            passwordHash,
            businessName = '',
            ownerName = '',
            role = 'user',
            status = 'pending',
            plan = 'free',
            messageLimit = 0,
            ruleLimit = 0,
            waEnabled = 0
        } = arg1);
    } else {
        email = arg1;
        passwordHash = maybePasswordHash;
        role = maybeRole || 'user';
        status = maybeStatus || 'pending';
        businessName = '';
        ownerName = '';
        plan = 'free';
        messageLimit = 0;
        ruleLimit = 0;
        waEnabled = 0;
    }

    return transaction(async (tx) => {
        const res = await tx.query(
            `INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan, message_limit, rule_limit, wa_enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                email.toLowerCase().trim(),
                passwordHash,
                businessName,
                ownerName,
                role,
                status,
                plan,
                messageLimit,
                ruleLimit,
                waEnabled ? 1 : 0
            ]
        );

        const user = res.rows[0];
        await ensureDefaultSettings(user.id, tx.client);
        return user;
    });
}

async function ensureBootstrapAdmin() {
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    if (!bootstrapEmail) return;

    const existing = await getUserByEmail(bootstrapEmail);
    if (existing) {
        if (existing.role !== 'admin') {
            await runSql("UPDATE users SET role = 'admin' WHERE id = $1", [existing.id]);
            console.log(`[bootstrap] Promoted ${bootstrapEmail} to admin (id=${existing.id}).`);
        }
        return;
    }

    const { randomBytes } = require('crypto');
    const placeholder = '$bootstrap$' + randomBytes(30).toString('hex');
    await transaction(async (tx) => {
        const res = await tx.query(
            `INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan)
             VALUES ($1, $2, 'Admin', 'Admin', 'admin', 'active', 'free')
             RETURNING id`,
            [bootstrapEmail, placeholder]
        );
        const newId = res.rows[0].id;
        await ensureDefaultSettings(newId, tx.client);
    });
    console.log(`[bootstrap] Created admin account for ${bootstrapEmail}. Set a password via change-password.`);
}

function isDuplicateEmailError(err) {
    if (!err) return false;
    const msg = String(err.message || '');
    return err.code === '23505' || /users_email_key|UNIQUE constraint failed: users\.email/i.test(msg);
}

async function touchLastLogin(id) {
    return runSql('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
}

async function listUsers() {
    return queryAll(
        'SELECT id, email, business_name, owner_name, role, status, plan, message_limit, rule_limit, wa_enabled, created_at, last_login_at, password_changed_at, auth_version FROM users ORDER BY created_at DESC'
    );
}

async function updateUser(id, fields) {
    const allowed = ['business_name', 'owner_name', 'status', 'plan', 'message_limit', 'rule_limit', 'role', 'password_hash', 'wa_enabled'];
    const sets = [];
    const params = [];
    let idx = 1;

    const camelToSnake = {
        passwordHash: 'password_hash',
        businessName: 'business_name',
        ownerName: 'owner_name',
        waEnabled: 'wa_enabled',
        messageLimit: 'message_limit',
        ruleLimit: 'rule_limit'
    };

    for (const [rawKey, value] of Object.entries(fields)) {
        const key = camelToSnake[rawKey] || rawKey;
        if (allowed.includes(key)) {
            if (key === 'password_hash') {
                sets.push(`password_hash = $${idx++}`, 'password_changed_at = CURRENT_TIMESTAMP', 'auth_version = COALESCE(auth_version, 1) + 1');
                params.push(value);
                continue;
            }
            sets.push(`${key} = $${idx++}`);
            params.push(key === 'wa_enabled' ? (value ? 1 : 0) : value);
        }
    }

    if (sets.length === 0) return getUserById(id);

    params.push(id);
    await runSql(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, params);
    return getUserById(id);
}

async function incrementAuthVersion(id) {
    await runSql('UPDATE users SET auth_version = COALESCE(auth_version, 1) + 1 WHERE id = $1', [id]);
    return getUserById(id);
}

async function updateUserPassword(id, passwordHash) {
    return updateUser(id, { password_hash: passwordHash });
}

/**
 * Wipes every row belonging to a user across all tenant tables, then the user itself — in one transaction.
 */
async function deleteUserCascade(id) {
    const tables = [
        'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
        'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
        'appointments', 'availability_settings',
        'google_calendar_synced_events', 'google_calendar_accounts'
    ];

    return transaction(async (tx) => {
        let totalDeleted = 0;
        for (const t of tables) {
            const res = await tx.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]);
            totalDeleted += res.rowCount || 0;
        }
        const userRes = await tx.query('DELETE FROM users WHERE id = $1', [id]);
        totalDeleted += userRes.rowCount || 0;
        return { changes: totalDeleted };
    });
}

async function countOrphanedRows(userId) {
    const tables = [
        'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
        'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
        'appointments', 'availability_settings',
        'google_calendar_synced_events', 'google_calendar_accounts'
    ];

    let total = 0;
    const byTable = {};
    for (const t of tables) {
        const row = await queryGet(`SELECT COUNT(*) as count FROM ${t} WHERE user_id = $1`, [userId]);
        const n = row ? row.count : 0;
        byTable[t] = n;
        total += n;
    }
    return { total, byTable };
}

async function deleteUserAccountOnly(id) {
    return runSql('DELETE FROM users WHERE id = $1', [id]);
}

async function getUserStats(userId) {
    const messages = (await queryGet('SELECT COUNT(*) as count FROM messages WHERE user_id = $1', [userId])).count;
    const messagesThisMonth = (await queryGet(
        "SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND direction = 'outgoing' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)",
        [userId]
    )).count;
    const contacts = (await queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = $1', [userId])).count;
    const leads = (await queryGet('SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = $1', [userId])).count;
    const activeRules = (await queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = $1 AND is_active = 1', [userId])).count;
    const openDeals = (await queryGet(
        "SELECT COUNT(*) as count FROM crm_deals WHERE user_id = $1 AND stage IN ('new','contacted','qualified','proposal','negotiation')",
        [userId]
    )).count;
    const pipelineValue = (await queryGet(
        "SELECT COALESCE(SUM(deal_value), 0) as total FROM crm_deals WHERE user_id = $1 AND stage IN ('new','contacted','qualified','proposal','negotiation')",
        [userId]
    )).total;

    return { messages, messagesThisMonth, contacts, leads, activeRules, openDeals, pipelineValue };
}

async function getPlatformStats() {
    const totalUsers = (await queryGet('SELECT COUNT(*) as count FROM users')).count;
    const activeUsers = (await queryGet("SELECT COUNT(*) as count FROM users WHERE status = 'active'")).count;
    const pendingUsers = (await queryGet("SELECT COUNT(*) as count FROM users WHERE status = 'pending'")).count;
    const suspendedUsers = (await queryGet("SELECT COUNT(*) as count FROM users WHERE status = 'suspended'")).count;
    const totalMessages = (await queryGet('SELECT COUNT(*) as count FROM messages')).count;
    const totalContacts = (await queryGet('SELECT COUNT(*) as count FROM contacts')).count;
    const totalDeals = (await queryGet('SELECT COUNT(*) as count FROM crm_deals')).count;
    const signupsByDay = await queryAll(`
        SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count
        FROM users
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
        GROUP BY to_char(created_at, 'YYYY-MM-DD')
        ORDER BY day ASC
    `);

    return { totalUsers, activeUsers, pendingUsers, suspendedUsers, totalMessages, totalContacts, totalDeals, signupsByDay };
}

async function getMonthlyOutgoingCount(userId) {
    const row = await queryGet(
        "SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND direction = 'outgoing' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)",
        [userId]
    );
    return row ? row.count : 0;
}

// ─── Contact Helpers ────────────────────────────────────────

async function getContacts(userId, search = '', label = '', { limit = null, offset = 0 } = {}) {
    let sql = 'SELECT * FROM contacts WHERE user_id = $1';
    const params = [userId];
    let idx = 2;

    if (search) {
        sql += ` AND (name ILIKE $${idx} OR phone ILIKE $${idx + 1})`;
        params.push(`%${search}%`, `%${search}%`);
        idx += 2;
    }
    if (label) {
        sql += ` AND label = $${idx++}`;
        params.push(label);
    }
    sql += ' ORDER BY updated_at DESC';
    if (limit !== null) {
        sql += ` LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(limit, offset);
    }
    return queryAll(sql, params);
}

async function countContacts(userId) {
    const row = await queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = $1', [userId]);
    return row ? row.count : 0;
}

async function getContactByPhone(userId, phone) {
    return queryGet('SELECT * FROM contacts WHERE user_id = $1 AND phone = $2', [userId, phone]);
}

async function getContactsByIds(userId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const clean = [];
    for (const raw of ids) {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (Number.isSafeInteger(n) && n > 0) clean.push(n);
        if (clean.length >= 1000) break;
    }
    if (clean.length === 0) return [];

    const unique = [...new Set(clean)];
    return queryAll(
        'SELECT * FROM contacts WHERE user_id = $1 AND id = ANY($2::int[])',
        [userId, unique]
    );
}

async function upsertContact(userId, phone, name = '', label = '', notes = '') {
    const res = await query(
        `INSERT INTO contacts (user_id, phone, name, label, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, phone) DO UPDATE SET
             name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
             label = COALESCE(NULLIF(EXCLUDED.label, ''), contacts.label),
             notes = COALESCE(NULLIF(EXCLUDED.notes, ''), contacts.notes),
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, phone, name, label, notes]
    );
    return res.rows[0];
}

async function bulkUpsertContacts(userId, rows) {
    const { tryNormalizePhone, sanitizeSpreadsheetCell, LIMITS } = require('../utils/validate');
    let imported = 0, updated = 0, skipped = 0;
    const errors = [];
    const pushError = (row, reason) => {
        if (errors.length < 100) errors.push({ row, reason });
    };

    return transaction(async (tx) => {
        const countRow = await tx.query('SELECT COUNT(*) as count FROM contacts WHERE user_id = $1', [userId]);
        let existingCount = countRow.rows[0].count;
        const seenInThisFile = new Set();

        for (let idx = 0; idx < rows.length; idx++) {
            const r = rows[idx];
            const rowNum = idx + 1;
            const rawPhone = (r.phone === undefined || r.phone === null) ? '' : String(r.phone).trim();
            if (!rawPhone) {
                skipped++;
                pushError(rowNum, 'Missing phone number');
                continue;
            }

            const cleanPhone = tryNormalizePhone(rawPhone);
            if (!cleanPhone) {
                skipped++;
                pushError(rowNum, `"${rawPhone.slice(0, 40)}" is not a valid phone number`);
                continue;
            }

            const isRepeatInFile = seenInThisFile.has(cleanPhone);
            seenInThisFile.add(cleanPhone);

            const name = sanitizeSpreadsheetCell(String(r.name ?? '').trim().slice(0, LIMITS.CONTACT_NAME));
            const label = sanitizeSpreadsheetCell(String(r.label ?? '').trim().slice(0, LIMITS.CONTACT_LABEL));
            const notes = sanitizeSpreadsheetCell(String(r.notes ?? '').trim().slice(0, LIMITS.CONTACT_NOTES));

            const existing = await tx.query(
                'SELECT id FROM contacts WHERE user_id = $1 AND phone = $2',
                [userId, cleanPhone]
            );

            if (existing.rows.length > 0) {
                await tx.query(
                    `UPDATE contacts SET
                        name = COALESCE(NULLIF($1, ''), name),
                        label = COALESCE(NULLIF($2, ''), label),
                        notes = COALESCE(NULLIF($3, ''), notes),
                        updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $4 AND phone = $5`,
                    [name, label, notes, userId, cleanPhone]
                );
                if (!isRepeatInFile) updated++;
            } else {
                if (existingCount >= LIMITS.MAX_CONTACTS_PER_USER) {
                    skipped++;
                    pushError(rowNum, `Contact limit reached (${LIMITS.MAX_CONTACTS_PER_USER}). Delete some contacts first.`);
                    continue;
                }
                await tx.query(
                    'INSERT INTO contacts (user_id, phone, name, label, notes) VALUES ($1, $2, $3, $4, $5)',
                    [userId, cleanPhone, name, label, notes]
                );
                existingCount++;
                imported++;
            }
        }

        return { imported, updated, skipped, errors, total: rows.length };
    });
}

async function markContactOutreached(userId, phone) {
    return runSql(
        'UPDATE contacts SET last_outreach_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND phone = $2',
        [userId, phone]
    );
}

async function deleteContact(userId, id) {
    return runSql('DELETE FROM contacts WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ─── Message Helpers ────────────────────────────────────────

async function logMessage(userId, { waMessageId, phone, contactName, direction, messageType, body, status, templateName }) {
    const res = await query(
        `INSERT INTO messages (user_id, wa_message_id, phone, contact_name, direction, message_type, body, status, template_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [userId, waMessageId || null, phone, contactName || '', direction, messageType || 'text', body || '', status || 'sent', templateName || null]
    );
    return res.rows[0];
}

async function logOutgoingMessageIdempotent(userId, idempotencyKey, fields) {
    const existing = await queryGet(
        'SELECT * FROM messages WHERE user_id = $1 AND idempotency_key = $2',
        [userId, idempotencyKey]
    );
    if (existing) return { created: false, row: existing };

    try {
        const res = await query(
        `INSERT INTO messages (user_id, idempotency_key, phone, contact_name, direction, message_type, body, status, template_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                userId, idempotencyKey, fields.phone, fields.contactName || '',
                fields.direction || 'outgoing', fields.messageType || 'text',
                fields.body || '', fields.status || 'sent', fields.templateName || null
            ]
        );
        return { created: true, row: res.rows[0] };
    } catch (err) {
        if (err.code === '23505' || /UNIQUE constraint failed|idx_messages_user_idempotency_key/i.test(String(err.message))) {
            const row = await queryGet('SELECT * FROM messages WHERE user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey]);
            if (row) return { created: false, row };
        }
        throw err;
    }
}

async function findMessageByIdempotencyKey(userId, idempotencyKey) {
    return queryGet(
        'SELECT * FROM messages WHERE user_id = $1 AND idempotency_key = $2',
        [userId, idempotencyKey]
    );
}

async function clearMessages(userId) {
    return runSql('DELETE FROM messages WHERE user_id = $1', [userId]);
}

/**
 * Updates an outgoing message's delivery status from a WhatsApp ack event.
 *
 * Status order (never downgrade): sent → delivered → read
 *   0 = pending/error, 1 = sent (server ack), 2 = delivered, 3 = read
 *
 * The WHERE clause enforces two invariants atomically:
 *   1. Tenant isolation: user_id must match.
 *   2. No downgrade: only advance to a higher status than the current one.
 *      We map ack integers to string names and store an ordinal in a CASE
 *      expression so the comparison is a simple string equality guard.
 *
 * Returns true if a row was updated, false if the message was not found,
 * belongs to a different tenant, or was already at an equal/higher status.
 */
async function updateMessageAckStatus(userId, waMessageId, ackStatus) {
    if (!waMessageId || typeof waMessageId !== 'string') return false;

    // Map WhatsApp ack integer → status string and ordinal rank
    // Source: node_modules/whatsapp-web.js/src/util/Constants.js MessageAck enum
    //   -1 = ACK_ERROR   (don't touch — error state)
    //    0 = ACK_PENDING  (not yet delivered — don't touch)
    //    1 = ACK_SERVER   (delivered to WhatsApp server → 'sent')
    //    2 = ACK_DEVICE   (delivered to recipient device → 'delivered')
    //    3 = ACK_READ     (opened/read by recipient → 'read')
    //    4 = ACK_PLAYED   (voice/video played by recipient → 'read')
    const ACK_MAP = {
        [-1]: null,    // error — don't touch status
        0:    null,    // pending — don't touch status
        1: { status: 'sent',      rank: 1 },
        2: { status: 'delivered', rank: 2 },
        3: { status: 'read',      rank: 3 },
        4: { status: 'read',      rank: 3 }  // played (voice) = read
    };
    const mapped = ACK_MAP[ackStatus];
    if (!mapped) return false;

    // Only update if the new rank is strictly higher than the current rank.
    // NULL/unknown current status is treated as rank 0 (always upgradable).
    const res = await query(
        `UPDATE messages SET status = $1
         WHERE user_id = $2
           AND wa_message_id = $3
           AND direction = 'outgoing'
           AND CASE status
                 WHEN 'read'      THEN 3
                 WHEN 'delivered' THEN 2
                 WHEN 'sent'      THEN 1
                 ELSE 0
               END < $4`,
        [mapped.status, userId, waMessageId, mapped.rank]
    );
    return (res.rowCount || 0) > 0;
}

async function getMessages(userId, { phone, direction, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM messages WHERE user_id = $1';
    const params = [userId];
    let idx = 2;

    if (phone) {
        sql += ` AND phone = $${idx++}`;
        params.push(phone);
    }
    if (direction) {
        sql += ` AND direction = $${idx++}`;
        params.push(direction);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    return queryAll(sql, params);
}

async function countMessages(userId, { phone, direction } = {}) {
    let sql = 'SELECT COUNT(*) as count FROM messages WHERE user_id = $1';
    const params = [userId];
    let idx = 2;

    if (phone) { sql += ` AND phone = $${idx++}`; params.push(phone); }
    if (direction) { sql += ` AND direction = $${idx++}`; params.push(direction); }

    const row = await queryGet(sql, params);
    return row ? row.count : 0;
}

async function getConversation(userId, phone, { limit = null } = {}) {
    if (limit === null) {
        return queryAll(
            'SELECT * FROM messages WHERE user_id = $1 AND phone = $2 ORDER BY created_at ASC',
            [userId, phone]
        );
    }
    const rows = await queryAll(
        'SELECT * FROM messages WHERE user_id = $1 AND phone = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
        [userId, phone, limit]
    );
    return rows.reverse();
}

// ─── Chatbot Rule Helpers ───────────────────────────────────

async function getChatbotRules(userId, activeOnly = false) {
    let sql = 'SELECT * FROM chatbot_rules WHERE user_id = $1';
    const params = [userId];
    if (activeOnly) sql += ' AND is_active = 1';
    sql += ' ORDER BY priority DESC, id ASC';
    return queryAll(sql, params);
}

async function countChatbotRules(userId) {
    const row = await queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = $1', [userId]);
    return row ? row.count : 0;
}

async function createChatbotRule(userId, triggerKeyword, matchType, responseText, priority = 0) {
    const res = await query(
        `INSERT INTO chatbot_rules (user_id, trigger_keyword, match_type, response_text, priority)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, triggerKeyword, matchType, responseText, priority]
    );
    return res.rows[0];
}

async function updateChatbotRule(userId, id, fields) {
    const allowed = ['trigger_keyword', 'match_type', 'response_text', 'priority', 'is_active'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = $${idx++}`);
            params.push(key === 'is_active' ? (value ? 1 : 0) : value);
        }
    }
    if (sets.length === 0) return null;

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    return runSql(`UPDATE chatbot_rules SET ${sets.join(', ')} WHERE user_id = $${idx++} AND id = $${idx++}`, params);
}

async function deleteChatbotRule(userId, id) {
    return runSql('DELETE FROM chatbot_rules WHERE user_id = $1 AND id = $2', [userId, id]);
}

async function incrementRuleHitCount(userId, id) {
    return runSql('UPDATE chatbot_rules SET hit_count = hit_count + 1 WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ─── Scheduled Message Helpers ──────────────────────────────

async function getScheduledMessages(userId, status = null) {
    let sql = 'SELECT * FROM scheduled_messages WHERE user_id = $1';
    const params = [userId];
    if (status) {
        sql += ' AND status = $2';
        params.push(status);
    }
    sql += ' ORDER BY scheduled_at ASC';
    return queryAll(sql, params);
}

async function createScheduledMessage(userId, phone, body, scheduledAt) {
    const res = await query(
        `INSERT INTO scheduled_messages (user_id, phone, body, scheduled_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, phone, body, scheduledAt]
    );
    return res.rows[0];
}

async function countPendingScheduledMessages(userId) {
    const row = await queryGet(
        "SELECT COUNT(*) as count FROM scheduled_messages WHERE user_id = $1 AND status = 'pending'",
        [userId]
    );
    return row ? row.count : 0;
}

async function updateScheduledMessageStatus(id, status, errorMessage = null) {
    return runSql(
        `UPDATE scheduled_messages SET status = $1, error_message = $2,
            sent_at = CASE WHEN $3 = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END
         WHERE id = $4`,
        [status, errorMessage, status, id]
    );
}

async function getPendingScheduledMessages() {
    return queryAll(
        `SELECT * FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP
         ORDER BY scheduled_at ASC`
    );
}

/**
 * Atomically takes ownership of one pending job using compare-and-swap.
 * Returns true only for the caller that won the claim.
 */
async function claimScheduledMessage(id) {
    const res = await query(
        "UPDATE scheduled_messages SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING id",
        [id]
    );
    return (res.rowCount || res.rows.length) === 1;
}

async function reclaimStuckScheduledMessages(olderThanMinutes = 15) {
    const rows = await queryAll(
        `SELECT id, user_id, phone FROM scheduled_messages
         WHERE status = 'sending'
           AND scheduled_at <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')`,
        [olderThanMinutes]
    );
    if (rows.length === 0) return [];

    await runSql(
        `UPDATE scheduled_messages
            SET status = 'failed',
                error_message = 'Interrupted while sending (server restarted). Delivery is unconfirmed — check WhatsApp before resending.'
          WHERE status = 'sending'
            AND scheduled_at <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')`,
        [olderThanMinutes]
    );
    return rows;
}

async function cancelScheduledMessage(userId, id) {
    return runSql(
        "UPDATE scheduled_messages SET status = 'cancelled' WHERE user_id = $1 AND id = $2 AND status = 'pending'",
        [userId, id]
    );
}

async function createAppointmentReminder(userId, appointmentId, phone, body, scheduledAt, reminderType) {
    const res = await query(
        `INSERT INTO scheduled_messages (user_id, appointment_id, phone, body, scheduled_at, reminder_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (appointment_id, reminder_type) WHERE status = 'pending' AND appointment_id IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [userId, appointmentId, phone, body, scheduledAt, reminderType]
    );
    return res.rows[0] || null;
}

async function cancelAppointmentReminders(userId, appointmentId) {
    return runSql(
        "UPDATE scheduled_messages SET status = 'cancelled' WHERE user_id = $1 AND appointment_id = $2 AND status = 'pending'",
        [userId, appointmentId]
    );
}

async function getAppointmentReminders(userId, appointmentId) {
    return queryAll(
        'SELECT * FROM scheduled_messages WHERE user_id = $1 AND appointment_id = $2 ORDER BY scheduled_at ASC',
        [userId, appointmentId]
    );
}

// ─── Durable outreach jobs ──────────────────────────────────────────────
async function createOutreachJob(userId, id, messageTemplate, contacts) {
    return transaction(async (tx) => {
        await tx.query(`INSERT INTO outreach_jobs (id,user_id,message_template,status,total)
                        VALUES ($1,$2,$3,'running',$4)`, [id, userId, messageTemplate, contacts.length]);
        for (const contact of contacts) {
            if (contact.id) {
                const ownedContact = await tx.query('SELECT id FROM contacts WHERE id=$1 AND user_id=$2', [contact.id, userId]);
                if (!ownedContact.rows[0]) {
                    const err = new Error('Outreach recipients must belong to the job owner');
                    err.status = 403;
                    throw err;
                }
            }
            await tx.query(`INSERT INTO outreach_recipients (job_id,user_id,contact_id,phone,contact_name)
                            VALUES ($1,$2,$3,$4,$5)`, [id, userId, contact.id || null, contact.phone, contact.name || '']);
        }
        return getOutreachJob(userId, id, tx.client);
    });
}

async function getOutreachJob(userId, id, client = null) {
    const job = await queryGet('SELECT * FROM outreach_jobs WHERE id=$1 AND user_id=$2', [id, userId], client);
    if (!job) return null;
    const results = await queryAll(`SELECT phone, contact_name AS name, status, reason FROM outreach_recipients
                                    WHERE job_id=$1 AND user_id=$2 ORDER BY id`, [id, userId], client);
    const counts = results.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {});
    return { ...job, results, sent: counts.sent || 0, failed: counts.failed || 0,
        skipped: (counts.skipped || 0) + (counts.unknown || 0), cancelRequested: job.status === 'cancel_requested' };
}

async function countRunningOutreachJobs(userId = null) {
    const sql = userId ? "SELECT COUNT(*) AS count FROM outreach_jobs WHERE user_id=$1 AND status IN ('running','cancel_requested')"
        : "SELECT COUNT(*) AS count FROM outreach_jobs WHERE status IN ('running','cancel_requested')";
    const row = await queryGet(sql, userId ? [userId] : []);
    return Number(row?.count || 0);
}

async function requestOutreachCancellation(userId, id) {
    const result = await runSql("UPDATE outreach_jobs SET status='cancel_requested' WHERE id=$1 AND user_id=$2 AND status='running'", [id, userId]);
    return result.changes > 0;
}

async function recoverInterruptedOutreachJobs() {
    return transaction(async (tx) => {
        const jobs = await tx.query("SELECT id,user_id FROM outreach_jobs WHERE status IN ('running','cancel_requested')");
        for (const job of jobs.rows) {
            await tx.query("UPDATE outreach_recipients SET status='unknown', reason='Server restarted before delivery could be confirmed' WHERE job_id=$1 AND user_id=$2 AND status='sending'", [job.id, job.user_id]);
            await tx.query("UPDATE outreach_recipients SET status='skipped', reason='Server restarted before this recipient was sent' WHERE job_id=$1 AND user_id=$2 AND status='pending'", [job.id, job.user_id]);
            await tx.query("UPDATE outreach_jobs SET status='interrupted', finished_at=CURRENT_TIMESTAMP, error='Interrupted by server restart; unsent recipients were not retried' WHERE id=$1 AND user_id=$2", [job.id, job.user_id]);
        }
        return jobs.rows.length;
    });
}

// ─── Product / Catalog Helpers ──────────────────────────────

async function getProducts(userId, activeOnly = false) {
    let sql = 'SELECT * FROM products WHERE user_id = $1';
    const params = [userId];
    if (activeOnly) sql += ' AND is_active = 1';
    sql += ' ORDER BY category ASC, name ASC';
    return queryAll(sql, params);
}

async function countProducts(userId) {
    const row = await queryGet('SELECT COUNT(*) as count FROM products WHERE user_id = $1', [userId]);
    return row ? row.count : 0;
}

async function createProduct(userId, { name, description = '', price = '', category = '', url = '' }) {
    const res = await query(
        `INSERT INTO products (user_id, name, description, price, category, url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, name, description, price, category, url]
    );
    return res.rows[0];
}

async function updateProduct(userId, id, fields) {
    const allowed = ['name', 'description', 'price', 'category', 'url', 'is_active'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = $${idx++}`);
            params.push(key === 'is_active' ? (value ? 1 : 0) : value);
        }
    }
    if (sets.length === 0) return queryGet('SELECT * FROM products WHERE id = $1 AND user_id = $2', [id, userId]);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    await runSql(`UPDATE products SET ${sets.join(', ')} WHERE user_id = $${idx++} AND id = $${idx++}`, params);
    return queryGet('SELECT * FROM products WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function deleteProduct(userId, id) {
    return runSql('DELETE FROM products WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ─── CRM Deal Helpers ───────────────────────────────────────

const CRM_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

async function getCrmDeals(userId, { stage = '', leadTemp = '' } = {}) {
    let sql = `
        SELECT cd.*,
               la.interest_status, la.interest_score, la.priority, la.summary,
               la.issue_category, la.next_action, la.sentiment
        FROM crm_deals cd
        LEFT JOIN lead_analysis la ON la.phone = cd.phone AND la.user_id = cd.user_id
        WHERE cd.user_id = $1`;
    const params = [userId];
    let idx = 2;
    if (stage) { sql += ` AND cd.stage = $${idx++}`; params.push(stage); }
    if (leadTemp) { sql += ` AND cd.lead_temp = $${idx++}`; params.push(leadTemp); }
    sql += ' ORDER BY cd.deal_value DESC, cd.updated_at DESC';
    return queryAll(sql, params);
}

async function getCrmDealByPhone(userId, phone) {
    return queryGet('SELECT * FROM crm_deals WHERE user_id = $1 AND phone = $2', [userId, phone]);
}

async function getCrmDealById(userId, id) {
    return queryGet('SELECT * FROM crm_deals WHERE user_id = $1 AND id = $2', [userId, id]);
}

async function createCrmDeal(userId, { phone, contactName = '', stage = 'new', dealValue = 0, productInterest = '', source = 'whatsapp', notes = '', nextFollowupAt = null, interested_project_id = null }) {
    if (!CRM_STAGES.includes(stage)) stage = 'new';
    const res = await query(
        `INSERT INTO crm_deals (user_id, phone, contact_name, stage, deal_value, product_interest, source, notes, next_followup_at, interested_project_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [userId, phone, contactName, stage, dealValue || 0, productInterest, source, notes, nextFollowupAt, interested_project_id || null]
    );
    return res.rows[0];
}

async function updateCrmDeal(userId, id, fields) {
    const allowed = ['contact_name', 'stage', 'deal_value', 'product_interest', 'notes', 'next_followup_at',
        'lead_type', 'budget_min', 'budget_max', 'preferred_bhk', 'preferred_locality', 'timeline',
        'financing_needed', 'site_visit_pref', 'interested_project_id'];
    const sets = [];
    const params = [];
    let idx = 1;

    if (fields.interested_project_id != null && !(await getProjectById(userId, fields.interested_project_id))) {
        const err = new Error('Selected project was not found'); err.code = 'PROJECT_NOT_FOUND'; throw err;
    }
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed.includes(key)) continue;
        if (key === 'stage') {
            if (!CRM_STAGES.includes(value)) continue;
            sets.push(`stage = $${idx++}`, 'stage_changed_at = CURRENT_TIMESTAMP');
            params.push(value);
            continue;
        }
        sets.push(`${key} = $${idx++}`);
        params.push(value);
    }
    if (sets.length === 0) return getCrmDealById(userId, id);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    await runSql(`UPDATE crm_deals SET ${sets.join(', ')} WHERE user_id = $${idx++} AND id = $${idx++}`, params);
    return getCrmDealById(userId, id);
}

async function deleteCrmDeal(userId, id) {
    return runSql('DELETE FROM crm_deals WHERE user_id = $1 AND id = $2', [userId, id]);
}

async function aiUpsertCrmDeal(userId, phone, {
    contactName = '', suggestedStage = 'new', estimatedValue = 0, productInterest = '',
    leadType = null, budgetMin = null, budgetMax = null, preferredBhk = null,
    preferredLocality = null, timeline = null, financingNeeded = null,
    siteVisitPref = null, interestedProjectId = null, leadTemp = null,
    leadTempReason = null
}) {
    if (!CRM_STAGES.includes(suggestedStage)) suggestedStage = 'new';
    // A bare FK only proves the project exists. This scoped lookup proves it
    // belongs to the deal's tenant before AI output can link the two records.
    if (interestedProjectId != null && !(await getProjectById(userId, interestedProjectId))) {
        interestedProjectId = null;
    }
    const existing = await getCrmDealByPhone(userId, phone);

    if (!existing) {
        const deal = await createCrmDeal(userId, {
            phone,
            contactName,
            stage: suggestedStage,
            dealValue: estimatedValue || 0,
            productInterest,
            source: 'whatsapp (AI)'
        });
        await runSql(
            'UPDATE crm_deals SET ai_suggested_stage = $1, ai_estimated_value = $2 WHERE user_id = $3 AND id = $4',
            [suggestedStage, estimatedValue || 0, userId, deal.id]
        );
        await addCrmActivity(
            userId,
            phone,
            'ai',
            `AI created this deal — suggested stage: ${suggestedStage}${estimatedValue ? `, estimated value: ${estimatedValue}` : ''}${productInterest ? `, product: ${productInterest}` : ''}`
        );
        await updateAiQualificationFields(userId, phone, {
            leadType, budgetMin, budgetMax, preferredBhk, preferredLocality,
            timeline, financingNeeded, siteVisitPref, interestedProjectId
        });
        await updateAiTemperatureFields(userId, phone, leadTemp, leadTempReason);
        return getCrmDealById(userId, deal.id);
    }

    await runSql(
        `UPDATE crm_deals SET
            contact_name       = COALESCE(NULLIF($1, ''), contact_name),
            product_interest   = COALESCE(NULLIF($2, ''), product_interest),
            ai_suggested_stage = $3,
            ai_estimated_value = $4,
            deal_value         = CASE WHEN deal_value = 0 AND $5 > 0 THEN $6 ELSE deal_value END,
            updated_at         = CURRENT_TIMESTAMP
         WHERE user_id = $7 AND phone = $8`,
        [contactName, productInterest, suggestedStage, estimatedValue || 0, estimatedValue || 0, estimatedValue || 0, userId, phone]
    );
    await updateAiQualificationFields(userId, phone, {
        leadType, budgetMin, budgetMax, preferredBhk, preferredLocality,
        timeline, financingNeeded, siteVisitPref, interestedProjectId
    });
    await updateAiTemperatureFields(userId, phone, leadTemp, leadTempReason);
    return getCrmDealByPhone(userId, phone);
}

async function updateAiTemperatureFields(userId, phone, leadTemp, leadTempReason) {
    if (!['HOT', 'WARM', 'COLD'].includes(leadTemp)) return;
    return runSql(
        `UPDATE crm_deals SET lead_temp = $1,
            lead_temp_reason = COALESCE($2, lead_temp_reason),
            updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3 AND phone = $4`,
        [leadTemp, leadTempReason, userId, phone]
    );
}

/** Merge extracted details without replacing known values with null/unknown AI output. */
async function updateAiQualificationFields(userId, phone, fields) {
    return runSql(
        `UPDATE crm_deals SET
            lead_type = COALESCE($1, lead_type),
            budget_min = COALESCE($2, budget_min),
            budget_max = COALESCE($3, budget_max),
            preferred_bhk = COALESCE($4, preferred_bhk),
            preferred_locality = COALESCE($5, preferred_locality),
            timeline = COALESCE($6, timeline),
            financing_needed = COALESCE($7, financing_needed),
            site_visit_pref = COALESCE($8, site_visit_pref),
            interested_project_id = COALESCE($9, interested_project_id),
            updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $10 AND phone = $11`,
        [fields.leadType, fields.budgetMin, fields.budgetMax, fields.preferredBhk,
         fields.preferredLocality, fields.timeline, fields.financingNeeded,
         fields.siteVisitPref, fields.interestedProjectId, userId, phone]
    );
}

async function getCrmStats(userId) {
    const openStages = "('new', 'contacted', 'qualified', 'proposal', 'negotiation')";
    const openDeals = (await queryGet(`SELECT COUNT(*) as count FROM crm_deals WHERE user_id = $1 AND stage IN ${openStages}`, [userId])).count;
    const pipelineValue = (await queryGet(`SELECT COALESCE(SUM(deal_value), 0) as total FROM crm_deals WHERE user_id = $1 AND stage IN ${openStages}`, [userId])).total;
    const wonDeals = (await queryGet("SELECT COUNT(*) as count FROM crm_deals WHERE user_id = $1 AND stage = 'won'", [userId])).count;
    const wonValue = (await queryGet("SELECT COALESCE(SUM(deal_value), 0) as total FROM crm_deals WHERE user_id = $1 AND stage = 'won'", [userId])).total;
    const followupsDue = (await queryGet(`SELECT COUNT(*) as count FROM crm_deals
                                          WHERE user_id = $1 AND next_followup_at IS NOT NULL
                                            AND next_followup_at <= CURRENT_TIMESTAMP
                                            AND stage IN ${openStages}`, [userId])).count;
    return { openDeals, pipelineValue, wonDeals, wonValue, followupsDue };
}

async function getCrmAnalytics(userId) {
    const stageBreakdown = await queryAll(`
        SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as value
        FROM crm_deals
        WHERE user_id = $1
        GROUP BY stage
    `, [userId]);
    const interestMix = await queryAll(`
        SELECT interest_status, COUNT(*) as count
        FROM lead_analysis
        WHERE user_id = $1
        GROUP BY interest_status
    `, [userId]);
    const messagesByDay = await queryAll(`
        SELECT to_char(created_at, 'YYYY-MM-DD') as day,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
               SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
        FROM messages
        WHERE user_id = $1 AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        GROUP BY to_char(created_at, 'YYYY-MM-DD')
        ORDER BY day ASC
    `, [userId]);
    return { stageBreakdown, interestMix, messagesByDay };
}

async function addCrmActivity(userId, phone, type, content) {
    const res = await query(
        `INSERT INTO crm_activities (user_id, phone, type, content)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, phone, type || 'note', content || '']
    );
    return res.rows[0];
}

async function getCrmActivities(userId, phone, limit = 50) {
    return queryAll(
        'SELECT * FROM crm_activities WHERE user_id = $1 AND phone = $2 ORDER BY created_at DESC LIMIT $3',
        [userId, phone, limit]
    );
}

// ─── Lead Analysis Helpers ──────────────────────────────────

async function saveLeadAnalysis(userId, phone, analysis) {
    const {
        contactName = '', summary = '', interestStatus = 'unclear', interestScore = 0,
        sentiment = 'neutral', issueCategory = '', issues = [], priority = 'low',
        priorityReason = '', nextAction = '', messageCount = 0
    } = analysis;

    const res = await query(
        `INSERT INTO lead_analysis
            (user_id, phone, contact_name, summary, interest_status, interest_score, sentiment,
             issue_category, issues, priority, priority_reason, next_action, message_count, last_analyzed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, phone) DO UPDATE SET
            contact_name     = EXCLUDED.contact_name,
            summary          = EXCLUDED.summary,
            interest_status  = EXCLUDED.interest_status,
            interest_score   = EXCLUDED.interest_score,
            sentiment        = EXCLUDED.sentiment,
            issue_category   = EXCLUDED.issue_category,
            issues           = EXCLUDED.issues,
            priority         = EXCLUDED.priority,
            priority_reason  = EXCLUDED.priority_reason,
            next_action      = EXCLUDED.next_action,
            message_count    = EXCLUDED.message_count,
            last_analyzed_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, phone, contactName, summary, interestStatus, interestScore, sentiment,
         issueCategory, JSON.stringify(issues), priority, priorityReason, nextAction, messageCount]
    );
    return res.rows[0];
}

async function getLeadAnalysis(userId, phone) {
    return queryGet('SELECT * FROM lead_analysis WHERE user_id = $1 AND phone = $2', [userId, phone]);
}

async function getLeadAnalyses(userId, { interestStatus = '', priority = '', leadTemp = '' } = {}) {
    let sql = `
        SELECT la.*,
               cd.stage as crm_stage,
               cd.deal_value as crm_value,
               cd.product_interest as crm_product, cd.lead_temp as crm_lead_temp
        FROM lead_analysis la
        LEFT JOIN crm_deals cd ON cd.phone = la.phone AND cd.user_id = la.user_id
        WHERE la.user_id = $1`;
    const params = [userId];
    let idx = 2;

    if (interestStatus) {
        sql += ` AND la.interest_status = $${idx++}`;
        params.push(interestStatus);
    }
    if (priority) {
        sql += ` AND la.priority = $${idx++}`;
        params.push(priority);
    }
    if (leadTemp) {
        sql += ` AND cd.lead_temp = $${idx++}`;
        params.push(leadTemp);
    }
    sql += ` ORDER BY
        CASE la.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        la.interest_score DESC,
        la.last_analyzed_at DESC`;
    return queryAll(sql, params);
}

async function deleteLeadAnalysis(userId, id) {
    return runSql('DELETE FROM lead_analysis WHERE user_id = $1 AND id = $2', [userId, id]);
}

async function getConversationPhones(userId) {
    return queryAll(`
        SELECT phone,
               MAX(contact_name) as contact_name,
               COUNT(*) as message_count,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming_count,
               MAX(created_at) as last_message_at
        FROM messages
        WHERE user_id = $1
        GROUP BY phone
        HAVING SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) > 0
        ORDER BY last_message_at DESC
    `, [userId]);
}

async function getLeadStats(userId) {
    const total = (await queryGet('SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = $1', [userId])).count;
    const interested = (await queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = $1 AND interest_status = 'interested'", [userId])).count;
    const notInterested = (await queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = $1 AND interest_status = 'not_interested'", [userId])).count;
    const highPriority = (await queryGet("SELECT COUNT(*) as count FROM lead_analysis WHERE user_id = $1 AND priority = 'high'", [userId])).count;
    return { total, interested, notInterested, highPriority };
}

// ─── Settings Helpers ───────────────────────────────────────

async function getSetting(userId, key) {
    const row = await queryGet('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, key]);
    return row ? row.value : null;
}

async function setSetting(userId, key, value) {
    return runSql(
        `INSERT INTO settings (user_id, key, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [userId, key, String(value)]
    );
}

async function getAllSettings(userId) {
    const rows = await queryAll('SELECT * FROM settings WHERE user_id = $1', [userId]);
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// ─── Google Calendar Helpers ────────────────────────────────

async function saveGoogleCalendarTokens(userId, tokens) {
    const existing = await queryGet('SELECT calendar_id, check_availability FROM google_calendar_accounts WHERE user_id = $1', [userId]);

    const encAccess = encryptToken(tokens.access_token);
    const hasRefresh = tokens.refresh_token !== undefined && tokens.refresh_token !== null && String(tokens.refresh_token).trim() !== '';
    const encRefresh = hasRefresh ? encryptToken(tokens.refresh_token) : null;

    return runSql(
        `INSERT INTO google_calendar_accounts (user_id, access_token, refresh_token, scope, token_type, expiry_date, calendar_id, check_availability)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, google_calendar_accounts.refresh_token),
            scope = EXCLUDED.scope,
            token_type = EXCLUDED.token_type,
            expiry_date = EXCLUDED.expiry_date`,
        [
            userId, encAccess, encRefresh, tokens.scope || null,
            tokens.token_type || null, tokens.expiry_date || null,
            existing ? existing.calendar_id : 'primary',
            existing ? existing.check_availability : 0
        ]
    );
}

async function getGoogleCalendarAccount(userId) {
    const row = await queryGet('SELECT * FROM google_calendar_accounts WHERE user_id = $1', [userId]);
    if (!row) return null;
    return {
        ...row,
        access_token: decryptToken(row.access_token),
        refresh_token: row.refresh_token ? decryptToken(row.refresh_token) : null
    };
}

/**
 * Idempotently migrates existing plaintext tokens in google_calendar_accounts to AES-256-GCM.
 * Validates the encryption key before modifying any rows.
 * Runs atomically inside a transaction with row-level locks (FOR UPDATE).
 * Never logs credentials.
 */
async function migratePlaintextCalendarTokens(keyOverride = null) {
    const key = getEncryptionKey(keyOverride);

    return transaction(async (tx) => {
        const result = await tx.query(
            `SELECT user_id, access_token, refresh_token
             FROM google_calendar_accounts
             WHERE access_token NOT LIKE 'enc:v1:%'
                OR (refresh_token IS NOT NULL AND refresh_token != '' AND refresh_token NOT LIKE 'enc:v1:%')
             FOR UPDATE`
        );

        const rows = result.rows || [];
        if (rows.length === 0) {
            return { migrated: 0 };
        }

        let migratedCount = 0;
        for (const row of rows) {
            const encAccess = isEncrypted(row.access_token)
                ? row.access_token
                : encryptToken(row.access_token, key);

            const encRefresh = (row.refresh_token && !isEncrypted(row.refresh_token))
                ? encryptToken(row.refresh_token, key)
                : (row.refresh_token || null);

            await tx.query(
                `UPDATE google_calendar_accounts
                 SET access_token = $1, refresh_token = $2
                 WHERE user_id = $3`,
                [encAccess, encRefresh, row.user_id]
            );
            migratedCount++;
        }

        return { migrated: migratedCount };
    });
}

async function getAllConnectedCalendarUserIds() {
    const rows = await queryAll('SELECT user_id FROM google_calendar_accounts');
    return rows.map(r => r.user_id);
}

async function deleteGoogleCalendarAccount(userId) {
    await runSql('DELETE FROM google_calendar_synced_events WHERE user_id = $1', [userId]);
    return runSql('DELETE FROM google_calendar_accounts WHERE user_id = $1', [userId]);
}

async function setCalendarAvailabilityCheck(userId, enabled) {
    return runSql('UPDATE google_calendar_accounts SET check_availability = $1 WHERE user_id = $2', [enabled ? 1 : 0, userId]);
}

async function touchCalendarLastSync(userId) {
    return runSql('UPDATE google_calendar_accounts SET last_sync_at = CURRENT_TIMESTAMP WHERE user_id = $1', [userId]);
}

async function isCalendarEventSynced(userId, eventId) {
    const row = await queryGet(
        'SELECT 1 FROM google_calendar_synced_events WHERE user_id = $1 AND event_id = $2',
        [userId, eventId]
    );
    return !!row;
}

async function markCalendarEventSynced(eventId, userId, scheduledMessageId) {
    return runSql(
        'INSERT INTO google_calendar_synced_events (user_id, event_id, scheduled_message_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, event_id) DO NOTHING',
        [userId, eventId, scheduledMessageId]
    );
}

// ─── Appointment Booking Helpers ────────────────────────────

async function getAvailabilitySettings(userId) {
    return queryGet('SELECT * FROM availability_settings WHERE user_id = $1', [userId]);
}

async function saveAvailabilitySettings(userId, { workingDays, startTime, endTime, slotDurationMinutes, bufferMinutes, timezone, bookingEnabled }) {
    return runSql(
        `INSERT INTO availability_settings (user_id, working_days, start_time, end_time, slot_duration_minutes, buffer_minutes, timezone, booking_enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
            working_days = EXCLUDED.working_days,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            slot_duration_minutes = EXCLUDED.slot_duration_minutes,
            buffer_minutes = EXCLUDED.buffer_minutes,
            timezone = EXCLUDED.timezone,
            booking_enabled = EXCLUDED.booking_enabled,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, workingDays, startTime, endTime, slotDurationMinutes, bufferMinutes, timezone, bookingEnabled ? 1 : 0]
    );
}

async function countOverlappingAppointments(userId, startAt, endAt, excludeId = null) {
    let sql = `SELECT COUNT(*) as count FROM appointments
               WHERE user_id = $1 AND status = 'confirmed' AND start_at < $2 AND end_at > $3`;
    const params = [userId, endAt, startAt];
    if (excludeId) {
        sql += ' AND id != $4';
        params.push(excludeId);
    }
    const row = await queryGet(sql, params);
    return row ? row.count : 0;
}

async function listAppointments(userId, { status = null, fromAt = null, toAt = null, limit = 500 } = {}) {
    let sql = 'SELECT * FROM appointments WHERE user_id = $1';
    const params = [userId];
    let idx = 2;

    if (status) {
        sql += ` AND status = $${idx++}`;
        params.push(status);
    }
    if (fromAt) {
        sql += ` AND end_at >= $${idx++}`;
        params.push(fromAt);
    }
    if (toAt) {
        sql += ` AND start_at <= $${idx++}`;
        params.push(toAt);
    }
    sql += ` ORDER BY start_at ASC LIMIT $${idx++}`;
    params.push(limit);
    return queryAll(sql, params);
}

async function countAppointments(userId) {
    const row = await queryGet("SELECT COUNT(*) as count FROM appointments WHERE user_id = $1 AND status = 'confirmed'", [userId]);
    return row ? row.count : 0;
}

/**
 * Concurrency-safe appointment booking.
 * Uses a PostgreSQL transaction-level advisory lock on the tenant's user_id
 * to serialize booking attempts per tenant, preventing double-booking races.
 */
async function createAppointment(userId, { phone, contactName = '', startAt, endAt, source = 'chatbot', notes = '', calendarEventId = null, projectId = null }) {
    return transaction(async (tx) => {
        // Advisory lock on tenant user_id guarantees serialized execution for this tenant
        await tx.query('SELECT pg_advisory_xact_lock($1)', [userId]);

        const conflictRow = await tx.query(
            `SELECT COUNT(*) as count FROM appointments
             WHERE user_id = $1 AND status = 'confirmed' AND start_at < $2 AND end_at > $3`,
            [userId, endAt, startAt]
        );

        if (conflictRow.rows[0].count > 0) {
            return null; // Slot already booked
        }

        const res = await tx.query(
            `INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, source, notes, calendar_event_id, project_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [userId, phone, contactName, startAt, endAt, source, notes, calendarEventId, projectId || null]
        );
        return res.rows[0];
    });
}

async function getAppointmentById(userId, id) {
    return queryGet('SELECT * FROM appointments WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function cancelAppointment(userId, id) {
    const row = await queryGet("SELECT * FROM appointments WHERE id = $1 AND user_id = $2 AND status = 'confirmed'", [id, userId]);
    if (!row) return null;
    await runSql("UPDATE appointments SET status = 'cancelled' WHERE id = $1 AND user_id = $2", [id, userId]);
    await cancelAppointmentReminders(userId, id);
    return { ...row, status: 'cancelled' };
}

async function getUpcomingConfirmedAppointments(userId = null, fromDate = new Date()) {
    let sql = "SELECT * FROM appointments WHERE status = 'confirmed' AND start_at > $1";
    const params = [fromDate];
    if (userId) {
        sql += ' AND user_id = $2';
        params.push(userId);
    }
    sql += ' ORDER BY start_at ASC';
    return queryAll(sql, params);
}

// ─── Dashboard Stats ────────────────────────────────────────

async function getDashboardStats(userId) {
    const totalMessages = (await queryGet('SELECT COUNT(*) as count FROM messages WHERE user_id = $1', [userId])).count;
    const messagesToday = (await queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND created_at::date = CURRENT_DATE", [userId])).count;
    const sentToday = (await queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND direction = 'outgoing' AND created_at::date = CURRENT_DATE", [userId])).count;
    const receivedToday = (await queryGet("SELECT COUNT(*) as count FROM messages WHERE user_id = $1 AND direction = 'incoming' AND created_at::date = CURRENT_DATE", [userId])).count;
    const totalContacts = (await queryGet('SELECT COUNT(*) as count FROM contacts WHERE user_id = $1', [userId])).count;
    const activeRules = (await queryGet('SELECT COUNT(*) as count FROM chatbot_rules WHERE user_id = $1 AND is_active = 1', [userId])).count;
    const pendingScheduled = (await queryGet("SELECT COUNT(*) as count FROM scheduled_messages WHERE user_id = $1 AND status = 'pending'", [userId])).count;

    const recentMessages = await queryAll('SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]);

    const messagesByDay = await queryAll(`
        SELECT to_char(created_at, 'YYYY-MM-DD') as day,
               SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
               SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
        FROM messages
        WHERE user_id = $1 AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        GROUP BY to_char(created_at, 'YYYY-MM-DD')
        ORDER BY day ASC
    `, [userId]);

    return {
        totalMessages,
        messagesToday,
        sentToday,
        receivedToday,
        totalContacts,
        activeRules,
        pendingScheduled,
        recentMessages,
        messagesByDay
    };
}

// ─── Inventory: Projects ─────────────────────────────────────────────────

async function createProject(userId, fields) {
    const res = await query(
        `INSERT INTO projects (user_id, name, developer, city, locality, address, map_url,
            property_type, rera_number, rera_status, possession_date, description, listing_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [userId, fields.name, fields.developer||'', fields.city||'', fields.locality||'',
         fields.address||'', fields.mapUrl||'', fields.propertyType||'residential',
         fields.reraNumber||'', fields.reraStatus||'unverified',
         fields.possessionDate||null, fields.description||'', fields.listingUrl||'']
    );
    return res.rows[0];
}

async function getProjects(userId, { city, propertyType, activeOnly = true } = {}) {
    let sql = 'SELECT * FROM projects WHERE user_id = $1';
    const params = [userId];
    let idx = 2;
    if (activeOnly) { sql += ` AND is_active = 1`; }
    if (city) { sql += ` AND LOWER(city) = LOWER($${idx++})`; params.push(city); }
    if (propertyType) { sql += ` AND property_type = $${idx++}`; params.push(propertyType); }
    sql += ' ORDER BY created_at DESC';
    return queryAll(sql, params);
}

async function getProjectById(userId, id) {
    return queryGet('SELECT * FROM projects WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function updateProject(userId, id, fields) {
    const allowed = ['name','developer','city','locality','address','map_url','property_type',
                     'rera_number','rera_status','possession_date','description','listing_url','is_active'];
    const sets = [], params = [];
    let idx = 1;
    const col = { mapUrl:'map_url', propertyType:'property_type', reraNumber:'rera_number',
                  reraStatus:'rera_status', possessionDate:'possession_date',
                  listingUrl:'listing_url', isActive:'is_active' };
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;              // skip fields caller didn't supply
        const dbKey = col[k] || k;
        if (allowed.includes(dbKey)) { sets.push(`${dbKey} = $${idx++}`); params.push(v); }
    }
    if (!sets.length) return getProjectById(userId, id);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, id);
    await runSql(`UPDATE projects SET ${sets.join(', ')} WHERE user_id = $${idx++} AND id = $${idx}`, params);
    return getProjectById(userId, id);
}

async function deleteProject(userId, id) {
    return runSql('DELETE FROM projects WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ─── Inventory: Units ────────────────────────────────────────────────────

const VALID_UNIT_STATUSES = ['VACANT','ON_HOLD','BOOKED','SOLD'];
const UNIT_TRANSITIONS = { VACANT:['ON_HOLD','BOOKED'], ON_HOLD:['VACANT','BOOKED'], BOOKED:['SOLD'], SOLD:[] };

async function createUnit(userId, projectId, fields) {
    const res = await query(
        `INSERT INTO units (user_id, project_id, tower, unit_number, bhk, area, area_unit, price, floor, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, projectId, fields.tower||'', fields.unitNumber, fields.bhk||'',
         fields.area||0, fields.areaUnit||'sqft', fields.price||0, fields.floor||null, 'VACANT']
    );
    return res.rows[0];
}

async function getUnits(userId, projectId, { status, bhk } = {}) {
    let sql = 'SELECT * FROM units WHERE user_id = $1 AND project_id = $2 AND is_active = 1';
    const params = [userId, projectId];
    let idx = 3;
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (bhk)    { sql += ` AND LOWER(bhk) = LOWER($${idx++})`; params.push(bhk); }
    sql += ' ORDER BY tower ASC, floor ASC, unit_number ASC';
    return queryAll(sql, params);
}

async function getUnitById(userId, id) {
    return queryGet('SELECT * FROM units WHERE id = $1 AND user_id = $2 AND is_active = 1', [id, userId]);
}

async function updateUnit(userId, id, fields) {
    const allowed = ['tower', 'unit_number', 'bhk', 'area', 'area_unit', 'price', 'floor'];
    const column = { unitNumber: 'unit_number', areaUnit: 'area_unit' };
    const sets = [], params = [];
    let idx = 1;
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const name = column[key] || key;
        if (allowed.includes(name)) {
            sets.push(`${name}=$${idx++}`);
            params.push(value);
        }
    }
    if (!sets.length) return getUnitById(userId, id);
    sets.push('updated_at=CURRENT_TIMESTAMP');
    params.push(id, userId);
    const result = await query(
        `UPDATE units SET ${sets.join(', ')} WHERE id=$${idx++} AND user_id=$${idx} AND is_active=1 RETURNING *`,
        params
    );
    return result.rows[0] || null;
}

async function deleteUnit(userId, id) {
    return transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [id]);
        const result = await tx.query(
            'SELECT id,status FROM units WHERE id=$1 AND user_id=$2 AND is_active=1 FOR UPDATE',
            [id, userId]
        );
        const unit = result.rows[0];
        if (!unit) {
            const err = new Error('Unit not found');
            err.code = 'UNIT_NOT_FOUND';
            throw err;
        }
        if (['ON_HOLD', 'BOOKED'].includes(unit.status)) {
            const err = new Error('Release the hold or resolve the booking before deleting this unit');
            err.code = 'UNIT_ACTIVE_RESERVATION';
            throw err;
        }
        await tx.query('UPDATE units SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2', [id, userId]);
        return true;
    });
}

async function getUnitStatusHistory(userId, unitId) {
    return queryAll(
        `SELECT id,old_status,new_status,changed_by,reason,changed_at
         FROM unit_status_history WHERE unit_id=$1 AND user_id=$2 ORDER BY changed_at DESC,id DESC`,
        [unitId, userId]
    );
}

async function searchUnits(userId, { city, locality, bhk, minPrice, maxPrice, propertyType, status } = {}) {
    let sql = `
        SELECT u.*, p.name AS project_name, p.city, p.locality, p.property_type, p.rera_status
        FROM units u JOIN projects p ON p.id = u.project_id
        WHERE u.user_id = $1 AND u.is_active = 1 AND p.is_active = 1`;
    const params = [userId]; let idx = 2;
    if (status)       { sql += ` AND u.status = $${idx++}`;               params.push(status); }
    else              { sql += ` AND u.status = 'VACANT'`; }
    if (bhk)          { sql += ` AND LOWER(u.bhk) = LOWER($${idx++})`;    params.push(bhk); }
    if (minPrice)     { sql += ` AND u.price >= $${idx++}`;                params.push(minPrice); }
    if (maxPrice)     { sql += ` AND u.price <= $${idx++}`;                params.push(maxPrice); }
    if (city)         { sql += ` AND LOWER(p.city) = LOWER($${idx++})`;   params.push(city); }
    if (locality)     { sql += ` AND LOWER(p.locality) ILIKE $${idx++}`;  params.push(`%${locality}%`); }
    if (propertyType) { sql += ` AND p.property_type = $${idx++}`;         params.push(propertyType); }
    sql += ' ORDER BY u.price ASC LIMIT 50';
    return queryAll(sql, params);
}

/**
 * Atomically transitions a unit's status with advisory lock + history row.
 * Two concurrent holds on the same unit → exactly one success.
 */
async function transitionUnitStatus(userId, unitId, newStatus, { holdExpiresAt=null, holdBy='', bookingRef='', changedBy='', reason='' } = {}) {
    if (!VALID_UNIT_STATUSES.includes(newStatus)) {
        const err = new Error(`Invalid unit status: ${newStatus}`); err.code = 'INVALID_TRANSITION'; throw err;
    }
    return transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [unitId]);
        const row = await tx.query('SELECT * FROM units WHERE id = $1 AND user_id = $2 FOR UPDATE', [unitId, userId]);
        if (!row.rows.length) { const e=new Error('Unit not found'); e.code='UNIT_NOT_FOUND'; throw e; }
        const unit = row.rows[0];
        const allowed = UNIT_TRANSITIONS[unit.status] || [];
        if (!allowed.includes(newStatus)) {
            const e=new Error(`Cannot transition from ${unit.status} to ${newStatus}`); e.code='INVALID_TRANSITION'; throw e;
        }
        const sets=['status=$1','updated_at=CURRENT_TIMESTAMP'], params=[newStatus]; let idx=2;
        if (newStatus==='ON_HOLD') {
            sets.push(`hold_expires_at=$${idx++}`,`hold_by=$${idx++}`); params.push(holdExpiresAt||null, holdBy||'');
        } else {
            sets.push(`hold_expires_at=NULL`,`hold_by=''`);
        }
        if (newStatus==='BOOKED'||newStatus==='SOLD') { sets.push(`booking_ref=$${idx++}`); params.push(bookingRef||''); }
        params.push(unitId, userId);
        const updated = await tx.query(
            `UPDATE units SET ${sets.join(',')} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`, params);
        await tx.query(
            `INSERT INTO unit_status_history (unit_id,user_id,old_status,new_status,changed_by,reason) VALUES($1,$2,$3,$4,$5,$6)`,
            [unitId, userId, unit.status, newStatus, changedBy||'', reason||'']);
        return updated.rows[0];
    });
}

/** Revert expired ON_HOLD units to VACANT, idempotently. Returns count reverted. */
async function expireStaleHolds(userId = null) {
    const now = new Date().toISOString();
    const userClause = userId !== null ? 'AND user_id = $2' : '';
    const params = userId !== null ? [now, userId] : [now];
    const stale = await queryAll(
        `SELECT id, user_id FROM units WHERE status='ON_HOLD' AND hold_expires_at<=$1 ${userClause}`, params);
    if (!stale.length) return 0;
    await runSql(
        `UPDATE units SET status='VACANT',hold_expires_at=NULL,hold_by='',updated_at=CURRENT_TIMESTAMP
         WHERE status='ON_HOLD' AND hold_expires_at<=$1 ${userClause}`, params);
    for (const u of stale) {
        await runSql(
            `INSERT INTO unit_status_history (unit_id,user_id,old_status,new_status,reason)
             VALUES ($1,$2,'ON_HOLD','VACANT','hold_expired')`, [u.id, u.user_id]);
    }
    return stale.length;
}

// ─── Inventory: Media Assets ─────────────────────────────────────────────

async function createMediaAsset(userId, { projectId, unitId, assetType, fileName, storagePath, mimeType, sizeBytes, reraVerified=false }) {
    const res = await query(
        `INSERT INTO media_assets (user_id,project_id,unit_id,asset_type,file_name,storage_path,mime_type,size_bytes,rera_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [userId, projectId, unitId||null, assetType, fileName, storagePath, mimeType, sizeBytes||0, reraVerified?1:0]);
    return res.rows[0];
}

async function getMediaAssets(userId, projectId, { assetType, unitId, activeOnly=true } = {}) {
    let sql = 'SELECT * FROM media_assets WHERE user_id=$1 AND project_id=$2';
    const params=[userId, projectId]; let idx=3;
    if (activeOnly) sql += ' AND is_active=1';
    if (assetType) { sql += ` AND asset_type=$${idx++}`; params.push(assetType); }
    if (unitId)    { sql += ` AND unit_id=$${idx++}`; params.push(unitId); }
    sql += ' ORDER BY created_at ASC';
    return queryAll(sql, params);
}

async function getMediaAssetById(userId, id) {
    return queryGet('SELECT * FROM media_assets WHERE id=$1 AND user_id=$2', [id, userId]);
}

async function deleteMediaAsset(userId, id) {
    return runSql('UPDATE media_assets SET is_active=0 WHERE id=$1 AND user_id=$2', [id, userId]);
}

async function getMediaAssetSendHistory(userId, assetId) {
    return queryAll(
        `SELECT id,RIGHT(phone,4) AS phone_last4,contact_name,status,message_type,body,created_at
         FROM messages
         WHERE user_id=$1 AND media_asset_id=$2 AND direction='outgoing'
         ORDER BY created_at DESC,id DESC`,
        [userId, assetId]
    );
}

async function logBrochureDropEvent(userId, { projectId = null, phone, contactName = '', action, assetCount = 0 }) {
    const res = await query(
        `INSERT INTO brochure_drop_events (user_id, project_id, phone, contact_name, action, asset_count)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, projectId, phone, contactName, action, assetCount]
    );
    return res.rows[0];
}

async function getRecentBrochureDropEvents(userId, limit = 50) {
    return queryAll(
        `SELECT e.id, e.action, e.asset_count, e.created_at, e.contact_name,
                RIGHT(e.phone, 4) AS phone_last4, p.name AS project_name
         FROM brochure_drop_events e
         LEFT JOIN projects p ON p.id = e.project_id AND p.user_id = e.user_id
         WHERE e.user_id = $1
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $2`,
        [userId, limit]
    );
}

module.exports = {
    initDatabase,
    closeDatabase,
    getDb,
    runMigrations,
    getSchemaVersion,
    getPersistHealth,
    assertPersistable,
    stopPersistence,
    forcePersist,
    transaction,
    // Users / accounts
    getUserByEmail,
    getUserById,
    countUsers,
    createUser,
    ensureBootstrapAdmin,
    isDuplicateEmailError,
    touchLastLogin,
    listUsers,
    updateUser,
    updateUserPassword,
    incrementAuthVersion,
    deleteUserCascade,
    deleteUserAccountOnly,
    countOrphanedRows,
    getUserStats,
    getPlatformStats,
    getMonthlyOutgoingCount,
    countChatbotRules,
    ensureDefaultSettings,
    // Tenant data
    getContacts,
    countContacts,
    getContactByPhone,
    getContactsByIds,
    upsertContact,
    bulkUpsertContacts,
    markContactOutreached,
    deleteContact,
    logMessage,
    logOutgoingMessageIdempotent,
    findMessageByIdempotencyKey,
    getMessages,
    countMessages,
    clearMessages,
    updateMessageAckStatus,
    getConversation,
    getChatbotRules,
    createChatbotRule,
    updateChatbotRule,
    deleteChatbotRule,
    incrementRuleHitCount,
    getScheduledMessages,
    createScheduledMessage,
    countPendingScheduledMessages,
    updateScheduledMessageStatus,
    getPendingScheduledMessages,
    claimScheduledMessage,
    reclaimStuckScheduledMessages,
    cancelScheduledMessage,
    createOutreachJob,
    getOutreachJob,
    countRunningOutreachJobs,
    requestOutreachCancellation,
    recoverInterruptedOutreachJobs,
    getSetting,
    setSetting,
    getAllSettings,
    getDashboardStats,
    saveLeadAnalysis,
    getLeadAnalysis,
    getLeadAnalyses,
    deleteLeadAnalysis,
    getConversationPhones,
    getLeadStats,
    getProducts,
    countProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    CRM_STAGES,
    getCrmDeals,
    getCrmDealByPhone,
    getCrmDealById,
    createCrmDeal,
    updateCrmDeal,
    deleteCrmDeal,
    aiUpsertCrmDeal,
    getCrmStats,
    getCrmAnalytics,
    addCrmActivity,
    getCrmActivities,
    // Google Calendar
    saveGoogleCalendarTokens,
    getGoogleCalendarAccount,
    migratePlaintextCalendarTokens,
    getAllConnectedCalendarUserIds,
    deleteGoogleCalendarAccount,
    setCalendarAvailabilityCheck,
    touchCalendarLastSync,
    isCalendarEventSynced,
    markCalendarEventSynced,
    // Appointment booking
    getAvailabilitySettings,
    saveAvailabilitySettings,
    countOverlappingAppointments,
    listAppointments,
    countAppointments,
    createAppointment,
    getAppointmentById,
    cancelAppointment,
    createAppointmentReminder,
    cancelAppointmentReminders,
    getAppointmentReminders,
    getUpcomingConfirmedAppointments,
    // Inventory — projects, units, media assets
    createProject,
    getProjects,
    getProjectById,
    updateProject,
    deleteProject,
    createUnit,
    getUnits,
    getUnitById,
    updateUnit,
    deleteUnit,
    getUnitStatusHistory,
    searchUnits,
    transitionUnitStatus,
    expireStaleHolds,
    createMediaAsset,
    getMediaAssets,
    getMediaAssetById,
    deleteMediaAsset,
    getMediaAssetSendHistory,
    logBrochureDropEvent,
    getRecentBrochureDropEvents
};
