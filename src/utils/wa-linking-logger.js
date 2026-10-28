/**
 * src/utils/wa-linking-logger.js
 *
 * Real-time, sanitized, relative-timestamped linking diagnostics for WhatsApp Web client.
 * Writes to console and to logs/wa-linking-<userId>.log
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOGS_DIR)) {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
        }
    } catch (_) {}
}

function hashQR(qrStr) {
    if (!qrStr || typeof qrStr !== 'string') return null;
    return crypto.createHash('sha256').update(qrStr).digest('hex').slice(0, 12);
}

function maskPhone(phone) {
    const s = String(phone || '');
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function getFromShape(rawFrom) {
    const s = String(rawFrom || '');
    if (s.endsWith('@c.us')) return '@c.us';
    if (s.endsWith('@lid')) return '@lid';
    if (s.endsWith('@g.us')) return '@g.us';
    if (s.endsWith('@broadcast')) return '@broadcast';
    return 'other';
}

class LinkingTracker {
    constructor(userId) {
        this.userId = Number(userId);
        this.startTime = Date.now();
        this.lastQRAt = null;
        this.qrCounter = 0;
        this.currentQRHash = null;
        this.lastEvent = null;
        this.lastEventAt = null;
        this.inboundEventCount = 0;
        this.lastInboundEventAt = null;
        this.lastInboundStage = null;
        this.lastInboundReason = null;
        this.lastFrameNavigationAt = null;
        this.readyAt = null;
        this.clientGeneration = 0;
        this.logFile = path.join(LOGS_DIR, `wa-linking-${this.userId}.log`);
        ensureLogDir();
    }

    reset() {
        this.startTime = Date.now();
        this.lastQRAt = null;
        this.qrCounter = 0;
        this.currentQRHash = null;
        this.lastEvent = null;
        this.lastEventAt = null;
        this.clientGeneration++;
    }

    log(stage, details = '') {
        const now = Date.now();
        const relMs = now - this.startTime;
        this.lastEvent = stage;
        this.lastEventAt = now;

        const line = `[+${relMs}ms] [user ${this.userId}] [STAGE:${stage}]${details ? ' ' + details : ''}`;
        console.log(line);
        try {
            ensureLogDir();
            fs.appendFileSync(this.logFile, line + '\n', 'utf8');
        } catch (_) {}
    }

    logLibraryFacts(facts = {}) {
        this.log('LIBRARY_FACTS', `wwebjs="${facts.wwebjsVersion || 'unknown'}" puppeteer="${facts.puppeteerVersion || 'unknown'}" chrome="${facts.chromeVersion || 'pending'}" webVersionCache="${facts.webVersionCache || 'none'}"`);
    }

    onQR(qrStr) {
        this.qrCounter++;
        const now = Date.now();
        const secSincePrev = this.lastQRAt ? ((now - this.lastQRAt) / 1000).toFixed(1) : 'first';
        this.lastQRAt = now;
        this.currentQRHash = hashQR(qrStr);
        this.log('QR', `count=${this.qrCounter} sec_since_prev=${secSincePrev}s hash=${this.currentQRHash}`);
    }

    onReady(phone) {
        this.readyAt = Date.now();
        const masked = maskPhone(phone);
        this.log('READY', `phone=${masked}`);
    }

    onFrameNavigated(url = '') {
        this.lastFrameNavigationAt = Date.now();
        let safeUrl = url;
        try {
            const u = new URL(url);
            safeUrl = `${u.origin}${u.pathname}`;
        } catch (_) {
            safeUrl = String(url).split('?')[0];
        }
        this.log('PAGE_FRAMENAVIGATED', `url="${safeUrl}"`);
    }

    onInboundEvent(event, meta = {}) {
        this.inboundEventCount++;
        this.lastInboundEventAt = Date.now();
        this.lastInboundStage = meta.stage || event;
        this.lastInboundReason = meta.reason || null;

        const id = meta.id || 'none';
        const type = meta.type || 'text';
        const fromMe = meta.fromMe ? 'true' : 'false';
        const isGroup = meta.isGroup ? 'true' : 'false';
        const isStatus = meta.isStatus ? 'true' : 'false';
        const shape = meta.fromShape || 'other';
        const from = meta.maskedFrom || 'unknown';
        const stage = meta.stage || event;
        const reason = meta.reason ? ` reason="${meta.reason}"` : '';

        this.log(`INBOUND_${event.toUpperCase()}`, `id=${id} type=${type} fromMe=${fromMe} isGroup=${isGroup} isStatus=${isStatus} shape=${shape} from=${from} stage=${stage}${reason}`);
    }

    onInboundStage(stage, reason = '') {
        this.lastInboundStage = stage;
        this.lastInboundReason = reason || null;
        this.log(`INBOUND_STAGE:${stage}`, reason ? `reason="${reason}"` : '');
    }

    logTimer(timerName, action, details = '') {
        this.log(`TIMER_${action.toUpperCase()}`, `${timerName}${details ? ' ' + details : ''}`);
    }
}

const activeTrackers = new Map();

function getLinkingTracker(userId) {
    userId = Number(userId);
    let tracker = activeTrackers.get(userId);
    if (!tracker) {
        tracker = new LinkingTracker(userId);
        activeTrackers.set(userId, tracker);
    }
    return tracker;
}

function attachPageDiagnostics(page, tracker, onNavigation = null) {
    if (!page || typeof page.on !== 'function') return;

    page.on('console', msg => {
        try {
            if (msg.type() === 'error') {
                tracker.log('PAGE_CONSOLE_ERROR', String(msg.text() || '').slice(0, 300));
            }
        } catch (_) {}
    });

    page.on('pageerror', err => {
        try {
            tracker.log('PAGE_ERROR', (err.message || String(err)).slice(0, 300));
        } catch (_) {}
    });

    page.on('requestfailed', req => {
        try {
            const rawUrl = req.url();
            const u = new URL(rawUrl);
            const method = req.method ? req.method() : 'GET';
            const failure = req.failure ? req.failure() : null;
            tracker.log('REQUEST_FAILED', `${method} ${u.host}${u.pathname} (${failure?.errorText || 'failed'})`);
        } catch (_) {}
    });

    page.on('load', async () => {
        tracker.log('PAGE_LOAD', 'DOM load complete');
        try {
            const waVer = await page.evaluate(() => {
                try {
                    return window.Debug?.VERSION || (window.require && window.require('WAWebSocketModel')?.Socket?.phoneInfo?.waVersion) || 'unknown';
                } catch (_) {
                    return 'eval_error';
                }
            });
            tracker.log('WA_WEB_VERSION', `version=${waVer}`);
        } catch (_) {}
    });

    page.on('framenavigated', frame => {
        try {
            // Main frame navigation only to avoid iframe noise
            if (!frame.parentFrame || frame === page.mainFrame()) {
                const url = frame.url();
                tracker.onFrameNavigated(url);
                if (typeof onNavigation === 'function') {
                    onNavigation(url, frame);
                }
            }
        } catch (_) {}
    });

    page.on('domcontentloaded', () => {
        tracker.log('PAGE_DOMCONTENTLOADED');
    });

    page.on('close', () => {
        tracker.log('PAGE_CLOSE');
    });

    page.on('crash', () => {
        tracker.log('PAGE_CRASH');
    });
}


const { LocalAuth } = require('whatsapp-web.js');

class InstrumentedLocalAuth extends LocalAuth {
    constructor(opts, tracker, onNavigation = null) {
        super(opts);
        this.tracker = tracker;
        this.onNavigation = onNavigation;
    }

    async beforeBrowserInitialized() {
        await super.beforeBrowserInitialized();
        if (this.tracker) {
            const pOpts = this.client?.options?.puppeteer || {};
            const execPath = pOpts.executablePath || 'default (bundled puppeteer chrome)';
            const args = (pOpts.args || []).join(' ');
            this.tracker.log('CHROME_LAUNCH_START', `execPath="${execPath}" args="${args}"`);
        }
    }

    async afterBrowserInitialized() {
        if (typeof super.afterBrowserInitialized === 'function') {
            await super.afterBrowserInitialized();
        }
        if (this.tracker) {
            const browser = this.client?.pupBrowser;
            const page = this.client?.pupPage;
            let chromeVer = 'unknown';
            try {
                if (browser && typeof browser.version === 'function') {
                    chromeVer = await browser.version();
                }
            } catch (_) {}
            this.tracker.log('CHROME_LAUNCH_END', `chromeVersion="${chromeVer}"`);
            if (page) {
                attachPageDiagnostics(page, this.tracker, this.onNavigation);
            }
        }
    }
}

module.exports = {
    LinkingTracker,
    getLinkingTracker,
    attachPageDiagnostics,
    InstrumentedLocalAuth,
    hashQR,
    maskPhone,
    getFromShape
};

