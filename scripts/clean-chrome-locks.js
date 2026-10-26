const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('--- Cleaning Chrome Locks & Puppeteer processes ---');

try {
    const out = execSync('wmic process where "name=\'chrome.exe\'" get processid,executablepath', { encoding: 'utf8' });
    const lines = out.split('\n');
    for (const line of lines) {
        if (line.toLowerCase().includes('puppeteer')) {
            const match = line.trim().match(/\d+$/);
            if (match) {
                const pid = match[0];
                console.log('Terminating orphan Puppeteer Chrome PID:', pid);
                try {
                    execSync(`taskkill /F /PID ${pid}`);
                } catch (_) {}
            }
        }
    }
} catch (e) {
    console.log('WMIC query note:', e.message);
}

const authDir = path.resolve('.wwebjs_auth');
if (fs.existsSync(authDir)) {
    console.log('Scanning auth directory for stale lock files:', authDir);
    function cleanDir(d) {
        try {
            for (const item of fs.readdirSync(d)) {
                const p = path.join(d, item);
                if (['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].includes(item)) {
                    try {
                        fs.rmSync(p, { force: true });
                        console.log('Removed lock:', p);
                    } catch (err) {
                        console.log('Could not remove lock:', p, err.message);
                    }
                } else {
                    try {
                        if (fs.statSync(p).isDirectory()) cleanDir(p);
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }
    cleanDir(authDir);
}

console.log('✅ Cleanup complete.');
