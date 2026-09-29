/**
 * src/utils/test-db-guard.js — Fail-closed protection for destructive database operations.
 *
 * Enforces:
 *   1. Explicit database resolution from connection URL or environment variables.
 *   2. Strict allow-list matching on the parsed database name (not host/user substrings).
 *   3. Rejection of protected/production database names under all circumstances.
 *   4. Mandatory explicit destructive opt-in (ALLOW_DESTRUCTIVE_TESTING=true).
 *      NODE_ENV=test alone is NEVER permitted to authorize destruction.
 *   5. Real-time verification of connected database identity (SELECT current_database())
 *      before any destructive query (DELETE, TRUNCATE, DROP) is executed.
 *   6. Credential hygiene: Connection strings and passwords are never printed in logs or errors.
 */

const PROTECTED_DB_NAMES = new Set([
    'postgres',
    'whatsapp_automation',
    'production',
    'prod',
    'master',
    'main',
    'default',
    'template1',
    'template0'
]);

const ALLOWED_TEST_DB_PATTERN = /^(wa_)?(test|disposable|temp|scratch)(_[a-z0-9_]+)?$/i;

/**
 * Sanitizes a PostgreSQL connection string for safe display in logs and errors.
 * Never prints password or full user credentials.
 */
function sanitizeDatabaseUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '[empty-url]';
    try {
        const parsed = new URL(rawUrl);
        const user = parsed.username ? `${parsed.username}:***@` : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        return `${parsed.protocol}//${user}${parsed.hostname}${port}${parsed.pathname}`;
    } catch (_) {
        return '[malformed-url]';
    }
}

/**
 * Resolves and validates the target database configuration for destructive testing.
 * Fails closed if configuration is missing, malformed, or targets a non-disposable database.
 *
 * @param {Object} options
 * @param {string} [options.connectionString] - Database URL
 * @param {Object} [options.env] - Environment variables object (default: process.env)
 * @param {boolean} [options.requireDestructiveOptIn=true] - Require ALLOW_DESTRUCTIVE_TESTING=true
 * @returns {{ ok: boolean, dbName: string, sanitizedTarget: string }}
 */
function validateTestDatabaseTarget(options = {}) {
    const env = options.env || process.env;
    const rawUrl = (options.connectionString !== undefined ? options.connectionString : env.DATABASE_URL || '').trim();
    const requireOptIn = options.requireDestructiveOptIn !== false;

    let dbName = '';
    let sanitizedTarget = '';

    if (rawUrl) {
        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch (e) {
            throw new Error(`CRITICAL SAFETY ABORT: Database URL is malformed (${sanitizeDatabaseUrl(rawUrl)}).`);
        }

        if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
            throw new Error(`CRITICAL SAFETY ABORT: Unsupported database protocol "${parsed.protocol}". Expected postgresql:.`);
        }

        // Database name is the pathname without leading slash
        dbName = (parsed.pathname || '').replace(/^\//, '').split('?')[0].trim();
        sanitizedTarget = sanitizeDatabaseUrl(rawUrl);
    } else {
        // Fallback to discrete environment variables
        dbName = (env.PGDATABASE || env.DB_NAME || '').trim();
        const host = env.PGHOST || env.DB_HOST || 'localhost';
        const port = env.PGPORT || env.DB_PORT || '5432';
        sanitizedTarget = `postgresql://[discrete-env]@${host}:${port}/${dbName || '[none]'}`;
    }

    if (!dbName) {
        throw new Error(`CRITICAL SAFETY ABORT: No target database name specified (${sanitizedTarget}).`);
    }

    const lowerDbName = dbName.toLowerCase();

    // 1. Check against protected/production database names
    if (PROTECTED_DB_NAMES.has(lowerDbName)) {
        throw new Error(
            `CRITICAL SAFETY ABORT: Target database "${dbName}" is a protected production database. ` +
            `Destructive test operations are strictly forbidden against "${dbName}".`
        );
    }

    // 2. Enforce strict naming pattern for disposable test databases
    if (!ALLOWED_TEST_DB_PATTERN.test(lowerDbName)) {
        throw new Error(
            `CRITICAL SAFETY ABORT: Database "${dbName}" does not match permitted disposable test database pattern. ` +
            `Permitted names must match /^(wa_)?(test|disposable|temp|scratch)/i. Target: ${sanitizedTarget}`
        );
    }

    // 3. Enforce explicit destructive-test opt-in
    // NODE_ENV=test alone is NOT allowed to authorize database purging!
    if (requireOptIn) {
        const isOptedIn = env.ALLOW_DESTRUCTIVE_TESTING === 'true';
        if (!isOptedIn) {
            throw new Error(
                `CRITICAL SAFETY ABORT: Destructive test operations require explicit opt-in via ALLOW_DESTRUCTIVE_TESTING=true. ` +
                `NODE_ENV=test alone does not authorize database destruction. Target: ${sanitizedTarget}`
            );
        }
    }

    return {
        ok: true,
        dbName,
        sanitizedTarget
    };
}

/**
 * Queries the active PostgreSQL client/pool to verify the connected database identity
 * matches the expected disposable test database before any destructive cleanup.
 *
 * @param {Object} clientOrPool - pg Pool or Client instance
 * @param {string} expectedDbName - The validated test database name
 */
async function verifyConnectedDatabase(clientOrPool, expectedDbName) {
    if (!clientOrPool || typeof clientOrPool.query !== 'function') {
        throw new Error('CRITICAL SAFETY ABORT: Cannot verify connected database identity (invalid client/pool).');
    }

    const res = await clientOrPool.query('SELECT current_database() AS current_db, current_user AS current_user');
    const row = res && res.rows && res.rows[0];
    if (!row || !row.current_db) {
        throw new Error('CRITICAL SAFETY ABORT: Failed to retrieve current_database() from connected PostgreSQL session.');
    }

    const connectedDb = String(row.current_db).trim();
    const lowerConnectedDb = connectedDb.toLowerCase();

    if (PROTECTED_DB_NAMES.has(lowerConnectedDb)) {
        throw new Error(
            `CRITICAL SAFETY ABORT: Connected session is attached to protected database "${connectedDb}". ` +
            `Immediate abort before destructive execution.`
        );
    }

    if (!ALLOWED_TEST_DB_PATTERN.test(lowerConnectedDb)) {
        throw new Error(
            `CRITICAL SAFETY ABORT: Connected database "${connectedDb}" is not an allowed disposable test database.`
        );
    }

    if (expectedDbName && connectedDb.toLowerCase() !== expectedDbName.toLowerCase()) {
        throw new Error(
            `CRITICAL SAFETY ABORT: Connected database "${connectedDb}" does not match expected target "${expectedDbName}".`
        );
    }

    return {
        connectedDb,
        connectedUser: row.current_user
    };
}

module.exports = {
    PROTECTED_DB_NAMES,
    ALLOWED_TEST_DB_PATTERN,
    sanitizeDatabaseUrl,
    validateTestDatabaseTarget,
    verifyConnectedDatabase
};
