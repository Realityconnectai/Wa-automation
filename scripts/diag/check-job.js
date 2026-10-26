require('dotenv').config();
const { queryAll } = require('../../src/services/db-pool');

async function main() {
    const rows = await queryAll("SELECT id, status, total, started_at, finished_at FROM outreach_jobs WHERE id = $1", ['21b127d7-0e96-44cc-b238-bea99f19fe45']);
    console.log('REPAIRED JOB RECORD:', JSON.stringify(rows[0], null, 2));
    const recipients = await queryAll("SELECT id, status, reason FROM outreach_recipients WHERE job_id = $1", ['21b127d7-0e96-44cc-b238-bea99f19fe45']);
    console.log('RECIPIENTS:', JSON.stringify(recipients, null, 2));
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
