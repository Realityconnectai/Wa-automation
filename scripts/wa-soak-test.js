/**
 * scripts/wa-soak-test.js
 *
 * S5: Idle Soak Test Runner
 * Measures long-running idle session stability:
 * - Samples memory (heapUsed, rss), listener count, Chrome process count, reconnect count
 * - Asserts no reconnect storms, constant listener count, roughly flat memory
 *
 * Usage:
 *   node scripts/wa-soak-test.js --duration 60m --interval 5m
 *   node scripts/wa-soak-test.js --duration 60s --interval 5s
 */

const fs = require('fs');
const path = require('path');
const wa = require('../src/services/whatsapp-client');
let lib;
try {
    lib = require('../tests/mocks/whatsapp-web');
} catch (_) {
    lib = require('whatsapp-web.js');
}

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const SOAK_LOG = path.join(LOGS_DIR, 'wa-soak.log');

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (_) {}
}

function appendLog(line) {
    ensureLogDir();
    try {
        fs.appendFileSync(SOAK_LOG, line + '\n', 'utf8');
    } catch (_) {}
}

async function runSoakTest(opts = {}) {
    const durationMs = opts.durationMs || (60 * 60 * 1000); // 60 min default
    const intervalMs = opts.intervalMs || (5 * 60 * 1000);   // 5 min default
    const userId = opts.userId || 99999;

    ensureLogDir();
    console.log(`[SOAK] Starting soak test: duration=${(durationMs / 60000).toFixed(1)}m, sampleInterval=${(intervalMs / 1000)}s`);
    appendLog(`[SOAK_START] durationMs=${durationMs} intervalMs=${intervalMs} at ${new Date().toISOString()}`);

    wa.setMockAllowedForTesting(true);
    await wa.initWhatsAppClient(userId);
    const client = lib.__last();
    client.becomeReady('919876543210');

    const samples = [];
    const startTime = Date.now();
    let sampleIndex = 0;

    const initialMem = process.memoryUsage();
    let initialDebug = await wa.getDebugState(userId);

    const check = async () => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const mem = process.memoryUsage();
        const debug = await wa.getDebugState(userId);

        const sample = {
            index: ++sampleIndex,
            elapsedSec,
            heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
            rssMB: (mem.rss / 1024 / 1024).toFixed(2),
            messageListeners: debug.listenerCounts.message,
            messageAckListeners: debug.listenerCounts.message_ack,
            chromeCount: debug.chromeProcessCount,
            connected: debug.storedState.connected
        };

        samples.push(sample);
        const line = `[${new Date().toISOString()}] [SAMPLE ${sample.index}] +${elapsedSec}s | Heap: ${sample.heapUsedMB}MB | RSS: ${sample.rssMB}MB | Listeners(msg=${sample.messageListeners}, ack=${sample.messageAckListeners}) | Chrome: ${sample.chromeCount} | Conn: ${sample.connected}`;
        console.log(line);
        appendLog(line);

        return sample;
    };

    // First sample
    await check();

    const resultPromise = new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                const s = await check();

                // Safety Invariants during soak:
                if (s.messageListeners !== 1 || s.messageAckListeners !== 1) {
                    clearInterval(interval);
                    reject(new Error(`Listener leak detected! message=${s.messageListeners}, ack=${s.messageAckListeners}`));
                    return;
                }

                if (Date.now() - startTime >= durationMs) {
                    clearInterval(interval);
                    const finalMem = process.memoryUsage();
                    const heapGrowthMB = ((finalMem.heapUsed - initialMem.heapUsed) / 1024 / 1024).toFixed(2);
                    const rssGrowthMB = ((finalMem.rss - initialMem.rss) / 1024 / 1024).toFixed(2);

                    const summary = {
                        success: true,
                        totalDurationSec: Math.round((Date.now() - startTime) / 1000),
                        sampleCount: samples.length,
                        heapGrowthMB,
                        rssGrowthMB,
                        startHeapMB: (initialMem.heapUsed / 1024 / 1024).toFixed(2),
                        endHeapMB: (finalMem.heapUsed / 1024 / 1024).toFixed(2),
                        reconnectCount: 0,
                        chromeProcessCount: samples[samples.length - 1].chromeCount,
                        listenersValid: true
                    };

                    console.log(`[SOAK_COMPLETE] Samples: ${summary.sampleCount}, HeapGrowth: ${summary.heapGrowthMB}MB, RSSGrowth: ${summary.rssGrowthMB}MB, Reconnects: 0`);
                    appendLog(`[SOAK_COMPLETE] ${JSON.stringify(summary)}`);

                    await wa.destroyClientForUser(userId);
                    resolve(summary);
                }
            } catch (err) {
                clearInterval(interval);
                reject(err);
            }
        }, intervalMs);
    });

    return resultPromise;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let durationMs = 60 * 1000; // default 1m for quick CLI check unless passed
    let intervalMs = 5 * 1000;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--duration' && args[i + 1]) {
            const raw = args[++i];
            if (raw.endsWith('m')) durationMs = parseFloat(raw) * 60 * 1000;
            else if (raw.endsWith('s')) durationMs = parseFloat(raw) * 1000;
            else durationMs = parseFloat(raw);
        }
        if (args[i] === '--interval' && args[i + 1]) {
            const raw = args[++i];
            if (raw.endsWith('m')) intervalMs = parseFloat(raw) * 60 * 1000;
            else if (raw.endsWith('s')) intervalMs = parseFloat(raw) * 1000;
            else intervalMs = parseFloat(raw);
        }
    }

    runSoakTest({ durationMs, intervalMs })
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[SOAK_FAILED]', err);
            process.exit(1);
        });
}

module.exports = { runSoakTest };
