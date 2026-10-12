/**
 * tests/puppeteer-skip-download-guard.test.js
 *
 * Verifies that validateEnvironment() in server.js warns loudly (does NOT
 * crash) when NODE_ENV=production and PUPPETEER_SKIP_DOWNLOAD is not 'true'.
 *
 * The guard exists because extract-zip (a Puppeteer transitive dep) has a
 * critical CVE (GHSA-jmr9-qjv8-65gv) for symlink-based arbitrary file write.
 * That code path is only reachable when Puppeteer downloads Chromium at
 * runtime. Setting PUPPETEER_SKIP_DOWNLOAD=true disables the download and
 * closes the vulnerability.
 *
 * No database required — runs in the no-DB suite.
 *
 * Run with:
 *   BCRYPT_ROUNDS=4 npx jest tests/puppeteer-skip-download-guard.test.js --forceExit
 */
'use strict';

describe('validateEnvironment — PUPPETEER_SKIP_DOWNLOAD guard', () => {
    let savedEnv;
    let warnOutput;
    let exitCalled;

    beforeEach(() => {
        savedEnv = { ...process.env };
        warnOutput = [];
        exitCalled = false;

        jest.spyOn(console, 'warn').mockImplementation((...args) => {
            warnOutput.push(args.join(' '));
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        // Capture process.exit without actually exiting
        jest.spyOn(process, 'exit').mockImplementation(() => { exitCalled = true; });
    });

    afterEach(() => {
        // Restore env exactly
        const currentKeys = Object.keys(process.env);
        currentKeys.forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
        Object.assign(process.env, savedEnv);

        jest.restoreAllMocks();

        // Clear server.js from module cache so each test re-reads env
        Object.keys(require.cache).forEach(k => {
            if (k.includes('server.js') || k.includes('src/config/paths')) {
                delete require.cache[k];
            }
        });
    });

    function buildProdEnv(overrides = {}) {
        // Minimum valid production env that passes all OTHER checks in
        // validateEnvironment so we can isolate the PUPPETEER_SKIP_DOWNLOAD check.
        return {
            NODE_ENV: 'production',
            PORT: '3000',
            // Satisfy SESSION_SECRET check
            SESSION_SECRET: 'a'.repeat(64),
            // Required for production: enable HTTPS redirect
            FORCE_HTTPS: 'true',
            // Must NOT set DISABLE_RATE_LIMITS=true in production (that's a problem, not warning)
            DISABLE_RATE_LIMITS: undefined,
            ...overrides
        };
    }

    function applyEnv(envMap) {
        Object.entries(envMap).forEach(([k, v]) => {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        });
    }

    function runValidate() {
        Object.keys(require.cache).forEach(k => {
            if (k.includes('server.js') || k.includes('src/config/paths')) delete require.cache[k];
        });
        const { validateEnvironment } = require('../server.js');
        validateEnvironment();
    }

    // ─── Production + PUPPETEER_SKIP_DOWNLOAD unset → warning ──────────────
    test('warns in production when PUPPETEER_SKIP_DOWNLOAD is not set', () => {
        applyEnv(buildProdEnv({ PUPPETEER_SKIP_DOWNLOAD: undefined }));
        runValidate();

        const allWarnings = warnOutput.join('\n');
        expect(allWarnings).toMatch(/PUPPETEER_SKIP_DOWNLOAD/);
        // Must NOT crash — warning only
        expect(exitCalled).toBe(false);
    });

    test('warns in production when PUPPETEER_SKIP_DOWNLOAD="false"', () => {
        applyEnv(buildProdEnv({ PUPPETEER_SKIP_DOWNLOAD: 'false' }));
        runValidate();

        const allWarnings = warnOutput.join('\n');
        expect(allWarnings).toMatch(/PUPPETEER_SKIP_DOWNLOAD/);
        expect(exitCalled).toBe(false);
    });

    // ─── Production + PUPPETEER_SKIP_DOWNLOAD=true → no warning ───────────
    test('does NOT warn when PUPPETEER_SKIP_DOWNLOAD=true in production', () => {
        applyEnv(buildProdEnv({ PUPPETEER_SKIP_DOWNLOAD: 'true' }));
        runValidate();

        const allWarnings = warnOutput.join('\n');
        expect(allWarnings).not.toMatch(/PUPPETEER_SKIP_DOWNLOAD/);
        expect(exitCalled).toBe(false);
    });

    // ─── Development → no warning regardless ───────────────────────────────
    test('does NOT warn in development even if PUPPETEER_SKIP_DOWNLOAD is unset', () => {
        applyEnv({ NODE_ENV: 'development', PORT: '3000', PUPPETEER_SKIP_DOWNLOAD: undefined });
        runValidate();

        const allWarnings = warnOutput.join('\n');
        expect(allWarnings).not.toMatch(/PUPPETEER_SKIP_DOWNLOAD/);
        expect(exitCalled).toBe(false);
    });
});
