#!/usr/bin/env node
/**
 * scripts/run-tests-with-db.js
 *
 * Sets test environment variables then spawns Jest.
 * Exists so `npm run test:db` works on Windows (PowerShell), macOS, and Linux
 * without needing cross-env.
 *
 * DB target is wa_test on localhost:5432. NEVER whatsapp_automation.
 * The test-db-guard in tests/setup.js enforces this independently.
 * DB name must satisfy ALLOWED_TEST_DB_PATTERN: /^(wa_)?(test|disposable|temp|scratch)/i
 *
 * Usage:  npm run test:db
 * Or:     DATABASE_URL=postgresql://... npm run test:db  (override host/port)
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Only set DATABASE_URL if the caller didn't already provide one.
// This lets CI override the host/port while keeping the safety default.
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/wa_test';
}

// Safety: refuse to run if somehow pointed at production DB name.
const url = process.env.DATABASE_URL;
if (/\/whatsapp_automation(\?|$)/.test(url) || /\/whatsapp_automation$/.test(url.split('@').pop())) {
    console.error('ERROR: DATABASE_URL points at whatsapp_automation (production). Refusing to run tests.');
    console.error('Set DATABASE_URL to point at whatsapp_test instead.');
    process.exit(1);
}

process.env.ALLOW_DESTRUCTIVE_TESTING = 'true';
process.env.BCRYPT_ROUNDS              = '4';
process.env.DISABLE_RATE_LIMITS        = 'true';
process.env.NODE_ENV                   = 'test';

// Strip production-only vars that would break test isolation
delete process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;

const jestBin = path.join(__dirname, '..', 'node_modules', 'jest-cli', 'bin', 'jest.js');
const args = ['--forceExit', '--no-coverage', ...process.argv.slice(2)];

console.log(`\n🧪 Running test suite against: ${url.replace(/:([^:@/]+)@/, ':***@')}\n`);

const result = spawnSync(process.execPath, [jestBin, ...args], {
    stdio: 'inherit',
    env: process.env
});

process.exit(result.status ?? 1);
