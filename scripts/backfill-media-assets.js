require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { runSql, queryAll } = require('../src/services/db-pool');

const MAX_DB_BYTES = 16 * 1024 * 1024; // 16 MB

async function backfill() {
    console.log('--- BACKFILLING MEDIA ASSETS TO DATABASE ---');
    const rows = await queryAll('SELECT id, user_id, file_name, storage_path, size_bytes, data, sha256 FROM media_assets');
    console.log(`Found ${rows.length} asset(s) in media_assets.`);

    for (const row of rows) {
        if (!fs.existsSync(row.storage_path)) {
            console.warn(`⚠️ Asset ${row.id} (${row.file_name}) missing at ${row.storage_path}. Marking inactive.`);
            await runSql('UPDATE media_assets SET is_active=0 WHERE id=$1', [row.id]);
            continue;
        }

        const buf = fs.readFileSync(row.storage_path);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const sizeBytes = buf.length;

        if (sizeBytes <= MAX_DB_BYTES) {
            await runSql(`
                UPDATE media_assets 
                SET data = $1, sha256 = $2, size_bytes = $3, source_type = 'upload', uploaded_by = $4, is_active = 1
                WHERE id = $5
            `, [buf, hash, sizeBytes, row.user_id, row.id]);
            console.log(`✔ Asset ${row.id} (${row.file_name}): stored ${sizeBytes} bytes in DB, sha256=${hash.slice(0, 16)}...`);
        } else {
            await runSql(`
                UPDATE media_assets 
                SET sha256 = $1, size_bytes = $2, source_type = 'upload', uploaded_by = $3, is_active = 1
                WHERE id = $4
            `, [hash, sizeBytes, row.user_id, row.id]);
            console.log(`✔ Asset ${row.id} (${row.file_name}): file exceeds 16MB (${sizeBytes} bytes), stored sha256=${hash.slice(0, 16)}...`);
        }
    }
    console.log('Backfill complete.');
}

backfill().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
