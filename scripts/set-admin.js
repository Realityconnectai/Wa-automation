/**
 * scripts/set-admin.js — Create, approve, or elevate an account to Admin with a specified password.
 * Compatible with PostgreSQL persistence layer.
 *
 * Usage:
 *   node scripts/set-admin.js <email> <password> [businessName]
 */
'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const db = require(path.join(__dirname, '..', 'src', 'services', 'database'));

(async () => {
    await db.initDatabase();

    const email = (process.argv[2] || '').trim().toLowerCase();
    const password = process.argv[3];
    const businessName = process.argv[4] || 'RealityConnect AI';

    if (!email || !password) {
        console.error('Usage: node scripts/set-admin.js <email> <password> [businessName]');
        process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await db.getUserByEmail(email);

    if (existing) {
        await db.updateUser(existing.id, {
            role: 'admin',
            status: 'active',
            password_hash: passwordHash,
            business_name: existing.business_name || businessName
        });
        console.log(`\n✅ Account #${existing.id} (${email}) has been approved and promoted to ADMIN.`);
    } else {
        const user = await db.createUser({
            email,
            passwordHash,
            businessName,
            ownerName: 'Admin',
            role: 'admin',
            status: 'active',
            plan: 'enterprise'
        });
        console.log(`\n✅ New ADMIN account #${user.id} (${email}) created and approved.`);
    }

    console.log(`\nAccount Details:`);
    console.log(`  Email:    ${email}`);
    console.log(`  Role:     admin`);
    console.log(`  Status:   active (approved)`);
    console.log(`  Panel:    http://13.60.26.204:3000/login\n`);

    await db.closeDatabase();
})().catch(err => {
    console.error('❌ Failed to set admin account:', err);
    process.exit(1);
});
