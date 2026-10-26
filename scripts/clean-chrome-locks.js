const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function killOrphanPuppeteerProcesses() {
    if (process.platform === 'win32') {
        try {
            const scriptPath = path.resolve(__dirname, 'kill-puppeteer-chrome.ps1');
            const { execFileSync } = require('child_process');
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', stdio: 'inherit' });
        } catch (e) {
            // Non-fatal
        }
    } else {
        try {
            execSync("pkill -f 'puppeteer.*chrome' || true", { stdio: 'ignore' });
        } catch (_) {}
    }
}

function cleanAuthLocks(targetDir) {
    const authDir = targetDir || path.resolve('.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;

    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile', 'LOCK'];

    function cleanDir(d) {
        try {
            for (const item of fs.readdirSync(d)) {
                const p = path.join(d, item);
                try {
                    const st = fs.lstatSync(p);
                    if (lockFiles.includes(item)) {
                        fs.rmSync(p, { force: true });
                        console.log('Removed lock:', p);
                    } else if (st.isDirectory()) {
                        cleanDir(p);
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }

    cleanDir(authDir);
}

if (require.main === module) {
    console.log('--- Cleaning Chrome Locks & Puppeteer processes ---');
    killOrphanPuppeteerProcesses();
    cleanAuthLocks();
    console.log('✅ Cleanup complete.');
}

module.exports = {
    killOrphanPuppeteerProcesses,
    cleanAuthLocks
};
