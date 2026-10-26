require('dotenv').config();
const { hashPassword } = require('../../src/config/auth');
const { runSql } = require('../../src/services/db-pool');

async function main() {
    const hash = await hashPassword('password123');
    await runSql('UPDATE users SET password_hash = $1 WHERE id = 3', [hash]);
    console.log('SUCCESS_ADMIN_PW_UPDATED');
    process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
