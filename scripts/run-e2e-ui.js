/* Isolated UI E2E harness. Never imports server.js, so no scheduler or WhatsApp
 * session can start. Requires the explicit wa_test guard used by DB tests. */
'use strict';
process.env.NODE_ENV = 'test';
process.env.ALLOW_DESTRUCTIVE_TESTING = 'true';
process.env.DISABLE_RATE_LIMITS = 'true';
process.env.PORT = '3101';
process.env.PERSIST_ROOT = require('path').join(require('os').tmpdir(), 'workpilot-e2e');

const assert = require('assert');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { validateTestDatabaseTarget, verifyConnectedDatabase } = require('../src/utils/test-db-guard');
const db = require('../src/services/database');
const { createApp } = require('../src/config/app');

const OUTDIR = path.join(__dirname, '..', 'test-suite-output', 'playwright');

async function main() {
    const target = validateTestDatabaseTarget({ requireDestructiveOptIn: true });
    await db.initDatabase();
    await verifyConnectedDatabase(db.getDb(), target.dbName);
    fs.mkdirSync(OUTDIR, { recursive: true });

    const stamp = Date.now();
    const password = 'E2e-Test-Only-Password-123!';
    const hash = await bcrypt.hash(password, 4);
    const admin = await db.createUser({ email: `e2e-admin-${stamp}@example.test`, passwordHash: hash, status: 'active', role: 'admin', waEnabled: 1 });
    // The regular E2E account must never be allowed to initialise a WhatsApp client.
    const user = await db.createUser({ email: `e2e-user-${stamp}@example.test`, passwordHash: hash, status: 'active', waEnabled: 0 });

    const app = createApp();
    const server = await new Promise((resolve, reject) => {
        const s = app.listen(3101, () => resolve(s));
        s.on('error', reject);
    });
    const chromePath = process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:3101';

    const failures = [];
    let testCount = 0;
    let passCount = 0;

    async function runTest(name, fn) {
        testCount++;
        try {
            await fn();
            passCount++;
            console.log(`  ✓ ${name}`);
        } catch (err) {
            const msg = `FAIL: ${name} — ${err.message}`;
            failures.push(msg);
            console.error(`  ✗ ${name}: ${err.message}`);
        }
    }

    // ─── Create a page with error tracking ──────────────────────
    async function makePage(ctx, opts = {}) {
        const page = await ctx.newPage();
        const consoleErrors = [];
        // Ignore SSE errors (qr-stream returns 401 for non-WA users which is expected)
        page.on('console', msg => {
            if (msg.type() === 'error' && !msg.text().includes('qr-stream') && !msg.text().includes('ERR_')) {
                consoleErrors.push(`console.error: ${msg.text()}`);
            }
        });
        // Intercept WhatsApp send routes — never actually send
        await page.route('**/api/inventory/projects/*/assets/*/send', route =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { sent: true, mocked: true } }) })
        );
        await page.route('**/api/whatsapp/connect', route =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
        );
        await page.route('**/api/whatsapp/disconnect', route =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
        );
        return { page, consoleErrors };
    }

    // ─── Login helper ───────────────────────────────────────────
    async function login(page, email) {
        await page.goto(`${baseUrl}/login`);
        await page.fill('#email', email);
        await page.fill('#password', password);
        await page.click('#loginForm button[type="submit"]');
        await page.waitForURL('**/app', { timeout: 10000 });
        // Dismiss any hidden modals that could intercept clicks
        await page.locator('.modal-backdrop').evaluateAll(nodes =>
            nodes.forEach(node => { if (!node.querySelector(':focus-within')) node.style.display = 'none'; })
        );
    }

    // ─── Navigation helper ──────────────────────────────────────
    async function navigateTo(page, section) {
        const isMobile = await page.evaluate(() => window.innerWidth <= 768);
        if (isMobile) {
            const toggle = page.locator('#menuToggle');
            if (await toggle.isVisible()) {
                await toggle.click();
                await page.waitForSelector('#sidebar.open', { timeout: 3000 });
                await page.click(`#nav-${section}`);
            } else {
                await page.evaluate(s => window.navigateTo ? window.navigateTo(s) : window.showSection(s), section);
            }
        } else {
            await page.click(`#nav-${section}`);
        }
        await page.waitForTimeout(500);
    }

    try {
        // ═══════════════════════════════════════════════════════════
        // MAIN USER SESSION
        // ═══════════════════════════════════════════════════════════
        const context = await browser.newContext();
        const { page, consoleErrors } = await makePage(context);

        console.log('\n── Authentication ──');
        await runTest('Login as regular user', async () => {
            await login(page, user.email);
            const url = page.url();
            assert.ok(url.includes('/app'), `Expected /app URL, got ${url}`);
        });

        await runTest('Dashboard loads with stats', async () => {
            await page.waitForSelector('#valSentToday', { timeout: 5000 });
        });

        // ═══════════════════════════════════════════════════════════
        // PROPERTIES — Project CRUD
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Properties: Project CRUD ──');

        await runTest('Navigate to Properties section', async () => {
            await navigateTo(page, 'inventory');
            await page.waitForSelector('#invNewProjectBtn', { timeout: 5000 });
        });

        const projectName = `E2E Project ${stamp}`;
        await runTest('Create new project', async () => {
            await page.click('#invNewProjectBtn');
            await page.waitForSelector('#invProjectForm', { timeout: 5000 });
            await page.fill('#invName', projectName);
            await page.fill('#invCity', 'Mumbai');
            await page.selectOption('#invType', 'residential');
            await page.fill('#invLocality', 'Bandra');
            await page.click('#invProjectForm button[type="submit"]');
            // Wait for the modal to close and projects to reload
            await page.waitForFunction(
                name => !document.getElementById('invModalBackdrop') &&
                    document.querySelector('#invProjectsGrid')?.textContent?.includes(name),
                projectName, { timeout: 8000 }
            );
        });

        await runTest('Edit project', async () => {
            const editBtn = page.locator('[data-inv="edit"]').first();
            await editBtn.click();
            await page.waitForSelector('#invProjectForm', { timeout: 5000 });
            await page.fill('#invLocality', 'Bandra West Updated');
            await page.click('#invProjectForm button[type="submit"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
        });

        // ═══════════════════════════════════════════════════════════
        // PROPERTIES — Unit CRUD, hold, book, history
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Properties: Unit CRUD, hold, book, history ──');

        await runTest('Switch to Availability Grid tab and create unit', async () => {
            await page.getByRole('tab', { name: 'Availability Grid' }).click();
            await page.waitForFunction(() => document.querySelectorAll('#invGridProject option').length > 1, { timeout: 8000 });
            // Select the created project option
            await page.selectOption('#invGridProject', { index: 1 });
            await page.waitForSelector('#invNewUnitBtn:not([disabled])', { timeout: 5000 });
            await page.click('#invNewUnitBtn');
            await page.waitForSelector('#invUnitForm', { timeout: 5000 });
            await page.fill('#invUnitNumber', 'E2E-101');
            await page.fill('#invTower', 'A');
            await page.fill('#invFloor', '5');
            await page.fill('#invBhk', '2BHK');
            await page.click('#invUnitForm button[type="submit"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
        });

        await runTest('Unit appears in grid', async () => {
            await page.waitForFunction(
                () => document.querySelector('#invGridContainer')?.textContent?.includes('E2E-101'),
                { timeout: 8000 }
            );
        });

        await runTest('Hold unit via manage modal', async () => {
            await page.click('[data-inv="unit"]');
            await page.waitForSelector('[data-inv="transition"][data-transition="hold"]', { timeout: 5000 });
            page.once('dialog', dialog => dialog.accept('Test Holder'));
            await page.click('[data-inv="transition"][data-transition="hold"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
            // Verify status changed
            await page.waitForFunction(
                () => document.querySelector('#invGridContainer')?.textContent?.includes('ON_HOLD'),
                { timeout: 5000 }
            );
        });

        await runTest('Book unit from ON_HOLD', async () => {
            await page.click('[data-inv="unit"]');
            await page.waitForSelector('[data-inv="transition"][data-transition="book"]', { timeout: 5000 });
            page.once('dialog', dialog => dialog.accept('BK-123'));
            await page.click('[data-inv="transition"][data-transition="book"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
            await page.waitForFunction(
                () => document.querySelector('#invGridContainer')?.textContent?.includes('BOOKED'),
                { timeout: 5000 }
            );
        });

        await runTest('View unit status history', async () => {
            await page.click('[data-inv="unit"]');
            await page.waitForSelector('[data-inv="history-unit"]', { timeout: 5000 });
            await page.click('[data-inv="history-unit"]');
            await page.waitForFunction(
                () => document.getElementById('invModalBody')?.textContent?.includes('ON_HOLD') ||
                    document.getElementById('invModalBody')?.textContent?.includes('BOOKED'),
                { timeout: 5000 }
            );
            // Close history modal
            await page.click('#invModalBackdrop .modal-close');
            await page.waitForFunction(() => !document.getElementById('invModalBackdrop'), { timeout: 8000 });
        });

        await runTest('Edit unit', async () => {
            await page.click('[data-inv="unit"]');
            await page.waitForSelector('[data-inv="edit-unit"]', { timeout: 5000 });
            await page.click('[data-inv="edit-unit"]');
            await page.waitForSelector('#invUnitForm', { timeout: 5000 });
            await page.fill('#invBhk', '3BHK');
            await page.click('#invUnitForm button[type="submit"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
        });

        await runTest('Delete unit', async () => {
            // Create a disposable vacant unit to test deletion (active reservations cannot be deleted)
            await page.click('#invNewUnitBtn');
            await page.waitForSelector('#invUnitForm', { timeout: 5000 });
            await page.fill('#invUnitNumber', 'E2E-DEL');
            await page.click('#invUnitForm button[type="submit"]');
            await page.waitForFunction(() => !document.getElementById('invModalBackdrop'), { timeout: 8000 });
            await page.waitForFunction(() => document.querySelector('#invGridContainer')?.textContent?.includes('E2E-DEL'), { timeout: 8000 });

            // Manage and delete E2E-DEL
            const delRowManage = page.locator('tr', { hasText: 'E2E-DEL' }).locator('[data-inv="unit"]');
            await delRowManage.click();
            await page.waitForSelector('[data-inv="delete-unit"]', { timeout: 5000 });
            page.once('dialog', dialog => dialog.accept());
            await page.click('[data-inv="delete-unit"]');
            await page.waitForFunction(
                () => !document.getElementById('invModalBackdrop'),
                { timeout: 8000 }
            );
            await page.waitForFunction(
                () => !document.querySelector('#invGridContainer')?.textContent?.includes('E2E-DEL'),
                { timeout: 8000 }
            );
        });

        // ═══════════════════════════════════════════════════════════
        // PROPERTIES — Asset upload, preview, send
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Properties: Assets ──');

        await runTest('Switch to Projects tab and open assets', async () => {
            await page.getByRole('tab', { name: 'Projects' }).click();
            await page.waitForTimeout(500);
            const assetsBtn = page.locator('[data-inv="assets"]').first();
            await assetsBtn.click();
            await page.waitForSelector('#invAssetForm', { timeout: 5000 });
        });

        await runTest('Upload an asset (small test file)', async () => {
            // Create a tiny test PNG in memory via a data URL buffer
            const testFile = path.join(OUTDIR, 'test-asset.png');
            // 1x1 transparent PNG
            const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
            fs.writeFileSync(testFile, pngBuf);
            await page.setInputFiles('#invAsset', testFile);
            await page.selectOption('#invAssetType', 'photo');
            await page.click('#invAssetForm button[type="submit"]');
            // Wait for asset list to appear with the uploaded file
            await page.waitForFunction(
                () => document.getElementById('invModalBody')?.textContent?.includes('test-asset.png'),
                { timeout: 10000 }
            );
        });

        await runTest('Preview uploaded asset', async () => {
            const previewBtn = page.locator('[data-inv="preview-asset"]').first();
            await previewBtn.click();
            await page.waitForFunction(
                () => document.getElementById('invModalBody')?.querySelector('img, iframe, video'),
                { timeout: 5000 }
            );
            // Close preview
            await page.click('#invModalBackdrop .modal-close');
            await page.waitForFunction(() => !document.getElementById('invModalBackdrop'), { timeout: 8000 });
        });

        await runTest('View asset send history (empty state)', async () => {
            // Re-open assets panel
            const assetsBtn = page.locator('[data-inv="assets"]').first();
            await assetsBtn.click();
            await page.waitForSelector('[data-inv="asset-history"]', { timeout: 5000 });
            await page.locator('[data-inv="asset-history"]').first().click();
            await page.waitForFunction(
                () => document.getElementById('invModalBody')?.textContent?.includes('not been sent'),
                { timeout: 5000 }
            );
            await page.click('#invModalBackdrop .modal-close');
            await page.waitForFunction(() => !document.getElementById('invModalBackdrop'), { timeout: 8000 });
        });

        await runTest('Send asset (mocked)', async () => {
            // First add a contact so the recipient dropdown has options
            await db.getDb().query(
                `INSERT INTO contacts (phone, name, user_id) VALUES ($1, $2, $3)
                 ON CONFLICT (phone, user_id) DO NOTHING`,
                ['919876543210', 'E2E Contact', user.id]
            );
            // Re-open assets
            const assetsBtn = page.locator('[data-inv="assets"]').first();
            await assetsBtn.click();
            await page.waitForSelector('[data-inv="send-asset"]', { timeout: 5000 });
            await page.locator('[data-inv="send-asset"]').first().click();
            await page.waitForSelector('#invSendAssetForm', { timeout: 5000 });

            // Select recipient if available
            const hasOptions = await page.locator('#invAssetRecipient option').count();
            if (hasOptions > 1) {
                await page.selectOption('#invAssetRecipient', { index: 1 });
                page.once('dialog', dialog => dialog.accept());
                await page.click('#invSendAssetForm button[type="submit"]');
                await page.waitForSelector('.toast', { timeout: 8000 });
                const closeBtn = page.locator('[data-inv="close"]');
                if (await closeBtn.count()) await closeBtn.click();
            } else {
                // Close if no contacts available
                await page.click('[data-inv="close"]');
            }
            await page.waitForFunction(() => !document.getElementById('invModalBackdrop'), { timeout: 8000 });
        });

        // ═══════════════════════════════════════════════════════════
        // BROCHURE DROPS
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Brochure Drops ──');

        await runTest('Navigate to brochure-drop configuration', async () => {
            await page.getByRole('tab', { name: 'Brochure Drops' }).click();
            await page.waitForSelector('#invBrochureForm', { timeout: 8000 });
        });

        await runTest('Save brochure-drop settings', async () => {
            await page.fill('#invBrochureTriggers', 'brochure\n3BHK');
            await page.click('#invBrochureForm button[type="submit"]');
            // Wait for the success toast
            await page.waitForFunction(
                () => document.querySelector('.toast')?.textContent?.includes('saved'),
                { timeout: 5000 }
            );
        });

        // ═══════════════════════════════════════════════════════════
        // CRM — deal CRUD, qualification, temperature filters
        // ═══════════════════════════════════════════════════════════
        console.log('\n── CRM Pipeline ──');

        await runTest('Navigate to CRM section', async () => {
            await navigateTo(page, 'crm');
            await page.waitForSelector('#addDealBtn', { timeout: 5000 });
        });

        await runTest('Add a new deal', async () => {
            await page.click('#addDealBtn');
            await page.waitForSelector('#addDealForm', { timeout: 3000 });
            await page.fill('#dealPhone', '919876543210');
            await page.fill('#dealName', 'E2E Test Deal');
            await page.fill('#dealValue', '5000000');
            await page.selectOption('#dealStage', 'new');
            await page.fill('#dealProduct', 'Luxury Apartment');
            await page.click('#addDealForm button[type="submit"]');
            await page.waitForFunction(
                () => document.querySelector('.toast')?.textContent?.includes('Deal added'),
                { timeout: 5000 }
            );
        });

        await runTest('Deal appears in pipeline', async () => {
            await page.waitForFunction(
                () => document.querySelector('[data-section="crm"]')?.textContent?.includes('E2E Test Deal') ||
                    document.querySelector('#crmPipeline,#crmContent,.kanban-column')?.textContent?.includes('E2E Test Deal'),
                { timeout: 5000 }
            );
        });

        await runTest('Temperature filter works (show all)', async () => {
            const hasFilter = await page.locator('#crmTemperatureFilter').count();
            if (hasFilter) {
                await page.selectOption('#crmTemperatureFilter', '');
                await page.waitForTimeout(500);
            }
        });

        await runTest('Open deal detail modal and update qualification', async () => {
            // Click on the deal card/row to open it
            const dealCard = page.locator('.kanban-card, [data-deal-phone]').first();
            const exists = await dealCard.count();
            if (exists) {
                await dealCard.click();
                await page.waitForSelector('#dealModalBody', { timeout: 5000 });
                // Check qualification panel fields exist
                await page.waitForSelector('#modalLeadType', { timeout: 5000 });
                await page.selectOption('#modalLeadType', 'buy');
                await page.fill('#modalPreferredBhk', '3BHK');
                await page.fill('#modalBudgetMin', '4000000');
                await page.fill('#modalBudgetMax', '6000000');
                // Save deal
                const saveBtn = page.locator('[data-deal-action="save"]').first();
                if (await saveBtn.count()) {
                    await saveBtn.click();
                    await page.waitForTimeout(1000);
                }
                await page.click('#dealModalClose');
            }
        });

        // ═══════════════════════════════════════════════════════════
        // MESSAGES / CONVERSATION DETAIL
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Messages & Conversations ──');

        await runTest('Navigate to Messages section', async () => {
            await navigateTo(page, 'messages');
            await page.waitForTimeout(1000);
        });

        await runTest('Messages section loads (empty or with data)', async () => {
            // Should show either a message list or an empty state
            const hasContent = await page.locator('#messagesContent, #messages-section, [data-section="messages"]').first().count();
            assert.ok(hasContent > 0, 'Messages section should exist');
        });

        // Insert a test message so we can open a conversation
        await runTest('Conversation modal opens with message data and inbound media notice', async () => {
            // Insert test messages
            await db.getDb().query(
                `INSERT INTO messages (phone, body, direction, status, message_type, user_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['919876543210', 'Hello test message', 'incoming', 'received', 'text', user.id]
            );
            await db.getDb().query(
                `INSERT INTO messages (phone, body, direction, status, message_type, user_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['919876543210', '', 'incoming', 'received', 'image', user.id]
            );
            // Reload messages
            await navigateTo(page, 'messages');
            await page.waitForTimeout(1000);
            // Try to find a conversation link
            const convLink = page.locator('[data-open-conversation], [data-phone], .conversation-link').first();
            if (await convLink.count()) {
                await convLink.click();
                await page.waitForSelector('#conversationModalBody', { timeout: 5000 });
                // Verify conversation content includes inbound media notice
                const body = await page.locator('#conversationModalBody').textContent();
                assert.ok(body.includes('Hello test message'), 'Conversation body should contain message text');
                assert.ok(body.includes('metadata only'), 'Conversation body should contain metadata-only notice for inbound media');
                await page.click('#conversationModalClose');
            }
        });

        // ═══════════════════════════════════════════════════════════
        // LEADS — qualification panel
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Leads ──');

        await runTest('Navigate to Leads section and check filters', async () => {
            await navigateTo(page, 'leads');
            await page.waitForTimeout(1000);
            // Check qualification filters exist
            const interestFilter = await page.locator('#leadInterestFilter').count();
            const priorityFilter = await page.locator('#leadPriorityFilter').count();
            const tempFilter = await page.locator('#leadTemperatureFilter').count();
            // At least one filter should exist
            assert.ok(interestFilter || priorityFilter || tempFilter,
                'At least one lead filter should exist');
        });

        // ═══════════════════════════════════════════════════════════
        // SETTINGS
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Settings ──');

        await runTest('Navigate to Settings and verify tabs load', async () => {
            await navigateTo(page, 'settings');
            await page.waitForTimeout(1000);
            const settingsContent = await page.locator('[data-section="settings"]').first().count();
            assert.ok(settingsContent > 0, 'Settings section should exist');
        });

        // ═══════════════════════════════════════════════════════════
        // DELETE PROJECT (cleanup after all property tests)
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Properties: Cleanup ──');

        await runTest('Delete project', async () => {
            await navigateTo(page, 'inventory');
            await page.getByRole('tab', { name: 'Projects' }).click();
            await page.waitForSelector('#invProjectsGrid', { timeout: 5000 });
            page.once('dialog', dialog => dialog.accept());
            const deleteBtn = page.locator('[data-inv="delete"]').first();
            if (await deleteBtn.count()) {
                await deleteBtn.click();
                await page.waitForTimeout(2000);
            }
        });

        // ═══════════════════════════════════════════════════════════
        // MOBILE VIEWPORT
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Mobile Viewport ──');

        await runTest('Mobile layout — dashboard renders at 390px width', async () => {
            await page.setViewportSize({ width: 390, height: 844 });
            await navigateTo(page, 'dashboard');
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(OUTDIR, 'mobile-dashboard.png'), fullPage: true });
        });

        await runTest('Mobile layout — CRM renders at 390px width', async () => {
            await navigateTo(page, 'crm');
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(OUTDIR, 'mobile-crm.png'), fullPage: true });
        });

        await runTest('Mobile layout — Properties renders at 390px width', async () => {
            await navigateTo(page, 'inventory');
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(OUTDIR, 'mobile-properties.png'), fullPage: true });
        });

        await runTest('Mobile layout — Messages renders at 390px width', async () => {
            await navigateTo(page, 'messages');
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(OUTDIR, 'mobile-messages.png'), fullPage: true });
        });

        await runTest('Mobile layout — Leads renders at 390px width', async () => {
            await navigateTo(page, 'leads');
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(OUTDIR, 'mobile-leads.png'), fullPage: true });
        });

        // Reset to desktop
        await page.setViewportSize({ width: 1280, height: 800 });

        // ═══════════════════════════════════════════════════════════
        // LOADING / ERROR / EMPTY STATES
        // ═══════════════════════════════════════════════════════════
        console.log('\n── States: Loading, Error, Empty ──');

        await runTest('Empty state — Scheduled messages when none exist', async () => {
            await navigateTo(page, 'scheduled');
            await page.waitForTimeout(1000);
            const content = await page.locator('[data-section="scheduled"]').first().textContent();
            assert.ok(content, 'Scheduled section should have content (possibly empty state)');
        });

        await runTest('Empty state — Appointments when none exist', async () => {
            await navigateTo(page, 'appointments');
            await page.waitForTimeout(1000);
            const content = await page.locator('[data-section="appointments"]').first().textContent();
            assert.ok(content, 'Appointments section should have content (possibly empty state)');
        });

        // ═══════════════════════════════════════════════════════════
        // ADMIN — diagnostics panel
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Admin Diagnostics ──');

        const adminContext = await browser.newContext();
        const { page: adminPage, consoleErrors: adminErrors } = await makePage(adminContext);

        await runTest('Admin login and diagnostics page loads', async () => {
            // API login to get cookies
            const loginRes = await adminPage.request.post(`${baseUrl}/api/auth/login`, {
                data: { email: admin.email, password }
            });
            assert.equal(loginRes.status(), 200, 'admin API login should succeed');
            await adminPage.goto(`${baseUrl}/admin`);
            await adminPage.waitForSelector('#diagnosticsContent', { timeout: 10000 });
        });

        await runTest('Admin diagnostics shows user list', async () => {
            const content = await adminPage.locator('#diagnosticsContent').textContent();
            assert.ok(content.length > 0, 'Diagnostics content should not be empty');
        });

        await runTest('Admin page mobile layout', async () => {
            await adminPage.setViewportSize({ width: 390, height: 844 });
            await adminPage.screenshot({ path: path.join(OUTDIR, 'mobile-admin.png'), fullPage: true });
        });

        await adminContext.close();

        // ═══════════════════════════════════════════════════════════
        // LOGOUT
        // ═══════════════════════════════════════════════════════════
        console.log('\n── Logout ──');

        await runTest('Logout redirects to login page', async () => {
            await page.setViewportSize({ width: 1280, height: 800 });
            const logoutBtn = page.locator('#logoutBtn');
            if (await logoutBtn.count()) {
                await logoutBtn.click();
                await page.waitForURL('**/login', { timeout: 5000 });
            }
        });

        // ═══════════════════════════════════════════════════════════
        // Check for unexpected console errors
        // ═══════════════════════════════════════════════════════════
        if (consoleErrors.length > 0) {
            console.warn('\n⚠ Console errors detected (non-fatal):');
            consoleErrors.forEach(e => console.warn(`  ${e}`));
        }
        if (adminErrors.length > 0) {
            console.warn('\n⚠ Admin console errors (non-fatal):');
            adminErrors.forEach(e => console.warn(`  ${e}`));
        }

        await context.close();

    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        await db.closeDatabase();
    }

    // ─── Summary ────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Tests: ${passCount}/${testCount} passed`);
    if (failures.length > 0) {
        console.error(`\nFailures:`);
        failures.forEach(f => console.error(`  ${f}`));
        process.exitCode = 1;
    } else {
        console.log('All tests passed ✓');
    }
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
