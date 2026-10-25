require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    const hash = await bcrypt.hash('12345678', 12);
    const result = await pool.query(
        'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE email = $2 RETURNING email, role, status',
        [hash, 'aryangodara@gmail.com']
    );
    console.log('Updated:', result.rows[0]);
    await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
