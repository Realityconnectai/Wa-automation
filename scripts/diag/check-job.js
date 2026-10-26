require('dotenv').config();
const { queryAll } = require('../../src/services/db-pool');

async function main() {
    const jobs = await queryAll("SELECT id, status, total, started_at, finished_at, error FROM outreach_jobs ORDER BY started_at DESC LIMIT 5");
    console.log('LATEST JOBS:', JSON.stringify(jobs, null, 2));

    const recipients = await queryAll("SELECT r.id, r.job_id, r.phone, r.contact_name, r.status, r.reason, r.sent_at FROM outreach_recipients r WHERE r.phone LIKE '%105957396857003%' OR r.job_id = '4cd6e5aa-604a-439e-908e-df2354f91f94' ORDER BY r.id DESC");
    console.log('MATCHING RECIPIENTS:', JSON.stringify(recipients, null, 2));

    const contacts = await queryAll("SELECT id, user_id, name, phone, last_outreach_at FROM contacts WHERE name ILIKE '%Aaryan%' OR phone LIKE '%105957396857003%'");
    console.log('DB CONTACTS FOR AARYAN:', JSON.stringify(contacts, null, 2));
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
