'use strict';
const { spawnSync } = require('child_process');
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/wa_test';
if (!/\/wa_test(?:\?|$)/.test(process.env.DATABASE_URL)) throw new Error('E2E requires the wa_test database.');
process.env.NODE_ENV = 'test'; process.env.ALLOW_DESTRUCTIVE_TESTING = 'true'; process.env.BCRYPT_ROUNDS = '4'; process.env.DISABLE_RATE_LIMITS = 'true';
delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.GOOGLE_CALENDAR_CLIENT_ID; delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET; delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;
const result = spawnSync(process.execPath, ['scripts/run-e2e-ui.js'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
