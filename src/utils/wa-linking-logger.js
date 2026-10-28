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

class LinkingTracker {
    constructor(userId) {
        this.userId = Number(userId);
        this.startTime = Date.now();
        this.lastQRAt = null;
        this.qrCounter = 0;
        this.currentQRHash = null;
        this.lastEvent = null;
        this.lastEventAt = null;
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

function attachPageDiagnostics(page, tracker) {
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
}

const { LocalAuth } = require('whatsapp-web.js');

class InstrumentedLocalAuth extends LocalAuth {
    constructor(opts, tracker) {
        super(opts);
        this.tracker = tracker;
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
                attachPageDiagnostics(page, this.tracker);
            }
        }
    }
}

module.exports = {
    LinkingTracker,
    getLinkingTracker,
    attachPageDiagnostics,
    InstrumentedLocalAuth,
    hashQR
};

