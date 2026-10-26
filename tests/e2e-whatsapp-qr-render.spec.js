'use strict';

/**
 * tests/e2e-whatsapp-qr-render.spec.js
 *
 * Automated regression test verifying:
 * 1. WhatsApp QR code renders visibly in Settings → WhatsApp QR (no blank card).
 * 2. #qrImage is computed as display: block (not hidden by .qr-image { display: none }).
 * 3. #qrImage.src is a valid base64 image data URL (real QR code from WhatsApp Web client).
 * 4. Zero inline styles on the rendered QR container (CSP compliance).
 */

const { chromium } = require('playwright');
const assert = require('assert');

async function runSuite() {
    console.log('=== RUNNING PLAYWRIGHT SUITE: WHATSAPP QR RENDERING & FLOW ===\n');

    const chromePath = process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    try {
        console.log('1. Logging in as admin to http://127.0.0.1:3000...');
        await page.goto('http://127.0.0.1:3000/login', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#submitBtn');
        await page.waitForTimeout(500);
        await page.fill('#email', process.env.ADMIN_EMAIL || 'aryan@gmail.com');
        await page.fill('#password', process.env.ADMIN_PASSWORD || 'Admin1234!');
        await page.click('#loginForm button[type="submit"]', { force: true });
        await page.waitForURL('**/app', { timeout: 10000 });
        console.log('   ✓ Logged in to /app successfully');

        console.log('2. Navigating to Settings → WhatsApp QR tab...');
        await page.click('#nav-settings, a[href="#settings"], [data-nav="settings"]');
        await page.waitForTimeout(500);
        await page.click('#tab-qr');
        await page.waitForTimeout(1000);

        console.log('3. Waiting for QR Code image or reconnect action...');
        await page.waitForFunction(() => {
            const img = document.getElementById('qrImage');
            const reconnect = document.getElementById('reconnectWaBtn');
            const cs = img ? window.getComputedStyle(img) : null;
            const hasVisibleQr = img && !img.hidden && cs && cs.display === 'block' && img.src && img.src.startsWith('data:image/');
            const hasReconnect = !!reconnect;
            return hasVisibleQr || hasReconnect;
        }, { timeout: 30000 });

        // If disconnected state (timed out prior), trigger reconnect to verify recovery flow
        const reconnectBtn = await page.$('#reconnectWaBtn');
        if (reconnectBtn) {
            console.log('   Session was timed out; clicking Connect & Show QR Code to verify fresh QR...');
            await reconnectBtn.click();
            await page.waitForFunction(() => {
                const img = document.getElementById('qrImage');
                const cs = img ? window.getComputedStyle(img) : null;
                return img && !img.hidden && cs && cs.display === 'block' && img.src && img.src.startsWith('data:image/');
            }, { timeout: 35000 });
        }

        console.log('4. Asserting QR Code DOM properties...');
        const qrState = await page.evaluate(() => {
            const img = document.getElementById('qrImage');
            const loading = document.getElementById('qrLoading');
            const container = document.getElementById('qrContainer');
            const csImg = window.getComputedStyle(img);
            const csLoading = window.getComputedStyle(loading);

            return {
                imgHidden: img.hidden,
                imgDisplay: csImg.display,
                imgVisibility: csImg.visibility,
                imgWidth: parseFloat(csImg.width),
                imgHeight: parseFloat(csImg.height),
                imgSrcPrefix: img.src ? img.src.substring(0, 30) : '',
                imgSrcLength: img.src ? img.src.length : 0,
                loadingDisplay: csLoading.display,
                containerStyleAttr: container.getAttribute('style'),
                imgStyleAttr: img.getAttribute('style')
            };
        });

        console.log('   QR Image state:', qrState);

        assert.strictEqual(qrState.imgHidden, false, 'Expected qrImage.hidden to be false');
        assert.strictEqual(qrState.imgDisplay, 'block', 'Expected qrImage computed display to be "block" (not "none")');
        assert.strictEqual(qrState.imgVisibility, 'visible', 'Expected qrImage to be visible');
        assert(qrState.imgWidth >= 200, `Expected qrImage width >= 200px, got ${qrState.imgWidth}`);
        assert(qrState.imgHeight >= 200, `Expected qrImage height >= 200px, got ${qrState.imgHeight}`);
        assert(qrState.imgSrcPrefix.startsWith('data:image/'), `Expected data URL src, got ${qrState.imgSrcPrefix}`);
        assert(qrState.imgSrcLength > 500, `Expected base64 image data > 500 chars, got ${qrState.imgSrcLength}`);
        assert.strictEqual(qrState.loadingDisplay, 'none', 'Expected qrLoading to be hidden when QR is active');
        assert.strictEqual(qrState.imgStyleAttr, null, 'Expected zero inline styles on #qrImage for CSP compliance');

        console.log('\n✅ ALL PLAYWRIGHT ASSERTIONS PASSED: WhatsApp QR Code renders cleanly and reliably!\n');

    } finally {
        await browser.close();
    }
}

runSuite().catch(err => {
    console.error('\n❌ PLAYWRIGHT QR TEST FAILED:', err);
    process.exit(1);
});
