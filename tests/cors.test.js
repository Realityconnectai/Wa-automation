/**
 * tests/cors.test.js — CORS & Origin Validation Test Suite
 */
'use strict';

const request = require('supertest');
const { createApp } = require('../src/config/app');
const { isOriginAllowed, getAllowedOrigins } = require('../src/config/cors');

describe('CORS and Origin Security Suite', () => {
    let app;

    beforeAll(() => {
        app = createApp();
    });

    describe('1. Origin Validation Unit Logic', () => {
        test('allows default production and localhost origins', () => {
            expect(isOriginAllowed('https://workpilot.co.in')).toBe(true);
            expect(isOriginAllowed('https://app.workpilot.co.in')).toBe(true);
            expect(isOriginAllowed('https://workpilots.dpdns.org')).toBe(true);
            expect(isOriginAllowed('http://localhost:3000')).toBe(true);
            expect(isOriginAllowed('http://127.0.0.1:3000')).toBe(true);
        });

        test('allows specified ngrok tunnel origin', () => {
            expect(isOriginAllowed('https://enunciate-graves-dry.ngrok-free.dev')).toBe(true);
            expect(isOriginAllowed('https://enunciate-graves-dry.ngrok-free.dev/')).toBe(true);
        });

        test('allows same-origin / server-to-server requests without Origin header', () => {
            expect(isOriginAllowed(null)).toBe(true);
            expect(isOriginAllowed(undefined)).toBe(true);
            expect(isOriginAllowed('')).toBe(true);
        });

        test('blocks untrusted third-party and malicious origins', () => {
            expect(isOriginAllowed('https://evil-attacker.com')).toBe(false);
            expect(isOriginAllowed('https://phishing-workpilot.com')).toBe(false);
            expect(isOriginAllowed('https://evilworkpilot.co.in')).toBe(false);
            expect(isOriginAllowed('https://workpilot.co.in.attacker.com')).toBe(false);
            expect(isOriginAllowed('https://attacker-enunciate-graves-dry.ngrok-free.dev')).toBe(false);
            expect(isOriginAllowed('https://unauthorized-tunnel.ngrok-free.dev')).toBe(false);
            expect(isOriginAllowed('javascript:alert(1)')).toBe(false);
        });

        test('dynamically respects custom origin set in process.env.ALLOWED_ORIGINS', () => {
            const original = process.env.ALLOWED_ORIGINS;
            try {
                process.env.ALLOWED_ORIGINS = 'https://custom-partner.com, https://portal.company.org/';
                expect(isOriginAllowed('https://custom-partner.com')).toBe(true);
                expect(isOriginAllowed('https://portal.company.org')).toBe(true);
                expect(isOriginAllowed('https://unlisted-site.com')).toBe(false);
            } finally {
                process.env.ALLOWED_ORIGINS = original;
            }
        });
    });

    describe('2. HTTP Preflight (OPTIONS) Requests', () => {
        test('succeeds with 204 and correct CORS headers for allowed ngrok origin', async () => {
            const res = await request(app)
                .options('/api/auth/login')
                .set('Origin', 'https://enunciate-graves-dry.ngrok-free.dev')
                .set('Access-Control-Request-Method', 'POST')
                .set('Access-Control-Request-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');

            expect(res.status).toBe(204);
            expect(res.headers['access-control-allow-origin']).toBe('https://enunciate-graves-dry.ngrok-free.dev');
            expect(res.headers['access-control-allow-credentials']).toBe('true');
            expect(res.headers['access-control-allow-methods']).toContain('POST');
            expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
            expect(res.headers['access-control-allow-headers']).toContain('Authorization');
            expect(res.headers['access-control-allow-headers']).toContain('ngrok-skip-browser-warning');
        });

        test('does not grant CORS headers to unapproved preflight request', async () => {
            const res = await request(app)
                .options('/api/auth/login')
                .set('Origin', 'https://malicious-attacker.com')
                .set('Access-Control-Request-Method', 'POST');

            expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });

    describe('3. Actual API Requests and Error Responses', () => {
        test('includes CORS headers on successful/valid request from ngrok origin', async () => {
            const res = await request(app)
                .get('/health')
                .set('Origin', 'https://enunciate-graves-dry.ngrok-free.dev');

            expect(res.status).toBe(200);
            expect(res.headers['access-control-allow-origin']).toBe('https://enunciate-graves-dry.ngrok-free.dev');
            expect(res.headers['access-control-allow-credentials']).toBe('true');
        });

        test('includes CORS headers on client error (400/401) responses for allowed origin', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .set('Origin', 'https://enunciate-graves-dry.ngrok-free.dev')
                .send({ email: 'bad@example.com', password: 'wrong' });

            expect(res.status).toBe(401);
            expect(res.headers['access-control-allow-origin']).toBe('https://enunciate-graves-dry.ngrok-free.dev');
            expect(res.headers['access-control-allow-credentials']).toBe('true');
            expect(res.headers['access-control-allow-origin']).not.toBe('*');
        });

        test('strictly blocks actual API requests from unapproved origin with 403', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .set('Origin', 'https://evil-hacker.com')
                .send({ email: 'test@example.com', password: 'password123' });

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('Cross-origin request blocked');
            expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });
});
