require('dotenv').config();
const { runSql } = require('../src/services/db-pool');

async function main() {
    const cols = await runSql(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = 'media_assets' 
        ORDER BY ordinal_position
    `);
    console.log('Columns of media_assets:');
    console.table(cols.rows);

    const rows = await runSql('SELECT id, user_id, project_id, asset_type, file_name, mime_type, size_bytes, storage_path FROM media_assets');
    console.log('\nRows in media_assets:');
    console.table(rows.rows);
}

main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
