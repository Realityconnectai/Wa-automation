'use strict';
const fs = require('fs');
const path = require('path');

const iconsFile = fs.readFileSync('public/js/icons.js', 'utf8');
const match = iconsFile.match(/const ICONS = {([\s\S]*?)};/);
const definedIcons = new Set();
for (const m of match[1].matchAll(/'([^']+)'\s*:/g)) {
    definedIcons.add(m[1]);
}
console.log('Defined icons count:', definedIcons.size);

const usedIcons = new Map();
function scan(file) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/data-icon="([^"]+)"/g)) {
        if (!usedIcons.has(m[1])) usedIcons.set(m[1], []);
        usedIcons.get(m[1]).push(file);
    }
    for (const m of text.matchAll(/Icon\('([^']+)'/g)) {
        if (!usedIcons.has(m[1])) usedIcons.set(m[1], []);
        usedIcons.get(m[1]).push(file);
    }
}

['public/index.html', 'public/admin.html', 'public/landing.html', 'public/login.html', 'public/signup.html', 'public/js/app.js', 'public/js/admin.js'].forEach(f => {
    if (fs.existsSync(f)) scan(f);
});

console.log('Used unique icons count:', usedIcons.size);
const missing = [];
for (const [icon, files] of usedIcons.entries()) {
    if (!definedIcons.has(icon)) {
        missing.push({ icon, files });
    }
}
if (missing.length > 0) {
    console.error('❌ Missing icons found:', missing);
    process.exit(1);
} else {
    console.log('✅ All used icons are defined in public/js/icons.js!');
}
