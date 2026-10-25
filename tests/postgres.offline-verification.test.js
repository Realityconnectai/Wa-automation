/**
 * tests/postgres.offline-verification.test.js
 *
 * Unit tests verifying PostgreSQL compatibility components offline:
 *   1. Placeholder converter state-machine (single quotes, escaped quotes, double quotes,
 *      line comments, block comments, dollar-quoted strings, and PostgreSQL operators).
 *   2. BigInt & Numeric type parsers (boundary enforcement, safe integer range, precision preservation).
 *   3. Timezone model & UTC normalization.
 *   4. Schema migration file integrity & sequence rules.
 *   5. Synthetic legacy SQLite database schema parity.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { types } = require('pg');
const { convertPlaceholders, normalizeSql } = require('../src/services/db-pool');

describe('Task 2B: Offline PostgreSQL Verification Suite', () => {

    describe('1. Placeholder Converter State Machine', () => {
        test('converts basic positional placeholders ? to $1, $2', () => {
            const sql = 'SELECT * FROM users WHERE id = ? AND email = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT * FROM users WHERE id = $1 AND email = $2');
        });

        test('preserves ? inside single-quoted strings', () => {
            const sql = "SELECT * FROM messages WHERE body = 'What? Are you sure?' AND user_id = ?";
            expect(convertPlaceholders(sql)).toBe("SELECT * FROM messages WHERE body = 'What? Are you sure?' AND user_id = $1");
        });

        test('preserves ? inside escaped single quotes', () => {
            const sql = "SELECT * FROM messages WHERE body = 'It''s a question? Yes.' AND user_id = ?";
            expect(convertPlaceholders(sql)).toBe("SELECT * FROM messages WHERE body = 'It''s a question? Yes.' AND user_id = $1");
        });

        test('preserves ? inside double-quoted identifiers', () => {
            const sql = 'SELECT "col?name" FROM table_name WHERE id = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT "col?name" FROM table_name WHERE id = $1');
        });

        test('preserves ? inside single-line comments', () => {
            const sql = 'SELECT * FROM users WHERE id = ? -- Is this a comment with ?\nAND role = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT * FROM users WHERE id = $1 -- Is this a comment with ?\nAND role = $2');
        });

        test('preserves ? inside multi-line block comments', () => {
            const sql = 'SELECT /* Does this ? count? */ id FROM users WHERE status = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT /* Does this ? count? */ id FROM users WHERE status = $1');
        });

        test('preserves ? inside dollar-quoted strings', () => {
            const sql = 'SELECT $$String with ? inside$$ AS val WHERE id = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT $$String with ? inside$$ AS val WHERE id = $1');
        });

        test('preserves ? inside tagged dollar-quoted strings', () => {
            const sql = 'SELECT $tag$Function body with ? placeholder$tag$ AS body WHERE user_id = ?';
            expect(convertPlaceholders(sql)).toBe('SELECT $tag$Function body with ? placeholder$tag$ AS body WHERE user_id = $1');
        });

        test('handles PostgreSQL JSON operators ?| and ?& without replacing with $n', () => {
            const sql = "SELECT * FROM items WHERE metadata ?| array['a', 'b'] AND category_id = ?";
            expect(convertPlaceholders(sql)).toBe("SELECT * FROM items WHERE metadata ?| array['a', 'b'] AND category_id = $1");

            const sqlAnd = "SELECT * FROM items WHERE metadata ?& array['x', 'y'] AND user_id = ?";
            expect(convertPlaceholders(sqlAnd)).toBe("SELECT * FROM items WHERE metadata ?& array['x', 'y'] AND user_id = $1");
        });

        test('handles escaped ?? operator for JSONB key existence', () => {
            const sql = "SELECT * FROM items WHERE metadata ?? 'status' AND id = ?";
            expect(convertPlaceholders(sql)).toBe("SELECT * FROM items WHERE metadata ? 'status' AND id = $1");
        });

        test('complex query combining quotes, comments, operators, and parameters', () => {
            const sql = `
                -- Query to fetch lead analysis with ? comment
                SELECT la.*, 'Does this ? work?' AS label
                FROM lead_analysis la
                WHERE la.user_id = ?
                  AND la.issues ?| array['billing', 'support']
                  AND la.phone = ? /* another ? comment */
                ORDER BY la.created_at DESC
            `;
            const converted = convertPlaceholders(sql);
            expect(converted).toContain('WHERE la.user_id = $1');
            expect(converted).toContain("la.issues ?| array['billing', 'support']");
            expect(converted).toContain('AND la.phone = $2');
            expect(converted).toContain("'Does this ? work?'");
            expect(converted).toContain('-- Query to fetch lead analysis with ? comment');
        });

        test('normalizeSql leaves queries without ? untouched', () => {
            const sql = 'SELECT * FROM users WHERE id = $1 AND role = $2';
            expect(normalizeSql(sql)).toBe(sql);
        });
    });

    describe('2. BigInt and Numeric Type Parsers', () => {
        const bigintParser = types.getTypeParser(20);
        const numericParser = types.getTypeParser(1700);

        test('BigInt parser returns null for null input', () => {
            expect(bigintParser(null)).toBeNull();
        });

        test('BigInt parser converts standard integers to JavaScript Number', () => {
            expect(bigintParser('42')).toBe(42);
            expect(bigintParser('0')).toBe(0);
            expect(bigintParser('1000000')).toBe(1000000);
        });

        test('BigInt parser converts MAX_SAFE_INTEGER exactly', () => {
            const maxSafe = String(Number.MAX_SAFE_INTEGER);
            expect(bigintParser(maxSafe)).toBe(Number.MAX_SAFE_INTEGER);
        });

        test('BigInt parser preserves values beyond MAX_SAFE_INTEGER without precision loss', () => {
            const hugeVal = '9007199254740993'; // MAX_SAFE_INTEGER + 2
            const parsed = bigintParser(hugeVal);
            expect(parsed).toEqual(BigInt('9007199254740993'));
        });

        test('BigInt values serialize to JSON without error', () => {
            const payload = { id: BigInt(42), huge: BigInt('9007199254740993') };
            expect(() => JSON.stringify(payload)).not.toThrow();
            const json = JSON.parse(JSON.stringify(payload));
            expect(json.id).toBe(42);
            expect(json.huge).toBe('9007199254740993');
        });

        test('Numeric parser returns null for null input', () => {
            expect(numericParser(null)).toBeNull();
        });

        test('Numeric parser parses floating point deal values correctly', () => {
            expect(numericParser('199.99')).toBe(199.99);
            expect(numericParser('0.00')).toBe(0);
            expect(numericParser('5000')).toBe(5000);
        });

        test('Numeric parser preserves raw string for high-precision decimals to avoid silent loss', () => {
            const highPrecision = '12345678901234567890.123456789';
            expect(numericParser(highPrecision)).toBe(highPrecision);
        });
    });

    describe('3. Timezone Model and UTC Normalization', () => {
        const { normalizeUtcTimestamp } = require('../scripts/migrate-sqlite-to-postgres');
        const { parseTimestampToMs } = require('../src/config/auth');

        test('normalizes legacy SQLite space-separated UTC strings to ISO Z format', () => {
            expect(normalizeUtcTimestamp('2026-10-01 10:00:00')).toBe('2026-10-01T10:00:00Z');
            expect(normalizeUtcTimestamp('2026-05-15 08:30:45.123')).toBe('2026-05-15T08:30:45.123Z');
        });

        test('preserves already-formatted ISO strings with Z or timezone offset', () => {
            expect(normalizeUtcTimestamp('2026-10-01T10:00:00Z')).toBe('2026-10-01T10:00:00Z');
            expect(normalizeUtcTimestamp('2026-10-01T15:30:00+05:30')).toBe('2026-10-01T15:30:00+05:30');
        });

        test('preserves non-timestamp strings or nulls', () => {
            expect(normalizeUtcTimestamp(null)).toBeNull();
            expect(normalizeUtcTimestamp('')).toBe('');
            expect(normalizeUtcTimestamp('Asia/Kolkata')).toBe('Asia/Kolkata');
        });

        test('parseTimestampToMs correctly converts Date, ISO string, SQLite space-separated string, and seconds', () => {
            const d = new Date('2026-09-19T10:00:00.000Z');
            expect(parseTimestampToMs(d)).toBe(d.getTime());
            expect(parseTimestampToMs('2026-09-19T10:00:00.000Z')).toBe(d.getTime());
            expect(parseTimestampToMs('2026-09-19 10:00:00')).toBe(d.getTime());
            expect(parseTimestampToMs(Math.floor(d.getTime() / 1000))).toBe(d.getTime());
        });
    });

    describe('4. Schema Migration Files & Sequence Integrity', () => {
        const migrationDir = path.join(__dirname, '..', 'src', 'migrations');

        test('all 11 migration files exist and are non-empty', () => {
            const files = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();
            // Use >= rather than an exact count so adding future migrations
            // does not require updating this test every time.
            expect(files.length).toBeGreaterThanOrEqual(11);
            for (const f of files) {
                const content = fs.readFileSync(path.join(migrationDir, f), 'utf8').trim();
                expect(content.length).toBeGreaterThan(50);
            }
        });

        test('010_users_password_changed_at.sql ensures password_changed_at column exists', () => {
            const sql = fs.readFileSync(path.join(migrationDir, '010_users_password_changed_at.sql'), 'utf8');
            expect(sql).toMatch(/ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+password_changed_at\s+TIMESTAMPTZ/i);
        });

        test('011_users_auth_version.sql ensures auth_version column exists with default 1', () => {
            const sql = fs.readFileSync(path.join(migrationDir, '011_users_auth_version.sql'), 'utf8');
            expect(sql).toMatch(/ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+auth_version\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1/i);
        });

        test('001_initial_schema.sql defines all 14 business and integration tables', () => {
            const schema = fs.readFileSync(path.join(migrationDir, '001_initial_schema.sql'), 'utf8');
            const requiredTables = [
                'users', 'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
                'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
                'google_calendar_accounts', 'google_calendar_synced_events',
                'availability_settings', 'appointments'
            ];

            for (const table of requiredTables) {
                const regex = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
                expect(schema).toMatch(regex);
            }
        });

        test('001_initial_schema.sql has password_changed_at on users table', () => {
            const schema = fs.readFileSync(path.join(migrationDir, '001_initial_schema.sql'), 'utf8');
            expect(schema).toMatch(/password_changed_at\s+TIMESTAMPTZ/i);
        });

        test('scheduled_messages status check constraint includes all 6 valid statuses', () => {
            const schema = fs.readFileSync(path.join(migrationDir, '001_initial_schema.sql'), 'utf8');
            expect(schema).toMatch(/status\s+TEXT\s+DEFAULT\s+'pending'\s+CHECK\(status\s+IN\s+\('pending',\s*'sending',\s*'sent',\s*'failed',\s*'cancelled',\s*'unknown'\)\)/i);
        });

        test('tables with serial IDs vs non-serial primary keys are correctly distinguished', () => {
            const schema = fs.readFileSync(path.join(migrationDir, '001_initial_schema.sql'), 'utf8');
            // Serial primary key tables
            expect(schema).toMatch(/users\s*\(\s*id\s+SERIAL\s+PRIMARY\s+KEY/i);
            expect(schema).toMatch(/contacts\s*\(\s*id\s+SERIAL\s+PRIMARY\s+KEY/i);
            expect(schema).toMatch(/messages\s*\(\s*id\s+SERIAL\s+PRIMARY\s+KEY/i);
            expect(schema).toMatch(/appointments\s*\(\s*id\s+SERIAL\s+PRIMARY\s+KEY/i);

            // Non-serial composite or user_id PK tables
            expect(schema).toMatch(/settings\s*\(\s*user_id\s+INTEGER/i);
            expect(schema).toMatch(/PRIMARY\s+KEY\s*\(user_id,\s*key\)/i);
            expect(schema).toMatch(/google_calendar_accounts\s*\(\s*user_id\s+INTEGER\s+PRIMARY\s+KEY/i);
            expect(schema).toMatch(/availability_settings\s*\(\s*user_id\s+INTEGER\s+PRIMARY\s+KEY/i);
        });
    });

    describe('5. Synthetic Legacy SQLite Database Schema Parity', () => {
        const initSqlJs = require('sql.js');
        const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'legacy-synthetic.db');

        beforeAll(async () => {
            if (!fs.existsSync(fixturePath)) {
                const { createSyntheticDb } = require('../scripts/create-synthetic-legacy-db');
                await createSyntheticDb(fixturePath);
            }
        });

        test('synthetic database fixture exists and is populated', async () => {
            expect(fs.existsSync(fixturePath)).toBe(true);
            const buffer = fs.readFileSync(fixturePath);
            expect(buffer.length).toBeGreaterThan(10000);

            const SQL = await initSqlJs();
            const db = new SQL.Database(buffer);

            // Verify all expected tables exist
            const tablesRes = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
            const tableNames = tablesRes[0].values.map(v => v[0]);

            const expectedTables = [
                'users', 'contacts', 'messages', 'chatbot_rules', 'scheduled_messages',
                'settings', 'products', 'crm_deals', 'crm_activities', 'lead_analysis',
                'google_calendar_accounts', 'google_calendar_synced_events',
                'availability_settings', 'appointments'
            ];

            for (const table of expectedTables) {
                expect(tableNames).toContain(table);
            }

            // Verify synthetic data row counts
            const userCount = db.exec('SELECT count(*) FROM users')[0].values[0][0];
            expect(userCount).toBe(2);

            const contactCount = db.exec('SELECT count(*) FROM contacts')[0].values[0][0];
            expect(contactCount).toBe(3);

            const dealCount = db.exec('SELECT count(*) FROM crm_deals')[0].values[0][0];
            expect(dealCount).toBe(2);

            const leadCount = db.exec('SELECT count(*) FROM lead_analysis')[0].values[0][0];
            expect(leadCount).toBe(2);

            // Verify scheduled message statuses include unknown
            const unknownMsg = db.exec("SELECT count(*) FROM scheduled_messages WHERE status = 'unknown'")[0].values[0][0];
            expect(unknownMsg).toBe(1);

            db.close();
        });
    });
});
