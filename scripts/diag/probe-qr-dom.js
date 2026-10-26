const { chromium } = require('playwright');

async function probe() {
    const chromePath = process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
    page.on('pageerror', err => console.log('BROWSER PAGEERROR:', err.message));
    page.on('request', req => {
        if (req.url().includes('qr-stream') || req.url().includes('/status') || req.url().includes('whatsapp')) {
            console.log('REQ:', req.method(), req.url());
        }
    });
    page.on('response', async res => {
        if (res.url().includes('qr-stream') || res.url().includes('/status') || res.url().includes('whatsapp')) {
            console.log('RES:', res.status(), res.url());
            if (res.url().includes('/api/status')) {
                try {
                    const text = await res.text();
                    console.log('BODY /api/status:\n', text);
                } catch (_) {}
            }
        }
    });

    console.log('1. Navigating to login...');
    await page.goto('http://127.0.0.1:3000/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#submitBtn');
    await page.waitForTimeout(500);
    await page.fill('#email', process.env.ADMIN_EMAIL || 'aryan@gmail.com');
    await page.fill('#password', process.env.ADMIN_PASSWORD || 'Admin1234!');
    await page.click('#loginForm button[type="submit"]', { force: true });
    await page.waitForURL('**/app', { timeout: 10000 });
    console.log('   ✓ Logged in to /app');

    // Wait up to 25s for QR event to arrive
    console.log('Waiting for QR event or connection state...');
    await page.waitForFunction(() => {
        const text = document.getElementById('connectionInfo')?.innerText || '';
        return text.includes('Waiting for QR Code scan') || text.includes('Connected to WhatsApp') || text.includes('Not connected');
    }, { timeout: 25000 }).catch(e => console.log('Wait timeout or already in state:', e.message));

    await page.waitForTimeout(1000);

    // Switch to Settings
    console.log('2. Switching to Settings view...');
    await page.click('#nav-settings, a[href="#settings"], [data-nav="settings"]');
    await page.waitForTimeout(500);

    // Switch to WhatsApp QR tab
    console.log('3. Switching to WhatsApp QR tab (#tab-qr)...');
    await page.click('#tab-qr');
    await page.waitForTimeout(1000);

    // If disconnected, click Connect & Show QR Code
    const reconnectBtn = await page.$('#reconnectWaBtn');
    if (reconnectBtn) {
        console.log('4. Clicking "Connect & Show QR Code" button...');
        await reconnectBtn.click();
        console.log('   Waiting for QR code to generate and render...');
        await page.waitForFunction(() => {
            const img = document.getElementById('qrImage');
            const cs = img ? window.getComputedStyle(img) : null;
            return img && !img.hidden && cs && cs.display === 'block' && img.src && img.src.startsWith('data:image/');
        }, { timeout: 35000 });
        console.log('   ✓ Fresh QR code successfully rendered in DOM!');
    }

    // Inspect final DOM state
    const domState = await page.evaluate(() => {
        const qrContainer = document.getElementById('qrContainer');
        const qrLoading = document.getElementById('qrLoading');
        const qrImage = document.getElementById('qrImage');
        const qrSuccess = document.getElementById('qrSuccess');
        const connInfo = document.getElementById('connectionInfo');

        function getInfo(el) {
            if (!el) return null;
            const cs = window.getComputedStyle(el);
            return {
                tagName: el.tagName,
                id: el.id,
                hidden: el.hidden,
                hasHiddenAttr: el.hasAttribute('hidden'),
                styleAttr: el.getAttribute('style'),
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
                width: cs.width,
                height: cs.height,
                src: el.src ? (el.src.startsWith('data:') ? el.src.substring(0, 50) + '... (length ' + el.src.length + ')' : el.src) : null,
                textContent: el.textContent?.trim()?.substring(0, 100)
            };
        }

        return {
            connInfoText: connInfo?.innerText?.trim(),
            qrContainerHTML: qrContainer?.innerHTML,
            qrContainer: getInfo(qrContainer),
            qrLoading: getInfo(qrLoading),
            qrImage: getInfo(qrImage),
            qrSuccess: getInfo(qrSuccess)
        };
    });

    console.log('FINAL DOM STATE:\n', JSON.stringify(domState, null, 2));

    const artifactPath = 'C:\\Users\\HP\\.gemini\\antigravity-ide\\brain\\348ad6b4-d46c-4ff0-aa3d-74cfca1a55f6\\probe_qr_screenshot.png';
    await page.screenshot({ path: artifactPath });
    console.log('Screenshot saved to:', artifactPath);

    await browser.close();
}

probe().catch(e => {
    console.error('Probe failed:', e);
    process.exit(1);
});
