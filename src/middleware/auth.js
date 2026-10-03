const {
    verifySessionToken, getTokenFromRequest, shouldRotateToken,
    createSessionToken, setSessionCookie, clearSessionCookie,
    parseTimestampToMs
} = require('../config/auth');
const database = require('../services/database');

/**
 * Resolves the caller's account from the session cookie.
 *
 * The signed token is only half the check. Role and status are re-read from
 * the database on every request rather than trusted from the token, because
 * a token is issued once and lives for days: an admin demoted to user, or an
 * account suspended or deleted, must lose access immediately, not whenever
 * their cookie happens to expire. This is why a forged-but-validly-signed
 * token claiming role:"admin" gains nothing.
 *
 * Returns { user } | { error } — never throws.
 */
async function resolveSession(req) {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.slice(7);
    }
    if (!token) {
        token = getTokenFromRequest(req);
    }
    if (!token) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Not authenticated' } };

    const payload = verifySessionToken(token, 'any');
    if (!payload) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Your session has expired. Please log in again.' } };

    let user;
    try {
        user = await database.getUserById(payload.id);
    } catch (e) {
        // The database is unavailable. Answering 401 here would silently log
        // everyone out and invite a stampede of re-logins against an already
        // struggling process; 503 tells the client to retry.
        return { error: { status: 503, code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable. Please retry.' } };
    }

    if (!user) return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Account no longer exists' } };

    const tokenAuthVersion = typeof payload.auth_version === 'number'
        ? payload.auth_version
        : (typeof payload.token_version === 'number' ? payload.token_version : null);
    const userAuthVersion = typeof user.auth_version === 'number' ? user.auth_version : 1;

    if (tokenAuthVersion !== null) {
        // Token carries explicit auth_version: must match or exceed user's persisted auth_version
        if (tokenAuthVersion < userAuthVersion) {
            return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Your session has expired. Please log in again.' } };
        }
    } else {
        // Handling of existing legacy tokens without the new claim:
        // Once a user changes password, auth_version is incremented (> 1), which voids all legacy tokens.
        if (userAuthVersion > 1) {
            return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Your session has expired. Please log in again.' } };
        }
        // Fallback check for legacy tokens before migration where user.auth_version is still 1:
        if (user.password_changed_at) {
            const changedMs = parseTimestampToMs(user.password_changed_at);
            const tokenIatMs = typeof payload.iat === 'number' ? (payload.iat < 1e11 ? payload.iat * 1000 : payload.iat) : 0;
            if (tokenIatMs && tokenIatMs <= changedMs) {
                return { error: { status: 401, code: 'AUTH_REQUIRED', message: 'Your password was recently changed. Please log in again.' } };
            }
        }
    }
    if (user.status === 'pending') {
        return {
            error: {
                status: 403,
                code: 'ACCOUNT_PENDING',
                message: 'Your account is pending administrator approval. Please wait for approval before logging in.'
            }
        };
    }
    if (user.status === 'rejected') {
        return {
            error: {
                status: 403,
                code: 'ACCOUNT_REJECTED',
                message: 'Your account registration was declined by the administrator.'
            }
        };
    }
    if (user.status === 'suspended') {
        return {
            error: {
                status: 403,
                code: 'ACCOUNT_SUSPENDED',
                message: 'Your account has been suspended. Contact your administrator.'
            }
        };
    }
    return { user, payload };
}

function sendAuthError(res, error, clearCookie) {
    // Clear a cookie that can never work again, so the browser stops
    // sending it and the user lands on the login page instead of looping.
    if (clearCookie) clearSessionCookie(res);
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
}

/** Attaches req.user if a valid session cookie is present; otherwise 401/403. */
async function requireAuth(req, res, next) {
    try {
        const { user, payload, error } = await resolveSession(req);
        if (error) {
            // Clear on dead token or pending/rejected account, never on 503.
            const dead = error.status === 401 || error.code === 'ACCOUNT_PENDING' || error.code === 'ACCOUNT_REJECTED';
            return sendAuthError(res, error, dead);
        }

        req.user = user;
        req.session = payload;
        next();
    } catch (err) {
        next(err);
    }
}

/** Like requireAuth, but also requires role === 'admin' (read from the database). */
async function requireAdmin(req, res, next) {
    await requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (!req.user || req.user.role !== 'admin') {
            // Deliberately the same shape as any other 403 and with no hint
            // about whether the route exists — an ordinary user probing
            // /api/admin/* learns nothing beyond "not for you".
            return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
        }
        next();
    });
}

/** Best-effort — attaches req.user if a valid session exists, but never blocks. */
async function optionalAuth(req, res, next) {
    try {
        const { user, payload } = await resolveSession(req);
        if (user) {
            req.user = user;
            req.session = payload;
        }
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { requireAuth, requireAdmin, optionalAuth, resolveSession };



