require('dotenv').config();
const { queryAll, queryGet, closePool } = require('../src/services/db-pool');

async function main() {
    const job = await queryGet('SELECT * FROM outreach_jobs WHERE id = $1', ['dd290e5a-9a2d-4710-989e-305ae3fd0145']);
    console.log('--- OUTREACH JOB ---');
    console.log(JSON.stringify(job, null, 2));

    const recipients = await queryAll('SELECT * FROM outreach_recipients WHERE job_id = $1', ['dd290e5a-9a2d-4710-989e-305ae3fd0145']);
    console.log('--- RECIPIENTS ---');
    console.log(JSON.stringify(recipients, null, 2));

    const tables = await queryAll("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('TABLES:', tables.map(t => t.table_name));

    const asset = await queryGet('SELECT * FROM media_assets WHERE id = $1', [job.media_asset_id]);
    console.log('--- MEDIA ASSET ---');
    console.log(JSON.stringify(asset, null, 2));

    const contacts = await queryAll('SELECT * FROM contacts WHERE id IN (1, 38)');
    console.log('--- CONTACTS 1 & 38 ---');
    console.log(JSON.stringify(contacts, null, 2));

    await closePool();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
