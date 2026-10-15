'use strict';
// Lists inline style attributes in first-party public source. This is a
// migration aid; the permanent Jest scan is added after cleanup.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const rows = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(?:html|js)$/i.test(entry.name) && entry.name !== 'chart.umd.min.js') {
            const text = fs.readFileSync(file, 'utf8');
            for (const match of text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g)) {
                const line = text.slice(0, match.index).split(/\r?\n/).length;
                rows.push({ file: path.relative(process.cwd(), file), line, style: match[2] });
            }
        }
    }
}
walk(root);
const groups = new Map();
const byFile = new Map();
for (const row of rows) {
    groups.set(row.style, [...(groups.get(row.style) || []), row]);
    byFile.set(row.file, [...(byFile.get(row.file) || []), row]);
}
for (const [file, items] of byFile) {
    console.log(`\n=== ${file} (${items.length} styles) ===`);
    for (const item of items) {
        console.log(`  L${item.line}: style="${item.style}"`);
    }
}
console.error(`\nTotal inline style attributes: ${rows.length}`);
if (process.argv.includes('--check') && rows.length > 0) {
    process.exit(1);
}
