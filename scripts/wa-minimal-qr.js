/**
 * scripts/wa-minimal-qr.js
 *
 * Phase B1: Bare whatsapp-web.js client using LocalAuth with throwaway clientId
 * and temp dataPath. Uses identical Chrome executable and launch args as the app.
 * Only logs lifecycle events with relative ms timestamps. No DB, no message sending.
 */
'use strict';

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { InstrumentedLocalAuth } = require('../src/utils/wa-linking-logger');

const startTime = Date.now();
const tempDir = path.join(os.tmpdir(), `wa-minimal-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });

let qrCounter = 0;
let firstQrAt = null;
let lastQrAt = null;
let authenticatedAt = null;
let readyAt = null;

function relMs() {
    return `+${Date.now() - startTime}ms`;
}

function hashQR(qrStr) {
    if (!qrStr) return null;
    return crypto.createHash('sha256').update(qrStr).digest('hex').slice(0, 12);
}

function log(stage, details = '') {
    const line = `[${relMs()}] [MINIMAL] [STAGE:${stage}]${details ? ' ' + details : ''}`;
    console.log(line);
}

let wwebjsVersion = 'unknown';
try { wwebjsVersion = require('whatsapp-web.js/package.json').version; } catch (_) {}
let puppeteerVersion = 'unknown';
try { puppeteerVersion = require('puppeteer/package.json').version; } catch (_) {}

log('INIT_REQUESTED', `tempDataPath="${tempDir}"`);
log('LIBRARY_FACTS', `wwebjs="${wwebjsVersion}" puppeteer="${puppeteerVersion}" chrome="pending" webVersionCache="none"`);

const trackerAdapter = {
    log(stage, details) {
        log(stage, details);
    }
};

const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--disable-gpu',
    '--disable-extensions',
    '--js-flags=--max-old-space-size=256',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-ipc-flooding-protection',
    '--renderer-process-limit=2',
    '--disable-crash-reporter',
    '--noerrdialogs'
];

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    ? process.env.PUPPETEER_EXECUTABLE_PATH
    : (fs.existsSync('/usr/bin/chromium')
        ? '/usr/bin/chromium'
        : (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : undefined));

const client = new Client({
    authStrategy: new InstrumentedLocalAuth({
        clientId: 'minimal-test',
        dataPath: tempDir
    }, trackerAdapter),
    restartOnAuthFail: false,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    userAgent: process.env.WHATSAPP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    webVersionCache: {
        type: 'none'
    },
    puppeteer: {
        headless: 'new',
        protocolTimeout: 300000,
        ...(executablePath ? { executablePath } : {}),
        args: puppeteerArgs
    }
});

client.on('qr', async (qr) => {
    qrCounter++;
    const now = Date.now();
    if (!firstQrAt) firstQrAt = now;
    const secSincePrev = lastQrAt ? ((now - lastQrAt) / 1000).toFixed(1) : 'first';
    lastQrAt = now;
    const hash = hashQR(qr);

    log('QR', `count=${qrCounter} sec_since_prev=${secSincePrev}s hash=${hash}`);

    try {
        const terminalQR = await qrcode.toString(qr, { type: 'terminal', small: true });
        console.log('\n' + terminalQR);
        console.log(`\n============================================================`);
        console.log(`>>> OWNER ACTION NEEDED: Scan the QR code above with WhatsApp`);
        console.log(`    (WhatsApp -> Settings -> Linked devices -> Link a device)`);
        console.log(`============================================================\n`);
    } catch (e) {
        console.error('Failed to render terminal QR:', e.message);
    }
});

client.on('loading_screen', (percent, message) => {
    log('LOADING_SCREEN', `percent=${percent}% message="${message || 'syncing'}"`);
});

client.on('change_state', (state) => {
    log('CHANGE_STATE', `state=${state}`);
});

client.on('authenticated', () => {
    authenticatedAt = Date.now();
    const timeFromFirstQR = firstQrAt ? ((authenticatedAt - firstQrAt) / 1000).toFixed(1) : 'unknown';
    log('AUTHENTICATED', `time_from_first_qr=${timeFromFirstQR}s`);
});

client.on('ready', () => {
    readyAt = Date.now();
    const timeToFirstQR = firstQrAt ? ((firstQrAt - startTime) / 1000).toFixed(1) : 'unknown';
    const scanToAuth = (firstQrAt && authenticatedAt) ? ((authenticatedAt - firstQrAt) / 1000).toFixed(1) : 'unknown';
    const authToReady = authenticatedAt ? ((readyAt - authenticatedAt) / 1000).toFixed(1) : 'unknown';
    const totalTime = ((readyAt - startTime) / 1000).toFixed(1);

    const rawPhone = client.info?.wid?.user || 'unknown';
    const maskedPhone = rawPhone.length > 8 ? `${rawPhone.slice(0, 4)}****${rawPhone.slice(-4)}` : '***';

    log('READY', `phone=${maskedPhone}`);

    console.log(`\n================== MINIMAL TEST RESULTS ==================`);
    console.log(`Time to first QR:        ${timeToFirstQR}s`);
    console.log(`Time from scan to auth:  ${scanToAuth}s`);
    console.log(`Time from auth to ready: ${authToReady}s`);
    console.log(`Total time to ready:     ${totalTime}s`);
    console.log(`==========================================================\n`);
});

client.on('auth_failure', (msg) => {
    log('AUTH_FAILURE', `msg="${msg}"`);
});

client.on('disconnected', (reason) => {
    log('DISCONNECTED', `reason="${reason}"`);
});

async function cleanup() {
    console.log('\nCleaning up minimal client and temp data...');
    try {
        await client.destroy().catch(() => {});
    } catch (_) {}
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

log('CLIENT_INITIALIZE_START');
client.initialize().catch((err) => {
    log('CLIENT_INITIALIZE_ERROR', err.message);
});
