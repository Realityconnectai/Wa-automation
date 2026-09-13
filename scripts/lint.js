/**
 * Cross-platform syntax checker for JavaScript source files.
 * Replaces platform-dependent shell globs (e.g. `node -c src/**\/*.js`).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

let hasError = false;
let checkedCount = 0;

function checkDir(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'coverage') {
                checkDir(fullPath);
            }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            try {
                cp.execFileSync(process.execPath, ['-c', fullPath], { stdio: 'pipe' });
                checkedCount++;
            } catch (err) {
                console.error(`Syntax error in ${fullPath}:`, err.message);
                hasError = true;
            }
        }
    }
}

const rootDir = path.resolve(__dirname, '..');
const targets = ['src', 'scripts', 'tests', 'server.js', 'launcher.js'];

for (const target of targets) {
    const fullTarget = path.join(rootDir, target);
    if (fs.existsSync(fullTarget)) {
        if (fs.statSync(fullTarget).isDirectory()) {
            checkDir(fullTarget);
        } else if (fullTarget.endsWith('.js')) {
            try {
                cp.execFileSync(process.execPath, ['-c', fullTarget], { stdio: 'pipe' });
                checkedCount++;
            } catch (err) {
                console.error(`Syntax error in ${fullTarget}:`, err.message);
                hasError = true;
            }
        }
    }
}

if (hasError) {
    console.error(`\n❌ Syntax validation failed.`);
    process.exit(1);
} else {
    console.log(`✓ All ${checkedCount} JavaScript files passed syntax validation.`);
}
