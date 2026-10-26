const { chromium } = require('playwright');
const path = require('path');

async function snap() {
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
    const page = await context.newPage();

    console.log('Logging in...');
    await page.goto('http://127.0.0.1:3000/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#submitBtn');
    await page.waitForTimeout(500);
    await page.fill('#email', 'aryan@gmail.com');
    await page.fill('#password', 'password123');
    await page.click('#loginForm button[type="submit"]', { force: true });
    await page.waitForURL('**/app', { timeout: 10000 });

    console.log('Navigating to /admin...');
    await page.goto('http://127.0.0.1:3000/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#platformStats .admin-stat-card', { timeout: 15000 });
    await page.waitForTimeout(1500);

    const artifactPath = 'C:\\Users\\HP\\.gemini\\antigravity-ide\\brain\\348ad6b4-d46c-4ff0-aa3d-74cfca1a55f6\\admin_panel_redesign.png';
    await page.screenshot({ path: artifactPath });
    console.log('Screenshot saved to:', artifactPath);

    await browser.close();
}

snap().catch(e => {
    console.error('Error snapping screenshot:', e);
    process.exit(1);
});
