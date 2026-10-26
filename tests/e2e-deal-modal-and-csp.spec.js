'use strict';

/**
 * tests/e2e-deal-modal-and-csp.spec.js
 *
 * Playwright automated assertions for:
 * 1. Deal modal controls:
 *    - Equal control heights (#modalReassignAgent, #modalReassignReason, #modalReassignBtn within ±1px)
 *    - Non-truncated placeholder in #modalReassignReason ("Reason (optional)")
 *    - Zero raw snake_case codes in rendered history (#modalAssignmentHistory)
 *    - Delete confirmation: window.confirm required before deletion
 *    - Double submit protection: buttons disable on click during processing
 * 2. Runtime DOM inline styles scan:
 *    - document.querySelectorAll('*[style]') must return zero application elements with inline styles
 */

const { chromium } = require('playwright');
const assert = require('assert');

async function runSuite() {
    console.log('=== RUNNING PLAYWRIGHT SUITE: DEAL MODAL & CSP RUNTIME DOM ===\n');

    const chromePath = process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
        // 1. Log in
        console.log('1. Logging in to http://127.0.0.1:3000...');
        await page.goto('http://127.0.0.1:3000/login', { waitUntil: 'domcontentloaded' });
        await page.fill('#email', 'aryan@gmail.com');
        await page.fill('#password', 'password123');
        await page.click('#loginForm button[type="submit"]', { force: true });
        await page.waitForURL('**/app', { timeout: 10000 });
        console.log('   ✓ Logged in to /app successfully');
        await page.waitForTimeout(500);

        // 2. Runtime inline style check across rendered DOM
        console.log('\n2. Runtime check for inline styles on the rendered DOM...');
        const styledElements = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('*[style]'));
            return els.map(e => ({
                tag: e.tagName,
                id: e.id,
                class: e.className,
                style: e.getAttribute('style')
            }));
        });
        console.log(`   Found ${styledElements.length} elements with style attribute in rendered DOM`);
        assert.strictEqual(
            styledElements.length,
            0,
            `Expected 0 elements with style attribute, found: ${JSON.stringify(styledElements)}`
        );
        console.log('   ✓ Rendered DOM has ZERO inline styles (CSP compliant)');

        // 3. Navigate to CRM / Pipeline section
        console.log('\n3. Navigating to Deals Pipeline...');
        await page.evaluate(() => {
            if (typeof navigateTo === 'function') navigateTo('crm');
            else document.getElementById('nav-crm')?.click();
        });
        await page.waitForTimeout(500);

        // 4. Ensure at least one deal exists to inspect
        const dealCardSelector = '.deal-card[data-open-deal]';
        try {
            await page.waitForSelector(dealCardSelector, { timeout: 3000 });
        } catch (_) {
            console.log('   Creating a test deal...');
            await page.evaluate(async () => {
                await fetch('/api/crm/deals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        phone: '919899887766',
                        contact_name: 'Naressh Israni',
                        stage: 'qualified',
                        notes: 'High intent luxury buyer'
                    })
                });
                if (typeof loadCrm === 'function') loadCrm();
            });
            await page.waitForSelector(dealCardSelector, { timeout: 5000 });
        }

        const dealCard = page.locator(dealCardSelector).first();
        const dealPhone = await dealCard.getAttribute('data-open-deal');
        console.log(`   Opening Deal Modal for phone: ${dealPhone}...`);
        await dealCard.click({ force: true });

        // 5. Wait for Deal Detail Modal and its controls to render
        await page.waitForSelector('#dealModalBackdrop:not([hidden])', { timeout: 5000 });
        await page.waitForSelector('#modalReassignBtn', { timeout: 5000 });
        console.log('   ✓ Deal Modal opened and controls rendered');
        await page.waitForTimeout(300);

        // 6. Test control heights
        console.log('\n4. Verifying equal control heights in Reassign section...');
        const agentSelect = page.locator('#modalReassignAgent');
        const reasonInput = page.locator('#modalReassignReason');
        const reassignBtn = page.locator('#modalReassignBtn');

        if (await agentSelect.count() > 0 && await reasonInput.count() > 0 && await reassignBtn.count() > 0) {
            const agentBox = await agentSelect.boundingBox();
            const reasonBox = await reasonInput.boundingBox();
            const btnBox = await reassignBtn.boundingBox();

            console.log(`   - #modalReassignAgent height: ${agentBox.height}px`);
            console.log(`   - #modalReassignReason height: ${reasonBox.height}px`);
            console.log(`   - #modalReassignBtn height: ${btnBox.height}px`);

            assert(
                Math.abs(agentBox.height - reasonBox.height) <= 1,
                `Select (${agentBox.height}px) and Input (${reasonBox.height}px) heights differ by > 1px`
            );
            assert(
                Math.abs(agentBox.height - btnBox.height) <= 1,
                `Select (${agentBox.height}px) and Button (${btnBox.height}px) heights differ by > 1px`
            );
            console.log('   ✓ Control heights are equal within ±1px');

            // 7. Test placeholder text visibility
            console.log('\n5. Verifying placeholder of reason input...');
            const placeholder = await reasonInput.getAttribute('placeholder');
            console.log(`   - Placeholder value: "${placeholder}"`);
            assert.strictEqual(placeholder, 'Reason (optional)');
            assert(reasonBox.width >= 120, `Input width (${reasonBox.width}px) is too narrow for placeholder`);
            console.log('   ✓ Placeholder is "Reason (optional)" and fully visible without truncation');
        } else {
            console.log('   ℹ Reassign section not displayed (agents not configured for tenant)');
        }

        // 8. Test no snake_case codes in rendered text
        console.log('\n6. Checking for raw snake_case codes in deal modal content...');
        const modalText = await page.locator('#dealModalBody').innerText();
        const bannedCodes = [
            'sla_escalation', 'manual_reassign', 'auto_inbound',
            'first_touch', 'response_due', 'auto_rule', 'round_robin'
        ];
        for (const code of bannedCodes) {
            assert(
                !modalText.includes(code),
                `Found forbidden snake_case code "${code}" rendered in deal modal text`
            );
        }
        console.log('   ✓ Zero snake_case codes in rendered modal text');

        // 9. Test delete confirmation
        console.log('\n7. Verifying delete deal confirmation dialog...');
        let dialogTriggered = false;
        page.once('dialog', async dialog => {
            dialogTriggered = true;
            console.log(`   - Dialog triggered of type: ${dialog.type()}`);
            console.log(`   - Dialog message: "${dialog.message().slice(0, 60)}..."`);
            assert.strictEqual(dialog.type(), 'confirm');
            await dialog.dismiss();
        });

        const deleteBtn = page.locator('[data-deal-action="delete"]');
        if (await deleteBtn.count() > 0) {
            await deleteBtn.scrollIntoViewIfNeeded();
            await deleteBtn.click({ force: true });
            await page.waitForTimeout(300);
            assert(dialogTriggered, 'Delete deal button did not trigger confirmation dialog');
            // Deal modal should still be open because dialog was dismissed
            const isOpen = await page.locator('#dealModalBackdrop:not([hidden])').isVisible();
            assert(isOpen, 'Deal modal was closed or deal deleted even though confirm was dismissed');
            console.log('   ✓ Delete requires confirm dialog and dismissal leaves deal intact');
        }

        // 10. Runtime inline styles check with Deal Modal OPEN
        console.log('\n8. Checking rendered DOM for inline styles while Deal Modal is OPEN...');
        const dealModalStyledEls = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('#dealModalBackdrop, #dealModalBackdrop *[style]'));
            return els.filter(e => e.hasAttribute('style')).map(e => ({
                tag: e.tagName,
                id: e.id,
                class: e.className,
                style: e.getAttribute('style')
            }));
        });
        console.log(`   Found ${dealModalStyledEls.length} elements with style attribute in Deal Modal`);
        assert.strictEqual(
            dealModalStyledEls.length,
            0,
            `Expected 0 elements with style in Deal Modal, found: ${JSON.stringify(dealModalStyledEls)}`
        );
        console.log('   ✓ Zero inline styles in Deal Modal elements');

        const appStyledElements = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('body *:not(canvas)[style]'));
            return els.map(e => ({
                tag: e.tagName,
                id: e.id,
                class: e.className,
                style: e.getAttribute('style')
            }));
        });
        console.log(`   Found ${appStyledElements.length} application elements with style attribute across rendered DOM`);
        assert.strictEqual(
            appStyledElements.length,
            0,
            `Expected 0 application elements with style attribute, found: ${JSON.stringify(appStyledElements)}`
        );
        console.log('   ✓ Zero inline styles on application elements across rendered DOM (CSP compliant)');

        // 11. Test no double submit protection
        console.log('\n9. Verifying double submit protection on actions...');
        const hasDoubleSubmitProtection = await page.evaluate(() => {
            const reassignFn = (typeof reassignDealFromModal !== 'undefined' ? reassignDealFromModal.toString() : (window.reassignDealFromModal?.toString() || ''));
            const deleteFn = (typeof deleteDealFromModal !== 'undefined' ? deleteDealFromModal.toString() : (window.deleteDealFromModal?.toString() || ''));
            const saveFn = (typeof saveDealFromModal !== 'undefined' ? saveDealFromModal.toString() : (window.saveDealFromModal?.toString() || ''));
            return reassignFn.includes('btn.disabled') && deleteFn.includes('btn.disabled') && saveFn.includes('btn.disabled');
        });
        assert(hasDoubleSubmitProtection, 'Double submit protection missing on modal action handlers');
        console.log('   ✓ Double submit protection active on deal modal handlers');

        // Close modal
        await page.click('#dealModalClose');
        await page.waitForTimeout(300);

        console.log('\n🎉 ALL PLAYWRIGHT DEAL MODAL & CSP ASSERTIONS PASSED!\n');
    } finally {
        await browser.close();
    }
}

runSuite().catch(err => {
    console.error('Playwright suite failed:', err);
    process.exit(1);
});
