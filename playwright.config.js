'use strict';

const path = require('path');
const defaultChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

module.exports = {
    use: {
        browserName: 'chromium',
        launchOptions: { executablePath: process.env.E2E_CHROME_PATH || defaultChrome, headless: true },
        baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3101'
    },
    outputDir: path.join(__dirname, 'test-suite-output', 'playwright')
};
