const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function main() {
    const portFilePath = path.join(__dirname, '../.wwebjs_auth/user_3/session/DevToolsActivePort');
    if (!fs.existsSync(portFilePath)) {
        console.error('DevToolsActivePort not found');
        process.exit(1);
    }
    const lines = fs.readFileSync(portFilePath, 'utf8').trim().split('\n');
    const port = lines[0].trim();
    const wsPath = lines[1].trim();
    const browserWSEndpoint = `ws://127.0.0.1:${port}${wsPath}`;
    console.log('Connecting to browser at', browserWSEndpoint);

    const browser = await puppeteer.connect({ browserWSEndpoint });
    const pages = await browser.pages();
    console.log(`Found ${pages.length} pages in running Chrome.`);

    for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const url = p.url();
        console.log(`Page [${i}] URL:`, url);
        try {
            const hasWWeb = await p.evaluate(() => typeof window.WWebJS !== 'undefined');
            console.log(`Page [${i}] has WWebJS:`, hasWWeb);
            if (hasWWeb) {
                const info = await p.evaluate(() => ({
                    version: window.Debug?.VERSION,
                    hasSendMessage: typeof window.WWebJS?.sendMessage === 'function',
                    hasProcessMedia: typeof window.WWebJS?.processMediaData === 'function'
                }));
                console.log(`Page [${i}] WWebJS details:`, info);
            }
        } catch (e) {
            console.log(`Page [${i}] eval error:`, e.message);
        }
    }

    browser.disconnect();
}

main().catch(err => {
    console.error('Inspection error:', err);
    process.exit(1);
});
