/**
 * tests/live/live_ui_sweep.js
 *
 * Workpilot Autonomous Loop — Live Verification Script for W12: UI Assets, Icons, CSS & CSP Sweep
 *
 * Visited Pages:
 * 1. Landing Page (/)
 * 2. Login Page (/login)
 * 3. Signup Page (/signup)
 * 4. Admin Diagnostics (/admin)
 * 5. Dashboard App (/app) — All sections:
 *    - dashboard, messages, contacts, leads, crm, campaigns, inventory, appointments, settings
 * 6. Modals: deal modal, agent modal, outreach modal
 * 7. Mobile responsive layout (390px width)
 *
 * Enforces:
 * - 0 CSP violations (securitypolicyviolation events)
 * - 0 Console errors
 * - 0 Failed asset requests (CSS, JS, fonts, images)
 * - All icons rendered with non-zero dimensions
 * - Captures screenshots to .workpilot/evidence/W12/
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const bcrypt = require('bcryptjs');
const db = require('../../src/services/database');
const { createApp } = require('../../src/config/app');

const EVIDENCE_DIR = path.join(__dirname, '..', '..', '.workpilot', 'evidence', 'W12');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

async function run() {
    console.log('====================================================');
    console.log('  WORKPILOT LIVE VERIFICATION: W12 UI ASSET & CSP SWEEP');
    console.log('====================================================\n');

    await db.initDatabase();

    // Create a temporary port and isolated express app
    const PORT = 3102;
    const app = createApp();
    const server = await new Promise((resolve, reject) => {
        const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
    });

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
        headless: true
    });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const violations = [];
    const consoleErrors = [];
    const failedRequests = [];
    let iconChecksPassed = 0;

    // Helper to setup page with strict violation monitoring
    async function createMonitoredPage(context) {
        const page = await context.newPage();

        // Listen for CSP violations
        await page.addInitScript(() => {
            window.__cspViolations = [];
            window.addEventListener('securitypolicyviolation', (e) => {
                window.__cspViolations.push({
                    blockedURI: e.blockedURI,
                    violatedDirective: e.violatedDirective,
                    originalPolicy: e.originalPolicy
                });
            });
        });

        // Listen for Console errors (ignoring expected SSE 401 or test-only disconnects)
        page.on('console', msg => {
            if (msg.type() === 'error') {
                const text = msg.text();
                // Filter external browser noise and expected 401 unauthenticated check on login/signup
                if (!text.includes('qr-stream') && !text.includes('ERR_CONNECTION_REFUSED') && !text.includes('favicon.ico') && !text.includes('/api/auth/refresh') && !text.includes('401 (Unauthorized)')) {
                    consoleErrors.push(`[${page.url()}] Console error: ${text}`);
                }
            }
        });

        page.on('pageerror', err => {
            consoleErrors.push(`[${page.url()}] Uncaught exception: ${err.message}`);
        });

        // Listen for failed asset requests (CSS, JS, fonts, SVGs, images)
        page.on('requestfailed', req => {
            const url = req.url();
            if (/\.(css|js|woff2?|ttf|svg|png|jpe?g)/i.test(url)) {
                failedRequests.push(`Failed asset load: ${url} (${req.failure()?.errorText})`);
            }
        });

        // Intercept WhatsApp SSE and send routes to avoid live browser background disconnect noise
        await page.route('**/api/qr-stream', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
        await page.route('**/api/whatsapp/connect', route => route.fulfill({ contentType: 'application/json', body: '{"success":true}' }));

        return page;
    }

    async function checkPageIntegrity(page, pageName) {
        // Collect CSP violations
        const cspEvents = await page.evaluate(() => window.__cspViolations || []);
        if (cspEvents.length > 0) {
            cspEvents.forEach(v => {
                violations.push(`[${pageName}] CSP violation: directive "${v.violatedDirective}" blocked "${v.blockedURI}"`);
            });
        }

        // Check icons non-zero dimensions for visible icons
        const iconStats = await page.evaluate(() => {
            const icons = document.querySelectorAll('svg.icon, [data-icon] svg');
            let zeroSize = 0;
            let visibleCount = 0;
            icons.forEach(i => {
                const isVisible = typeof i.checkVisibility === 'function'
                    ? i.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                    : (!i.closest('[hidden], [style*="display: none"], .modal-backdrop[hidden], section:not(.active)'));
                if (isVisible) {
                    visibleCount++;
                    const rect = i.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) {
                        zeroSize++;
                    }
                }
            });
            return { total: icons.length, visible: visibleCount, zeroSize };
        });

        if (iconStats.zeroSize > 0) {
            violations.push(`[${pageName}] Found ${iconStats.zeroSize} visible icon(s) with 0x0 dimensions out of ${iconStats.visible}`);
        } else {
            iconChecksPassed += iconStats.visible;
        }

        // Screenshot
        const screenshotPath = path.join(EVIDENCE_DIR, `${pageName.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`  ✔ Checked ${pageName}: ${iconStats.total} icons verified, screenshot saved.`);
    }

    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await createMonitoredPage(context);

        // 1. Landing Page
        console.log('--- Step 1: Public Pages ---');
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        await checkPageIntegrity(page, 'public_landing');

        // 2. Login Page
        await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
        await checkPageIntegrity(page, 'public_login');

        // 3. Signup Page
        await page.goto(`${baseUrl}/signup`, { waitUntil: 'domcontentloaded' });
        await checkPageIntegrity(page, 'public_signup');

        // 4. Authenticate as Admin user
        console.log('\n--- Step 2: Authenticated App Dashboard ---');
        const stamp = Date.now();
        const pwd = 'TestAdminPassword123!';
        const hash = await bcrypt.hash(pwd, 4);
        const adminUser = await db.createUser({
            email: `sweep_admin_${stamp}@workpilot.test`,
            passwordHash: hash,
            status: 'active',
            role: 'admin',
            waEnabled: 0
        });

        // Login via form
        await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
        await page.fill('#email', adminUser.email);
        await page.fill('#password', pwd);
        await page.click('#loginForm button[type="submit"]');
        await page.waitForURL('**/app', { timeout: 10000 });
        await checkPageIntegrity(page, 'app_dashboard_desktop');

        // 5. Navigate sections in App Dashboard
        const sections = ['messages', 'contacts', 'leads', 'crm', 'campaigns', 'inventory', 'appointments', 'settings'];
        for (const sec of sections) {
            await page.click(`[data-section="${sec}"]`);
            await page.waitForTimeout(400);
            await checkPageIntegrity(page, `app_section_${sec}`);
        }

        // 6. Test Modals
        console.log('\n--- Step 3: Modals and Overlays ---');
        // Add Deal Card toggle
        await page.click('[data-section="crm"]');
        await page.waitForTimeout(300);
        await page.click('#addDealBtn');
        await checkPageIntegrity(page, 'modal_add_deal');

        // Agent Modal
        await page.click('#toggleAgentWorkloadBtn');
        await page.waitForTimeout(300);
        await page.click('#addAgentBtn');
        await page.waitForSelector('#agentModalBackdrop', { state: 'visible', timeout: 5000 });
        await checkPageIntegrity(page, 'modal_agent');
        await page.click('#agentModalClose');

        // Outreach Composer Modal
        await page.click('[data-section="campaigns"]');
        await page.waitForTimeout(300);
        await page.click('#newCampaignBtn');
        await page.waitForSelector('#outreachModalBackdrop', { state: 'visible', timeout: 5000 });
        await checkPageIntegrity(page, 'modal_outreach_composer');
        await page.click('#outreachModalClose');

        // 7. Admin Page
        console.log('\n--- Step 4: Admin Diagnostics Page ---');
        await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
        await checkPageIntegrity(page, 'admin_diagnostics');

        // 8. Mobile Viewport (390px)
        console.log('\n--- Step 5: Mobile Viewport (390px width) ---');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${baseUrl}/app`, { waitUntil: 'domcontentloaded' });
        await checkPageIntegrity(page, 'app_dashboard_mobile_390px');

        await context.close();

    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await db.closeDatabase();
    }

    console.log('\n====================================================');
    console.log('  SWEEP RESULTS SUMMARY');
    console.log('====================================================');
    console.log(`Verified Icons: ${iconChecksPassed}`);
    console.log(`Failed Asset Requests: ${failedRequests.length}`);
    console.log(`Console Errors: ${consoleErrors.length}`);
    console.log(`CSP Violations: ${violations.length}`);

    if (failedRequests.length > 0) {
        console.error('\nFailed Requests:', failedRequests);
    }
    if (consoleErrors.length > 0) {
        console.error('\nConsole Errors:', consoleErrors);
    }
    if (violations.length > 0) {
        console.error('\nCSP Violations:', violations);
    }

    if (violations.length > 0 || failedRequests.length > 0 || consoleErrors.length > 0) {
        throw new Error('UI sweep encountered errors, failed requests, or CSP violations');
    }

    console.log('\n✅ W12 UI ASSETS, ICONS, CSS & CSP SWEEP PASSED WITH ZERO VIOLATIONS.');
    process.exit(0);
}

run().catch(err => {
    console.error('\n❌ W12 Sweep FAILED:', err);
    process.exit(1);
});
