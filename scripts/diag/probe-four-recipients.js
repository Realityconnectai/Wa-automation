require('dotenv').config();
const { runSql } = require('../../src/services/db-pool');
const { getSession, resolveDestinationChatId } = require('../../src/services/whatsapp-client');

async function main() {
    console.log('--- Probing Four Recipients of Campaign 4cd6e5aa-604a-439e-908e-df2354f91f94 ---');
    const res = await runSql(`
        SELECT r.*, c.phone as contact_phone, c.name as contact_name
        FROM outreach_recipients r
        LEFT JOIN contacts c ON c.id = r.contact_id
        WHERE r.job_id = '4cd6e5aa-604a-439e-908e-df2354f91f94'
    `);
    console.log('Database Rows:', JSON.stringify(res.rows, null, 2));

    // Also check contacts table for "Aaryan" vs "aaryan"
    const contactsRes = await runSql(`
        SELECT id, name, phone, user_id, created_at
        FROM contacts
        WHERE name ILIKE '%aaryan%' OR phone LIKE '%105957396857003%' OR phone LIKE '%8950153750%' OR id = 34
    `);
    console.log('Contacts matching Aaryan / numbers:', JSON.stringify(contactsRes.rows, null, 2));

    for (const uid of [1, 2, 3]) {
        const session = getSession(uid, false);
        console.log(`Session user ${uid} status:`, {
            hasSession: !!session,
            isConnected: session?.isConnected,
            hasClient: !!session?.client
        });
    }

    if (session?.client) {
        for (const row of res.rows) {
            console.log(`\nTesting client resolution for: ${row.name} (${row.phone})`);
            try {
                const getNumberIdRes = await session.client.getNumberId(row.phone).catch(e => `Error: ${e.message}`);
                console.log(`  client.getNumberId('${row.phone}'):`, getNumberIdRes);
            } catch (err) {
                console.log(`  client.getNumberId threw:`, err.message);
            }

            try {
                const isRegisteredRes = await session.client.isRegisteredUser ? await session.client.isRegisteredUser(row.phone).catch(e => `Error: ${e.message}`) : 'N/A';
                console.log(`  client.isRegisteredUser('${row.phone}'):`, isRegisteredRes);
            } catch (err) {
                console.log(`  client.isRegisteredUser threw:`, err.message);
            }

            try {
                const resolvedChatId = await resolveDestinationChatId(session.client, row.phone);
                console.log(`  resolveDestinationChatId:`, resolvedChatId);
            } catch (err) {
                console.log(`  resolveDestinationChatId threw:`, err.message);
            }
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Probe failed:', err);
    process.exit(1);
});
