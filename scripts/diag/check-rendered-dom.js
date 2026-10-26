const { chromium } = require('playwright');

async function main() {
    const chromePath = process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    console.log('Navigating to login...');
    await page.goto('http://127.0.0.1:3000/login', { waitUntil: 'domcontentloaded' });
    console.log('Filling credentials...');
    await page.fill('#email', 'aryan@gmail.com');
    await page.fill('#password', 'password123');
    await page.click('#loginForm button[type="submit"]', { force: true });
    console.log('Waiting for app page...');
    await page.waitForURL('**/app', { timeout: 10000 });
    console.log('Logged in successfully to /app!');
    await page.waitForTimeout(1000);

    const styledElements = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*[style]'));
        return els.map(e => ({
            tag: e.tagName,
            id: e.id,
            class: e.className,
            style: e.getAttribute('style')
        }));
    });
    console.log('Styled elements count:', styledElements.length);
    console.log('Elements with style attribute:', styledElements);
    await browser.close();
}

main().catch(err => {
    console.error('Check failed:', err);
    process.exit(1);
});
