/**
 * scripts/wa-minimal-listen.js
 *
 * Phase B1: Bare whatsapp-web.js client with full message and navigation instrumentation.
 * Sends nothing. Throwaway auth folder and own Chrome profile.
 * Logs relative timestamps, shapes, IDs, stages, and no bodies.
 */
'use strict';

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { InstrumentedLocalAuth, maskPhone, getFromShape } = require('../src/utils/wa-linking-logger');

const startTime = Date.now();
const tempDir = path.join(os.tmpdir(), `wa-minimal-listen-${Date.now()}`);
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
    const line = `[${relMs()}] [MINIMAL-LISTEN] [STAGE:${stage}]${details ? ' ' + details : ''}`;
    console.log(line);
}

let wwebjsVersion = 'unknown';
try { wwebjsVersion = require('whatsapp-web.js/package.json').version; } catch (_) {}
let puppeteerVersion = 'unknown';
try { puppeteerVersion = require('puppeteer/package.json').version; } catch (_) {}

log('INIT_REQUESTED', `tempDataPath="${tempDir}"`);
log('LIBRARY_FACTS', `wwebjs="${wwebjsVersion}" puppeteer="${puppeteerVersion}" chrome="pending" webVersionCache="none"`);

let firstNavAfterReadyAt = null;
const inboundEventsHistory = [];

const trackerAdapter = {
    log(stage, details) {
        log(stage, details);
    },
    onFrameNavigated(url = '') {
        let safeUrl = url;
        try {
            const u = new URL(url);
            safeUrl = `${u.origin}${u.pathname}`;
        } catch (_) {
            safeUrl = String(url).split('?')[0];
        }
        if (readyAt && !firstNavAfterReadyAt) {
            firstNavAfterReadyAt = Date.now();
            log('PAGE_FRAMENAVIGATED_POST_READY', `url="${safeUrl}" delay_from_ready=${((firstNavAfterReadyAt - readyAt) / 1000).toFixed(1)}s`);
        } else {
            log('PAGE_FRAMENAVIGATED', `url="${safeUrl}"`);
        }
    },
    onInboundEvent(event, meta = {}) {
        const id = meta.id || 'none';
        const type = meta.type || 'text';
        const fromMe = meta.fromMe ? 'true' : 'false';
        const isGroup = meta.isGroup ? 'true' : 'false';
        const isStatus = meta.isStatus ? 'true' : 'false';
        const shape = meta.fromShape || 'other';
        const from = meta.maskedFrom || 'unknown';
        const stage = meta.stage || event;
        const reason = meta.reason ? ` reason="${meta.reason}"` : '';

        log(`INBOUND_${event.toUpperCase()}`, `id=${id} type=${type} fromMe=${fromMe} isGroup=${isGroup} isStatus=${isStatus} shape=${shape} from=${from} stage=${stage}${reason}`);

        if (event === 'message' || event === 'message_create') {
            const now = Date.now();
            const delaySec = readyAt ? ((now - readyAt) / 1000).toFixed(1) + 's' : 'pre-ready';
            const navTiming = firstNavAfterReadyAt ? 'after' : 'before';
            inboundEventsHistory.push({
                num: inboundEventsHistory.length + 1,
                event,
                time: new Date().toLocaleTimeString(),
                id: String(id).slice(-10),
                from,
                fromMe,
                isGroup,
                delaySec,
                navTiming
            });
        }
    },
    onInboundStage(stage, reason = '') {
        log(`INBOUND_STAGE:${stage}`, reason ? `reason="${reason}"` : '');
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
        clientId: 'minimal-listener',
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
    log('READY', `phone=${maskPhone(rawPhone)}`);

    console.log(`\n================== MINIMAL LISTENER READY ==================`);
    console.log(`Time to first QR:        ${timeToFirstQR}s`);
    console.log(`Time from scan to auth:  ${scanToAuth}s`);
    console.log(`Time from auth to ready: ${authToReady}s`);
    console.log(`Total time to ready:     ${totalTime}s`);
    console.log(`Ready at timestamp:      +${Date.now() - startTime}ms`);
    console.log(`------------------------------------------------------------`);
    console.log(`LISTENING FOR INCOMING MESSAGES (SEND 'hi' FROM SECOND PHONE)`);
    console.log(`============================================================\n`);
});

client.on('auth_failure', (msg) => {
    log('AUTH_FAILURE', `msg="${msg}"`);
});

client.on('disconnected', (reason) => {
    log('DISCONNECTED', `reason="${reason}"`);
});

// ── Raw message create event ─────────────────────────────────
client.on('message_create', (msg) => {
    try {
        const msgId = msg?.id?._serialized || null;
        const rawFrom = String(msg?.from || '');
        const msgType = msg?.type || (msg?.hasMedia ? 'media' : 'text');
        const shape = getFromShape(rawFrom);
        trackerAdapter.onInboundEvent('message_create', {
            id: msgId,
            type: msgType,
            fromMe: !!msg?.fromMe,
            isGroup: !!(msg?.isGroupMsg || rawFrom.endsWith('@g.us')),
            isStatus: !!(msg?.isStatus || rawFrom.endsWith('@broadcast')),
            fromShape: shape,
            maskedFrom: maskPhone(rawFrom),
            stage: 'received'
        });
    } catch (_) {}
});

// ── Incoming message ─────────────────────────────────────────
client.on('message', async (msg) => {
    try {
        const msgId = msg?.id?._serialized || null;
        const rawFrom = String(msg?.from || '');
        const msgType = msg?.type || (msg?.hasMedia ? 'media' : 'text');
        const shape = getFromShape(rawFrom);

        trackerAdapter.onInboundEvent('message', {
            id: msgId,
            type: msgType,
            fromMe: !!msg?.fromMe,
            isGroup: !!(msg?.isGroupMsg || rawFrom.endsWith('@g.us')),
            isStatus: !!(msg?.isStatus || rawFrom.endsWith('@broadcast')),
            fromShape: shape,
            maskedFrom: maskPhone(rawFrom),
            stage: 'received'
        });

        if (msg?.isGroupMsg || rawFrom.endsWith('@g.us')) {
            trackerAdapter.onInboundStage('DROP_GROUP', `from=${maskPhone(rawFrom)}`);
            return;
        }
        if (msg?.isStatus || rawFrom.endsWith('@broadcast')) {
            trackerAdapter.onInboundStage('DROP_STATUS');
            return;
        }
        if (msg?.fromMe) {
            trackerAdapter.onInboundStage('DROP_FROM_ME');
            return;
        }

        let phone = rawFrom.split('@')[0].replace(/\D/g, '');
        if (!/^\d{7,15}$/.test(phone)) {
            trackerAdapter.onInboundStage('DROP_INVALID_PHONE', `from=${maskPhone(rawFrom)}`);
            return;
        }

        let contactName = '';
        try {
            const contact = await msg.getContact();
            contactName = String(contact?.pushname || contact?.name || '').slice(0, 200);
            if (contact?.number && /^\d{7,15}$/.test(contact.number)) {
                phone = contact.number;
            }
        } catch (_) {}

        const chars = (msg?.body || '').length;
        trackerAdapter.onInboundStage('TEXT_INBOUND', `id=${msgId} from=${maskPhone(phone)} chars=${chars} name="${contactName}"`);
        console.log(`\n>>> [MINIMAL SUCCESS] Inbound message received! id=${msgId} shape=${shape} from=${maskPhone(phone)}\n`);
    } catch (e) {
        log('HANDLER_ERROR', e.message);
    }
});

// ── Message Ack ──────────────────────────────────────────────
client.on('message_ack', (msg, ack) => {
    try {
        const waId = msg?.id?._serialized;
        const rawTo = String(msg?.to || '');
        const rawFrom = String(msg?.from || '');
        const shape = getFromShape(rawTo || rawFrom);
        log('MESSAGE_ACK', `id=${waId || 'none'} ack=${ack} shape=${shape}`);
    } catch (_) {}
});

function printSummaryTable() {
    console.log('\n================================== SUMMARY TABLE ==================================');
    console.log(`First Navigation Post-Ready: ${firstNavAfterReadyAt ? `Yes (${((firstNavAfterReadyAt - readyAt) / 1000).toFixed(1)}s after ready)` : 'No'}`);
    console.log(`Total Inbound Message Events Received: ${inboundEventsHistory.length}`);
    console.log('-----------------------------------------------------------------------------------');
    console.log('| Send # | Event          | Time     | From (Masked) | Delay  | Before/After Nav  |');
    console.log('-----------------------------------------------------------------------------------');
    if (inboundEventsHistory.length === 0) {
        console.log('| (No inbound message events received)                                             |');
    } else {
        inboundEventsHistory.forEach(item => {
            const num = String(item.num).padEnd(6);
            const evt = String(item.event).padEnd(14);
            const tm = String(item.time).padEnd(8);
            const fr = String(item.from).padEnd(13);
            const dl = String(item.delaySec).padEnd(6);
            const nav = String(item.navTiming).padEnd(17);
            console.log(`| ${num} | ${evt} | ${tm} | ${fr} | ${dl} | ${nav} |`);
        });
    }
    console.log('===================================================================================\n');
}

async function cleanup() {
    printSummaryTable();
    console.log('Cleaning up minimal listener client and temp data...');
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
