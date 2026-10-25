/**
 * src/config/cors.js — Centralized CORS and Origin Validation Configuration
 */
'use strict';

const DEFAULT_ALLOWED_ORIGINS = [
    'https://workpilots.dpdns.org',
    'https://workpilot.co.in',
    'https://leadfinder.workpilot.co.in',
    'https://linkdinpilot.workpilot.co.in',
    'https://enunciate-graves-dry.ngrok-free.dev',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000'
];

function getAllowedOrigins() {
    const fromAllowed = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim().replace(/\/+$/, ''))
        .filter(s => s && s !== '*');
    const fromFrontend = (process.env.FRONTEND_ORIGIN || '').trim().replace(/\/+$/, '');
    const envOrigins = [...fromAllowed];
    if (fromFrontend && fromFrontend !== '*') {
        envOrigins.push(fromFrontend);
    }
    return Array.from(new Set([
        ...DEFAULT_ALLOWED_ORIGINS.map(s => s.replace(/\/+$/, '')),
        ...envOrigins
    ]));
}

function isOriginAllowed(origin) {
    if (!origin) return true; // Same-origin, direct server-to-server, or native calls
    const trimmed = String(origin).trim().toLowerCase().replace(/\/+$/, '');
    if (!trimmed) return true;

    const allowedOriginsList = getAllowedOrigins();
    if (allowedOriginsList.some(o => o.toLowerCase() === trimmed)) return true;

    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        if (host === 'workpilot.co.in' || host.endsWith('.workpilot.co.in')) return true;
        if (host === 'workpilots.dpdns.org') return true;
        if (host === 'enunciate-graves-dry.ngrok-free.dev') return true;
        if (host === 'localhost' || host === '127.0.0.1') return true;
    } catch (e) {
        return false;
    }
    return false;
}

const corsOptions = {
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Cache-Control',
        'Pragma',
        'ngrok-skip-browser-warning',
        'bypass-tunnel-reminder'
    ],
    maxAge: 86400,
    optionsSuccessStatus: 204
};

module.exports = {
    DEFAULT_ALLOWED_ORIGINS,
    getAllowedOrigins,
    isOriginAllowed,
    corsOptions
};
