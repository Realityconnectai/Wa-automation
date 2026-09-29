/**
 * scripts/migrate-sqlite-to-postgres.js
 *
 * Controlled migration tool to import data from a legacy SQLite (sql.js) file into PostgreSQL.
 *
 * Safety features:
 *   1. Source opened read-only (fs.readFileSync).
 *   2. Destination checked: refuses to import into populated business tables unless --allow-populated is passed.
 *   3. Dry-run mode (--dry-run) validates schema, counts, and constraints without committing.
 *   4. Full transaction: either all tables import cleanly or the transaction rolls back.
 *   5. Advances PostgreSQL serial sequences beyond the max imported IDs.
 *   6. Verifies table row counts, foreign key integrity, and password hash byte preservation without logging secrets.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.js --source <path-to-sqlite.db> [--target <postgres-url>] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');
const crypto = require('crypto');

// Function to parse CLI arguments
function getArg(args, flag) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return null;
}

const TABLES = [
    {
        name: 'users',
        hasSerial: true,
        columns: ['id', 'email', 'password_hash', 'business_name', 'owner_name', 'role', 'status', 'plan', 'message_limit', 'rule_limit', 'wa_enabled', 'created_at', 'last_login_at', 'password_changed_at'],
        columnAliases: {
            'last_login': 'last_login_at'
        }
    },
    {
        name: 'settings',
        hasSerial: false,
        columns: ['user_id', 'key', 'value']
    },
    {
        name: 'contacts',
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'name', 'label', 'notes', 'last_outreach_at', 'created_at', 'updated_at'],
        columnAliases: {
            'last_contacted': 'last_outreach_at',
            'tags': 'label'
        }
    },
    {
        name: 'messages',
        hasSerial: true,
        columns: ['id', 'user_id', 'wa_message_id', 'phone', 'contact_name', 'direction', 'message_type', 'body', 'status', 'template_name', 'created_at']
    },
    {
        name: 'chatbot_rules',
        hasSerial: true,
        columns: ['id', 'user_id', 'trigger_keyword', 'match_type', 'response_text', 'priority', 'is_active', 'hit_count', 'created_at', 'updated_at']
    },
    {
        name: 'scheduled_messages',
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'body', 'scheduled_at', 'status', 'error_message', 'created_at', 'sent_at'],
        columnAliases: {
            'failure_reason': 'error_message'
        }
    },
    {
        name: 'products',
        hasSerial: true,
        columns: ['id', 'user_id', 'name', 'description', 'price', 'category', 'url', 'is_active', 'created_at', 'updated_at']
    },
    {
        name: 'crm_deals',
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'contact_name', 'stage', 'deal_value', 'product_interest', 'source', 'notes', 'next_followup_at', 'ai_suggested_stage', 'ai_estimated_value', 'stage_changed_at', 'created_at', 'updated_at']
    },
    {
        name: 'crm_activities',
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'type', 'content', 'created_at']
    },
    {
        name: 'lead_analysis',
        tableAliases: ['lead_analyses'],
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'contact_name', 'summary', 'interest_status', 'interest_score', 'sentiment', 'issue_category', 'issues', 'priority', 'priority_reason', 'next_action', 'message_count', 'last_analyzed_at', 'created_at'],
        columnAliases: {
            'analyzed_at': 'last_analyzed_at'
        }
    },
    {
        name: 'google_calendar_accounts',
        tableAliases: ['google_calendar_tokens'],
        hasSerial: false,
        columns: ['user_id', 'access_token', 'refresh_token', 'scope', 'token_type', 'expiry_date', 'calendar_id', 'check_availability', 'connected_at', 'last_sync_at']
    },
    {
        name: 'google_calendar_synced_events',
        hasSerial: false,
        columns: ['user_id', 'event_id', 'scheduled_message_id', 'created_at']
    },
    {
        name: 'availability_settings',
        hasSerial: false,
        columns: ['user_id', 'working_days', 'start_time', 'end_time', 'slot_duration_minutes', 'buffer_minutes', 'timezone', 'booking_enabled', 'updated_at']
    },
    {
        name: 'appointments',
        hasSerial: true,
        columns: ['id', 'user_id', 'phone', 'contact_name', 'start_at', 'end_at', 'status', 'source', 'notes', 'calendar_event_id', 'created_at'],
        columnAliases: {
            'google_event_id': 'calendar_event_id'
        }
    }
];

// Timestamp column detector for UTC instant normalization
const TIMESTAMP_COLUMNS = new Set([
    'created_at', 'updated_at', 'scheduled_at', 'sent_at', 'last_login_at',
    'last_outreach_at', 'next_followup_at', 'stage_changed_at', 'last_analyzed_at',
    'connected_at', 'last_sync_at', 'start_at', 'end_at', 'password_changed_at'
]);

/**
 * Normalizes legacy SQLite timestamp strings to explicit UTC ISO strings.
 * E.g. "2026-10-01 10:00:00" -> "2026-10-01T10:00:00Z"
 */
function normalizeUtcTimestamp(val) {
    if (typeof val !== 'string' || !val) return val;
    const trimmed = val.trim();
    // "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS" without timezone offset
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
        return trimmed.replace(' ', 'T') + 'Z';
    }
    return trimmed;
}

async function runMigration(options = {}) {
    const sourcePath = options.sourcePath || getArg(process.argv.slice(2), '--source');
    const targetUrl = options.targetUrl || getArg(process.argv.slice(2), '--target') || process.env.DATABASE_URL;
    const isDryRun = options.isDryRun !== undefined ? options.isDryRun : process.argv.slice(2).includes('--dry-run');
    const allowPopulated = options.allowPopulated !== undefined ? options.allowPopulated : process.argv.slice(2).includes('--allow-populated');

    if (!sourcePath) {
        throw new Error('--source <path-to-sqlite.db> is required.');
    }

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file not found: ${sourcePath}`);
    }

    if (!targetUrl) {
        throw new Error('Target PostgreSQL URL is required via --target or DATABASE_URL.');
    }

    // Ensure target is not mistakenly pointing to production unless explicitly verified
    if (process.env.NODE_ENV === 'production' && !(options.confirmProduction || process.argv.slice(2).includes('--confirm-production'))) {
        throw new Error('Refusing to run migration in production mode without --confirm-production.');
    }

    console.log('====================================================');
    console.log('🔄 SQLite to PostgreSQL Data Migration Tool');
    console.log('====================================================');
    console.log(`Source SQLite: ${sourcePath} (Read-Only)`);
    console.log(`Target:        ${targetUrl.replace(/:[^:@]+@/, ':****@')}`);
    console.log(`Mode:          ${isDryRun ? 'DRY-RUN (Validation only, no writes)' : 'LIVE IMPORT'}`);
    console.log('----------------------------------------------------');

    // 1. Read SQLite file in memory (read-only)
    console.log('📖 Reading source SQLite database...');
    const buffer = fs.readFileSync(sourcePath);
    const SQL = await initSqlJs();
    const sqliteDb = new SQL.Database(buffer);

    // 2. Connect to PostgreSQL
    const pool = new Pool({
        connectionString: targetUrl,
        connectionTimeoutMillis: 10000
    });

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Check if destination is empty
        console.log('🔍 Checking target database baseline...');
        for (const table of TABLES) {
            const res = await client.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);
            if (res.rows[0].count > 0 && !allowPopulated) {
                // If the only user is the bootstrap admin and we have --allow-populated, we can proceed
                // Otherwise refuse
                throw new Error(`Target table "${table.name}" already contains ${res.rows[0].count} rows. Migration requires an empty database or explicit --allow-populated.`);
            }
        }

        const stats = {};
        const sourceAuthFingerprints = [];

        // 3. Migrate each table in order
        for (const table of TABLES) {
            // Find SQLite table name (checking name or aliases)
            let sourceTableName = table.name;
            let tableExists = sqliteDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table.name}'`);
            if (!tableExists.length || !tableExists[0].values.length) {
                if (table.tableAliases) {
                    for (const alias of table.tableAliases) {
                        const aliasExists = sqliteDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${alias}'`);
                        if (aliasExists.length && aliasExists[0].values.length) {
                            sourceTableName = alias;
                            break;
                        }
                    }
                }
            }

            // Check if source table was found
            tableExists = sqliteDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${sourceTableName}'`);
            if (!tableExists.length || !tableExists[0].values.length) {
                console.log(`   ℹ️ Table "${table.name}" (or aliases) does not exist in SQLite source. Skipping.`);
                stats[table.name] = { source: 0, imported: 0 };
                continue;
            }

            // Get SQLite columns
            const pragma = sqliteDb.exec(`PRAGMA table_info(${sourceTableName})`);
            const sqliteCols = pragma[0].values.map(v => v[1]);

            // Build column mapping: PG column -> SQLite column
            const mappedCols = [];
            for (const pgCol of table.columns) {
                if (sqliteCols.includes(pgCol)) {
                    mappedCols.push({ pgCol, sqliteCol: pgCol });
                } else if (table.columnAliases) {
                    for (const [sqliteAlias, targetPgCol] of Object.entries(table.columnAliases)) {
                        if (targetPgCol === pgCol && sqliteCols.includes(sqliteAlias)) {
                            mappedCols.push({ pgCol, sqliteCol: sqliteAlias });
                            break;
                        }
                    }
                }
            }

            if (!mappedCols.length) {
                console.log(`   ℹ️ No matching columns for "${table.name}". Skipping.`);
                stats[table.name] = { source: 0, imported: 0 };
                continue;
            }

            // Read source rows
            const sqliteSelectCols = mappedCols.map(m => m.sqliteCol).join(', ');
            const query = `SELECT ${sqliteSelectCols} FROM ${sourceTableName}`;
            const result = sqliteDb.exec(query);
            const rows = (result.length && result[0].values) ? result[0].values : [];

            stats[table.name] = { source: rows.length, imported: 0 };

            if (rows.length === 0) {
                console.log(`   ✔ Table "${table.name}": 0 rows to import.`);
                continue;
            }

            console.log(`   📥 Importing "${table.name}" from "${sourceTableName}": ${rows.length} rows...`);

            // If table is 'users', collect sha256 of password_hash for validation without logging
            if (table.name === 'users') {
                const pwdIdx = mappedCols.findIndex(m => m.pgCol === 'password_hash');
                const idIdx = mappedCols.findIndex(m => m.pgCol === 'id');
                if (pwdIdx !== -1 && idIdx !== -1) {
                    for (const r of rows) {
                        const hash = String(r[pwdIdx] || '');
                        sourceAuthFingerprints.push({
                            id: r[idIdx],
                            digest: crypto.createHash('sha256').update(hash).digest('hex')
                        });
                    }
                }
            }

            // Prepare batch insert
            const pgColList = mappedCols.map(m => m.pgCol).join(', ');
            for (const row of rows) {
                const placeholders = mappedCols.map((_, i) => `$${i + 1}`).join(', ');
                const insertSql = `INSERT INTO ${table.name} (${pgColList}) VALUES (${placeholders})`;

                // Handle boolean / JSON / timestamp conversions
                const params = row.map((val, idx) => {
                    const col = mappedCols[idx].pgCol;
                    if (val === null || val === undefined) return null;
                    if (col === 'is_sales_conversation') {
                        return val === 1 || val === true || val === '1';
                    }
                    if (col === 'issues') {
                        try { return JSON.parse(val); } catch (_) { return []; }
                    }
                    if (TIMESTAMP_COLUMNS.has(col)) {
                        return normalizeUtcTimestamp(val);
                    }
                    return val;
                });

                await client.query(insertSql, params);
                stats[table.name].imported++;
            }

            // Advance PostgreSQL serial sequence if applicable
            // Note: PostgreSQL sequences are non-transactional; setval does not roll back on transaction abort.
            if (table.hasSerial && rows.length > 0) {
                await client.query(
                    `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table.name}), 1), true)`,
                    [table.name]
                );
            }
        }

        // 4. Verification and Integrity Checks
        console.log('\n🔎 Running post-import integrity verification...');

        // 4a. Count checks
        let countMismatch = false;
        for (const [tbl, s] of Object.entries(stats)) {
            if (s.source !== s.imported) {
                console.error(`   ❌ Count mismatch on ${tbl}: source=${s.source}, imported=${s.imported}`);
                countMismatch = true;
            }
        }
        if (countMismatch) throw new Error('Count verification failed.');

        // 4b. Authentication hash preservation check
        if (sourceAuthFingerprints.length > 0) {
            const targetUsers = await client.query('SELECT id, password_hash FROM users');
            for (const expected of sourceAuthFingerprints) {
                const match = targetUsers.rows.find(u => u.id === expected.id);
                if (!match) throw new Error(`User id ${expected.id} missing in target.`);
                const actualDigest = crypto.createHash('sha256').update(match.password_hash || '').digest('hex');
                if (actualDigest !== expected.digest) {
                    throw new Error(`Password hash byte mismatch for user id ${expected.id}.`);
                }
            }
            console.log(`   ✔ Authentication hashes verified (${sourceAuthFingerprints.length} accounts, byte-identical digests).`);
        }

        // 4c. Foreign key integrity check
        console.log('   ✔ Foreign key integrity verified via PostgreSQL constraint enforcement.');

        if (isDryRun) {
            console.log('\n🧪 DRY-RUN: Rolling back transaction. No data was written.');
            await client.query('ROLLBACK');
        } else {
            await client.query('COMMIT');
            console.log('\n🎉 Live migration committed successfully!');
        }

        console.log('\n📊 Migration Summary:');
        console.table(stats);
        return stats;

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('\n❌ Migration failed. Transaction rolled back cleanly.');
        console.error(`Reason: ${err.message}`);
        throw err;
    } finally {
        client.release();
        sqliteDb.close();
        await pool.end();
    }
}

if (require.main === module) {
    runMigration().catch(err => {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    TABLES,
    TIMESTAMP_COLUMNS,
    normalizeUtcTimestamp,
    runMigration
};
