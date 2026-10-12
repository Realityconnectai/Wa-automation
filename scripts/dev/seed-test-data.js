/**
 * scripts/dev/seed-test-data.js
 *
 * Seeds a small, deterministic set of synthetic rows across every application
 * table into the database pointed to by DATABASE_URL.
 * Used only by the backup/restore test — never run against production.
 *
 * Usage (against wa_test only):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test node scripts/dev/seed-test-data.js
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
if (!url || url.includes('whatsapp_automation')) {
    console.error('ERROR: Refusing to seed — DATABASE_URL must point at a test database, not whatsapp_automation.');
    process.exit(1);
}

const pool = new Pool({ connectionString: url });

async function seed() {
    const client = await pool.connect();
    try {
        // Wipe and re-seed idempotently
        await client.query('BEGIN');

        await client.query('DELETE FROM users');          // cascades to all child tables

        // 1 user (admin)
        const userRes = await client.query(`
            INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan)
            VALUES ('seed_admin@test.local', '$2a$04$seed_hash_placeholder_xxxxx', 'Test Realty', 'Seed Owner', 'admin', 'active', 'free')
            RETURNING id`);
        const userId = userRes.rows[0].id;

        // 2 contacts
        await client.query(`INSERT INTO contacts (user_id, phone, name, label) VALUES
            ($1, '919111111111', 'Buyer One', 'hot'),
            ($1, '919222222222', 'Buyer Two', 'warm')`, [userId]);

        // 3 messages
        await client.query(`INSERT INTO messages (user_id, phone, direction, message_type, body, status) VALUES
            ($1, '919111111111', 'incoming', 'text', 'Hello, interested in 3BHK', 'received'),
            ($1, '919111111111', 'outgoing', 'text', 'Thanks for reaching out!', 'sent'),
            ($1, '919222222222', 'incoming', 'image', '[image]', 'received')`, [userId]);

        // 1 chatbot rule
        await client.query(`INSERT INTO chatbot_rules (user_id, trigger_keyword, match_type, response_text)
            VALUES ($1, '3bhk', 'contains', 'We have great 3BHK options!')`, [userId]);

        // 1 scheduled message
        await client.query(`INSERT INTO scheduled_messages (user_id, phone, body, scheduled_at, status)
            VALUES ($1, '919111111111', 'Follow up message', '2030-01-01 10:00:00', 'pending')`, [userId]);

        // 1 product
        await client.query(`INSERT INTO products (user_id, name, price, category)
            VALUES ($1, 'Sunrise Towers 3BHK', '75L', 'residential')`, [userId]);

        // 1 CRM deal
        await client.query(`INSERT INTO crm_deals (user_id, phone, contact_name, stage, deal_value, source)
            VALUES ($1, '919111111111', 'Buyer One', 'qualified', 7500000, 'whatsapp')`, [userId]);

        // 1 CRM activity
        await client.query(`INSERT INTO crm_activities (user_id, phone, type, content)
            VALUES ($1, '919111111111', 'note', 'Interested in possession by March 2027')`, [userId]);

        // 1 lead analysis
        await client.query(`INSERT INTO lead_analysis (user_id, phone, contact_name, summary, interest_status, interest_score, priority)
            VALUES ($1, '919111111111', 'Buyer One', 'Serious buyer', 'interested', 85, 'high')`, [userId]);

        // 1 settings row
        await client.query(`INSERT INTO settings (user_id, key, value) VALUES ($1, 'business_name', 'Test Realty')
            ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`, [userId]);

        // 1 availability_settings row
        await client.query(`INSERT INTO availability_settings (user_id, working_days, start_time, end_time, slot_duration_minutes, buffer_minutes, timezone, booking_enabled)
            VALUES ($1, '1,2,3,4,5', '09:00', '18:00', 30, 0, 'Asia/Kolkata', 0)
            ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()`, [userId]);

        // 1 appointment
        await client.query(`INSERT INTO appointments (user_id, phone, contact_name, start_at, end_at, status, source)
            VALUES ($1, '919111111111', 'Buyer One', '2030-03-15 10:00:00+00', '2030-03-15 10:30:00+00', 'confirmed', 'dashboard')`, [userId]);

        await client.query('COMMIT');
        console.log(`✅ Seeded user_id=${userId} with synthetic data.`);
        console.log('   contacts: 2, messages: 3, rules: 1, scheduled: 1, products: 1');
        console.log('   crm_deals: 1, crm_activities: 1, lead_analysis: 1, appointments: 1');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
