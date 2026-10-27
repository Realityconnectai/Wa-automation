/**
 * scripts/wa-observe.js
 *
 * Polls GET /api/whatsapp/debug and GET /api/status every 2s and logs state
 * transitions with timestamps, plus what the UI status endpoint reports at
 * the exact same moment. Used as automated runtime evidence across all lifecycle tests.
 *
 * Usage:
 *   CLI:
 *     node scripts/wa-observe.js --url http://localhost:3000 --cookie "connect.sid=..."
 *     node scripts/wa-observe.js --email admin@example.com --password secret --url http://localhost:3000
 *
 *   Programmatic:
 *     const { createObserver } = require('./scripts/wa-observe');
 *     const obs = createObserver({ baseUrl, cookie, intervalMs: 2000 });
 *     await obs.start();
 *     ...
 *     obs.stop();
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'wa-observe.log');

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOGS_DIR)) {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
        }
    } catch (_) {}
}

function appendLog(line) {
    ensureLogDir();
    try {
        fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch (_) {}
}

function requestJson(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOpts = {
            method: options.method || 'GET',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            headers: options.headers || {}
        };

        const req = client.request(reqOpts, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(body);
                } catch (_) {
                    parsed = body;
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    data: parsed
                });
            });
        });

        req.on('error', err => reject(err));
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

function formatTimers(timers) {
    if (!timers) return 'none';
    const active = Object.entries(timers)
        .filter(([, v]) => !!v)
        .map(([k]) => k);
    return active.length > 0 ? active.join(',') : 'none';
}

function formatSample(timestamp, status, debug) {
    const stState = status?.state || 'unknown';
    const stConn = status?.connected ? 'true' : 'false';
    const stPhone = status?.phone || 'none';

    const dbgLive = debug?.liveState || 'null';
    const dbgReady = debug?.readyFired ? 'true' : 'false';
    const msgL = debug?.listenerCounts?.message ?? '0';
    const ackL = debug?.listenerCounts?.message_ack ?? '0';
    const chrome = debug?.chromeProcessCount ?? '0';
    const timers = formatTimers(debug?.activeTimers);
    const disc = debug?.userDisconnected ? 'true' : 'false';

    return `[${timestamp}] [SAMPLE] Status(state=${stState}, conn=${stConn}, phone=${stPhone}) | Debug(liveState=${dbgLive}, ready=${dbgReady}, msgL=${msgL}, ackL=${ackL}, chrome=${chrome}, timers=[${timers}], disc=${disc})`;
}

function detectTransition(prev, curr) {
    if (!prev) return 'INITIAL_STATE';
    const changes = [];

    const prevSt = prev.status || {};
    const currSt = curr.status || {};
    if (prevSt.state !== currSt.state) {
        changes.push(`status.state: ${prevSt.state} -> ${currSt.state}`);
    }
    if (prevSt.connected !== currSt.connected) {
        changes.push(`status.connected: ${prevSt.connected} -> ${currSt.connected}`);
    }

    const prevDb = prev.debug || {};
    const currDb = curr.debug || {};
    if (prevDb.liveState !== currDb.liveState) {
        changes.push(`liveState: ${prevDb.liveState} -> ${currDb.liveState}`);
    }
    if (prevDb.readyFired !== currDb.readyFired) {
        changes.push(`readyFired: ${prevDb.readyFired} -> ${currDb.readyFired}`);
    }
    if (prevDb.chromeProcessCount !== currDb.chromeProcessCount) {
        changes.push(`chromeCount: ${prevDb.chromeProcessCount} -> ${currDb.chromeProcessCount}`);
    }
    if (prevDb.userDisconnected !== currDb.userDisconnected) {
        changes.push(`userDisconnected: ${prevDb.userDisconnected} -> ${currDb.userDisconnected}`);
    }

    const prevTimers = formatTimers(prevDb.activeTimers);
    const currTimers = formatTimers(currDb.activeTimers);
    if (prevTimers !== currTimers) {
        changes.push(`timers: [${prevTimers}] -> [${currTimers}]`);
    }

    const prevMsgL = prevDb.listenerCounts?.message;
    const currMsgL = currDb.listenerCounts?.message;
    if (prevMsgL !== currMsgL) {
        changes.push(`msgListeners: ${prevMsgL} -> ${currMsgL}`);
    }

    const prevAckL = prevDb.listenerCounts?.message_ack;
    const currAckL = currDb.listenerCounts?.message_ack;
    if (prevAckL !== currAckL) {
        changes.push(`ackListeners: ${prevAckL} -> ${currAckL}`);
    }

    return changes.length > 0 ? changes.join(' | ') : null;
}

class WhatsAppObserver {
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
        this.intervalMs = opts.intervalMs || 2000;
        this.cookie = opts.cookie || '';
        this.onTransition = opts.onTransition || null;
        this.onSample = opts.onSample || null;
        this.timer = null;
        this.history = [];
        this.lastSample = null;
        this.running = false;
    }

    async pollOnce() {
        const ts = new Date().toISOString();
        const headers = {};
        if (this.cookie) {
            headers.Cookie = this.cookie;
        }

        let statusData = null;
        let debugData = null;

        try {
            const stRes = await requestJson(`${this.baseUrl}/api/status`, { headers });
            statusData = stRes.data?.data || stRes.data;
        } catch (e) {
            statusData = { error: e.message };
        }

        try {
            const dbgRes = await requestJson(`${this.baseUrl}/api/whatsapp/debug`, { headers });
            debugData = dbgRes.data?.data || dbgRes.data;
        } catch (e) {
            debugData = { error: e.message };
        }

        const sample = { timestamp: ts, status: statusData, debug: debugData };
        const line = formatSample(ts, statusData, debugData);
        appendLog(line);

        const transition = detectTransition(this.lastSample, sample);
        if (transition) {
            const transLine = `[${ts}] [TRANSITION] ${transition}`;
            console.log(transLine);
            appendLog(transLine);
            if (typeof this.onTransition === 'function') {
                this.onTransition(transition, sample);
            }
        }

        this.lastSample = sample;
        this.history.push(sample);
        if (this.history.length > 500) this.history.shift();

        if (typeof this.onSample === 'function') {
            this.onSample(sample);
        }

        return sample;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.pollOnce().catch(() => {});
        this.timer = setInterval(() => {
            this.pollOnce().catch(err => {
                const ts = new Date().toISOString();
                appendLog(`[${ts}] [ERROR] Poll error: ${err.message}`);
            });
        }, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
        console.log(`[wa-observe] Observer started polling every ${this.intervalMs}ms on ${this.baseUrl}`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.running = false;
        console.log(`[wa-observe] Observer stopped. Collected ${this.history.length} samples.`);
    }

    getHistory() {
        return [...this.history];
    }

    getLastSample() {
        return this.lastSample;
    }
}

function createObserver(opts) {
    return new WhatsAppObserver(opts);
}

// CLI entry point
if (require.main === module) {
    const args = process.argv.slice(2);
    let baseUrl = 'http://localhost:3000';
    let intervalMs = 2000;
    let cookie = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) baseUrl = args[++i];
        if (args[i] === '--interval' && args[i + 1]) intervalMs = parseInt(args[++i], 10) || 2000;
        if (args[i] === '--cookie' && args[i + 1]) cookie = args[++i];
    }

    console.log(`Starting WhatsApp Observer on ${baseUrl} every ${intervalMs}ms...`);
    const observer = new WhatsAppObserver({ baseUrl, intervalMs, cookie });
    observer.start();

    process.on('SIGINT', () => {
        observer.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        observer.stop();
        process.exit(0);
    });
}

module.exports = {
    WhatsAppObserver,
    createObserver,
    detectTransition,
    formatSample
};
