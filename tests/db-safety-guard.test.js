/**
 * tests/db-safety-guard.test.js — Fail-closed test database protection unit tests.
 *
 * Verifies:
 *   1. Rejection of missing/empty database configuration.
 *   2. Rejection of malformed connection URLs.
 *   3. Rejection of misleading URL substrings (username "test" or host "test" with production DB).
 *   4. Rejection of protected/production database names even with NODE_ENV=test.
 *   5. Rejection when ALLOW_DESTRUCTIVE_TESTING is missing or false.
 *   6. Connected database identity verification (SELECT current_database()).
 *   7. Credential sanitization (passwords never leaked in error messages).
 */

const {
    validateTestDatabaseTarget,
    verifyConnectedDatabase,
    sanitizeDatabaseUrl
} = require('../src/utils/test-db-guard');

describe('Database Safety Guard (Fail-Closed Protection)', () => {
    describe('validateTestDatabaseTarget()', () => {
        test('rejects when configuration is completely missing', () => {
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: '',
                    env: { PGDATABASE: '', ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
            }).toThrow(/No target database name specified/);
        });

        test('rejects malformed database URLs', () => {
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'not-a-valid-url',
                    env: { ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
            }).toThrow(/Database URL is malformed/);
        });

        test('rejects non-postgres protocols', () => {
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'http://localhost:5432/wa_test_app',
                    env: { ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
            }).toThrow(/Unsupported database protocol/);
        });

        test('rejects protected database names even with NODE_ENV=test', () => {
            const protectedDbs = ['postgres', 'whatsapp_automation', 'production', 'prod', 'master', 'main'];
            for (const db of protectedDbs) {
                expect(() => {
                    validateTestDatabaseTarget({
                        connectionString: `postgresql://wa_user:secret@127.0.0.1:5432/${db}`,
                        env: { NODE_ENV: 'test', ALLOW_DESTRUCTIVE_TESTING: 'true' }
                    });
                }).toThrow(/protected production database/);
            }
        });

        test('rejects misleading URL substrings (username "test" on production DB)', () => {
            // An attacker or mistaken config where user is "test" or "disposable" but DB is production
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'postgresql://test:testpass@production-host.internal:5432/whatsapp_automation',
                    env: { NODE_ENV: 'test', ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
            }).toThrow(/protected production database/);
        });

        test('rejects misleading URL substrings (hostname contains "test" on production DB)', () => {
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'postgresql://admin:secret@test-db.company.com:5432/customer_production',
                    env: { NODE_ENV: 'test', ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
            }).toThrow(/does not match permitted disposable test database pattern/);
        });

        test('rejects when ALLOW_DESTRUCTIVE_TESTING is missing or false, even with valid test DB and NODE_ENV=test', () => {
            // Missing flag
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'postgresql://wa_test_user:pass@127.0.0.1:5432/wa_test_app',
                    env: { NODE_ENV: 'test' },
                    requireDestructiveOptIn: true
                });
            }).toThrow(/Destructive test operations require explicit opt-in via ALLOW_DESTRUCTIVE_TESTING=true/);

            // Flag is false
            expect(() => {
                validateTestDatabaseTarget({
                    connectionString: 'postgresql://wa_test_user:pass@127.0.0.1:5432/wa_test_app',
                    env: { NODE_ENV: 'test', ALLOW_DESTRUCTIVE_TESTING: 'false' },
                    requireDestructiveOptIn: true
                });
            }).toThrow(/Destructive test operations require explicit opt-in via ALLOW_DESTRUCTIVE_TESTING=true/);
        });

        test('accepts valid disposable test database with explicit opt-in', () => {
            const validDbs = ['wa_test_app', 'wa_test_import', 'test_123', 'disposable_run_42', 'scratch_db'];
            for (const db of validDbs) {
                const res = validateTestDatabaseTarget({
                    connectionString: `postgresql://wa_test_user:pass@127.0.0.1:5432/${db}`,
                    env: { NODE_ENV: 'test', ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
                expect(res.ok).toBe(true);
                expect(res.dbName).toBe(db);
            }
        });

        test('sanitizes credentials and never leaks passwords in error messages', () => {
            const sensitivePass = 'SuperSecretP@ssword!#99';
            try {
                validateTestDatabaseTarget({
                    connectionString: `postgresql://wa_test_user:${encodeURIComponent(sensitivePass)}@127.0.0.1:5432/production_data`,
                    env: { ALLOW_DESTRUCTIVE_TESTING: 'true' }
                });
                throw new Error('Should have thrown');
            } catch (err) {
                expect(err.message).not.toContain(sensitivePass);
                expect(err.message).toContain('***');
            }
        });
    });

    describe('verifyConnectedDatabase()', () => {
        test('passes when connected database matches expected test database', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [{ current_db: 'wa_test_app', current_user: 'wa_test_user' }]
                })
            };

            const res = await verifyConnectedDatabase(mockClient, 'wa_test_app');
            expect(res.connectedDb).toBe('wa_test_app');
            expect(res.connectedUser).toBe('wa_test_user');
        });

        test('aborts if connected database is a protected production database', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [{ current_db: 'whatsapp_automation', current_user: 'postgres' }]
                })
            };

            await expect(verifyConnectedDatabase(mockClient, 'whatsapp_automation'))
                .rejects.toThrow(/Connected session is attached to protected database "whatsapp_automation"/);
        });

        test('aborts if connected database does not match expected target', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [{ current_db: 'wa_test_decoy', current_user: 'wa_test_user' }]
                })
            };

            await expect(verifyConnectedDatabase(mockClient, 'wa_test_app'))
                .rejects.toThrow(/does not match expected target "wa_test_app"/);
        });

        test('aborts if query fails or returns empty rows', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            await expect(verifyConnectedDatabase(mockClient, 'wa_test_app'))
                .rejects.toThrow(/Failed to retrieve current_database\(\)/);
        });
    });

    describe('sanitizeDatabaseUrl()', () => {
        test('masks passwords accurately', () => {
            const sanitized = sanitizeDatabaseUrl('postgresql://myuser:mypassword123@db.internal:5432/wa_test_app?sslmode=require');
            expect(sanitized).toBe('postgresql://myuser:***@db.internal:5432/wa_test_app');
            expect(sanitized).not.toContain('mypassword123');
        });

        test('handles empty or malformed URLs gracefully', () => {
            expect(sanitizeDatabaseUrl('')).toBe('[empty-url]');
            expect(sanitizeDatabaseUrl('not a url')).toBe('[malformed-url]');
        });
    });
});
