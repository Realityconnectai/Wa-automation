/**
 * scripts/create-synthetic-legacy-db.js
 *
 * Generates a synthetic legacy-format SQLite database for migration rehearsals and testing.
 * Uses completely synthetic, non-production test data.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

async function createSyntheticDb() {
    const targetDir = path.join(__dirname, '..', 'test-fixtures');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, 'legacy-synthetic.db');

    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // Create legacy tables matching actual legacy SQLite schema
    db.run(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            business_name TEXT DEFAULT '',
            owner_name TEXT DEFAULT '',
            role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending', 'rejected')),
            plan TEXT DEFAULT 'free',
            message_limit INTEGER DEFAULT 0,
            rule_limit INTEGER DEFAULT 0,
            wa_enabled INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login_at DATETIME,
            password_changed_at DATETIME
        );

        CREATE TABLE contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            name TEXT DEFAULT '',
            label TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            last_outreach_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        );

        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            wa_message_id TEXT,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            message_type TEXT DEFAULT 'text',
            body TEXT DEFAULT '',
            status TEXT DEFAULT 'sent',
            template_name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE chatbot_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            trigger_keyword TEXT NOT NULL,
            match_type TEXT DEFAULT 'contains' CHECK(match_type IN ('exact', 'contains', 'startswith', 'regex')),
            response_text TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            hit_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            body TEXT NOT NULL,
            scheduled_at DATETIME NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown')),
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME
        );

        CREATE TABLE settings (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );

        CREATE TABLE products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            price TEXT DEFAULT '',
            category TEXT DEFAULT '',
            url TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE crm_deals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            stage TEXT DEFAULT 'new' CHECK(stage IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
            deal_value REAL DEFAULT 0,
            product_interest TEXT DEFAULT '',
            source TEXT DEFAULT 'whatsapp',
            notes TEXT DEFAULT '',
            next_followup_at DATETIME,
            ai_suggested_stage TEXT DEFAULT '',
            ai_estimated_value REAL DEFAULT 0,
            stage_changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        );

        CREATE TABLE crm_activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            type TEXT DEFAULT 'note',
            content TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE lead_analysis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            interest_status TEXT DEFAULT 'unclear' CHECK(interest_status IN ('interested', 'not_interested', 'neutral', 'unclear')),
            interest_score INTEGER DEFAULT 0,
            sentiment TEXT DEFAULT 'neutral',
            issue_category TEXT DEFAULT '',
            issues TEXT DEFAULT '[]',
            priority TEXT DEFAULT 'low' CHECK(priority IN ('high', 'medium', 'low')),
            priority_reason TEXT DEFAULT '',
            next_action TEXT DEFAULT '',
            message_count INTEGER DEFAULT 0,
            last_analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, phone)
        );

        CREATE TABLE google_calendar_accounts (
            user_id INTEGER PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            scope TEXT,
            token_type TEXT,
            expiry_date INTEGER,
            calendar_id TEXT DEFAULT 'primary',
            check_availability INTEGER DEFAULT 0,
            connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_sync_at DATETIME
        );

        CREATE TABLE google_calendar_synced_events (
            user_id INTEGER NOT NULL,
            event_id TEXT NOT NULL,
            scheduled_message_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(user_id, event_id)
        );

        CREATE TABLE availability_settings (
            user_id INTEGER PRIMARY KEY,
            working_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
            start_time TEXT NOT NULL DEFAULT '09:00',
            end_time TEXT NOT NULL DEFAULT '18:00',
            slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
            buffer_minutes INTEGER NOT NULL DEFAULT 0,
            timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
            booking_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            start_at DATETIME NOT NULL,
            end_at DATETIME NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled')),
            source TEXT NOT NULL DEFAULT 'chatbot' CHECK(source IN ('chatbot', 'dashboard')),
            notes TEXT DEFAULT '',
            calendar_event_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Insert synthetic tenants (bcrypt hash for dummy pass "Password123!")
    const dummyHash = '$2b$10$SyntheticHashForTestingOnlyNotRealHash1234567890abcdef';

    db.run(`
        INSERT INTO users (id, email, password_hash, business_name, owner_name, role, status, plan, wa_enabled, message_limit, rule_limit)
        VALUES 
            (1, 'tenant1@synthetic.example', '${dummyHash}', 'Acme Synthetic Corp', 'Alice Synthetic', 'admin', 'active', 'enterprise', 1, 5000, 50),
            (2, 'tenant2@synthetic.example', '${dummyHash}', 'Beta Synthetic LLC', 'Bob Synthetic', 'user', 'active', 'free', 1, 2000, 20);

        INSERT INTO settings (user_id, key, value)
        VALUES
            (1, 'business_name', 'Acme Synthetic Corp'),
            (1, 'business_currency', '$'),
            (2, 'business_name', 'Beta Synthetic LLC'),
            (2, 'business_currency', '€');

        INSERT INTO contacts (id, user_id, phone, name, label, notes, last_outreach_at)
        VALUES
            (1, 1, '15550001111', 'Alice Synthetic', 'vip', 'Key client', '2026-09-01 12:00:00'),
            (2, 1, '15550002222', 'Bob Synthetic', 'prospect', 'Lead', null),
            (3, 2, '15550003333', 'Charlie Synthetic', 'lead', 'Contact', '2026-09-02 14:00:00');

        INSERT INTO messages (id, user_id, wa_message_id, phone, contact_name, direction, message_type, body, status)
        VALUES
            (1, 1, 'idem:syn-key-1', '15550001111', 'Alice Synthetic', 'outgoing', 'text', 'Hello Alice!', 'sent'),
            (2, 1, 'wa_msg_1002', '15550001111', 'Alice Synthetic', 'incoming', 'text', 'Hi Acme, interested in your widget.', 'sent'),
            (3, 2, 'idem:syn-key-2', '15550003333', 'Charlie Synthetic', 'outgoing', 'text', 'Welcome to Beta LLC', 'sent');

        INSERT INTO chatbot_rules (id, user_id, trigger_keyword, match_type, response_text, is_active, priority)
        VALUES
            (1, 1, 'pricing', 'contains', 'Our prices start at $99.', 1, 10),
            (2, 2, 'hours', 'contains', 'We are open 9am to 5pm.', 1, 5);

        INSERT INTO scheduled_messages (id, user_id, phone, body, scheduled_at, status, error_message)
        VALUES
            (1, 1, '15550001111', 'Followup meeting tomorrow', '2026-10-01 10:00:00', 'pending', null),
            (2, 1, '15550002222', 'Checking in', '2026-10-01 11:00:00', 'unknown', 'Send timed out — delivery unconfirmed'),
            (3, 2, '15550003333', 'Beta checkin', '2026-10-02 14:00:00', 'pending', null);

        INSERT INTO products (id, user_id, name, description, price, category, is_active)
        VALUES
            (1, 1, 'Widget Pro', 'Top tier widget', '199', 'Hardware', 1),
            (2, 2, 'Cloud Plan', 'Monthly subscription', '49', 'Software', 1);

        INSERT INTO crm_deals (id, user_id, phone, contact_name, stage, deal_value, product_interest)
        VALUES
            (1, 1, '15550001111', 'Alice Synthetic', 'qualified', 5000, 'Widget Pro'),
            (2, 2, '15550003333', 'Charlie Synthetic', 'new', 1200, 'Cloud Plan');

        INSERT INTO crm_activities (id, user_id, phone, type, content)
        VALUES
            (1, 1, '15550001111', 'note', 'Alice expressed strong interest in Widget Pro'),
            (2, 2, '15550003333', 'system', 'Deal created');

        INSERT INTO lead_analysis (id, user_id, phone, contact_name, summary, interest_status, interest_score, sentiment, priority)
        VALUES
            (1, 1, '15550001111', 'Alice Synthetic', 'Interested in enterprise widget plan', 'interested', 85, 'positive', 'high'),
            (2, 2, '15550003333', 'Charlie Synthetic', 'Inquired about monthly plan', 'neutral', 50, 'neutral', 'medium');

        INSERT INTO google_calendar_accounts (user_id, access_token, refresh_token, scope, token_type, expiry_date, calendar_id, check_availability)
        VALUES
            (1, 'dummy_access_token_alice', 'dummy_refresh_token_alice', 'https://www.googleapis.com/auth/calendar', 'Bearer', 1790000000, 'primary', 1);

        INSERT INTO google_calendar_synced_events (user_id, event_id, scheduled_message_id)
        VALUES
            (1, 'gcal_event_alice_001', 1);

        INSERT INTO availability_settings (user_id, working_days, start_time, end_time, slot_duration_minutes, buffer_minutes, timezone, booking_enabled)
        VALUES
            (1, '1,2,3,4,5', '09:00', '18:00', 30, 10, 'Asia/Kolkata', 1),
            (2, '1,2,3,4,5', '10:00', '17:00', 45, 15, 'UTC', 1);

        INSERT INTO appointments (id, user_id, phone, contact_name, start_at, end_at, status, source, calendar_event_id)
        VALUES
            (1, 1, '15550001111', 'Alice Synthetic', '2026-10-05 10:00:00', '2026-10-05 10:30:00', 'confirmed', 'chatbot', 'gcal_event_alice_001');
    `);

    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(targetPath, buffer);
    db.close();

    console.log(`✅ Synthetic legacy SQLite database created at: ${targetPath}`);
    console.log(`   File size: ${buffer.length} bytes`);
}

createSyntheticDb().catch(err => {
    console.error('❌ Failed to create synthetic database:', err);
    process.exit(1);
});
