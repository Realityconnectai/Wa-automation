require('dotenv').config();
const { getSession } = require('../../src/services/whatsapp-client');

async function main() {
    const s = getSession(3, false);
    if (!s || !s.client || !s.isConnected) {
        console.log('User 3 session is not connected');
        process.exit(1);
    }

    const { queryAll } = require('../../src/services/db-pool');
    const dbContacts = await queryAll("SELECT id, user_id, name, phone FROM contacts WHERE name ILIKE '%Aaryan%' OR phone LIKE '%105957396857003%'");
    console.log('DB CONTACTS:', dbContacts);

    const testId = '105957396857003';
    console.log('Testing resolution for recipient:', testId);

    try {
        const numId = await s.client.getNumberId(testId);
        console.log('getNumberId result:', numId);
    } catch (e) {
        console.log('getNumberId error:', e);
    }

    try {
        const contactLid = await s.client.getContactById(`${testId}@lid`);
        console.log('contact @lid:', contactLid ? { id: contactLid.id, name: contactLid.name, number: contactLid.number } : null);
    } catch (e) {
        console.log('contact @lid error:', e);
    }

    try {
        const chatLid = await s.client.getChatById(`${testId}@lid`);
        console.log('chat @lid:', chatLid ? { id: chatLid.id, name: chatLid.name } : null);
    } catch (e) {
        console.log('chat @lid error:', e);
    }

    try {
        const contactCus = await s.client.getContactById(`${testId}@c.us`);
        console.log('contact @c.us:', contactCus ? { id: contactCus.id, name: contactCus.name, number: contactCus.number } : null);
    } catch (e) {
        console.log('contact @c.us error:', e);
    }

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
