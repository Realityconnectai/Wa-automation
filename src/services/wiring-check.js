/**
 * wiring-check.js — Startup / boot invariant verification for inter-service wiring.
 *
 * Catches JavaScript wiring regressions (like missing exports or circular require
 * undefined imports) before requests or background campaign jobs execute.
 */

function assertIsFunction(obj, funcName, moduleName) {
    if (!obj || typeof obj[funcName] !== 'function') {
        const actualType = obj ? typeof obj[funcName] : 'undefined';
        throw new Error(
            `[FATAL WIRING REGRESSION] ${moduleName}.${funcName} must be a function, but got ${actualType}. ` +
            `Check module exports and verify there are no circular dependency failures.`
        );
    }
}

function verifyWiring() {
    const waClient = require('./whatsapp-client');
    assertIsFunction(waClient, 'getSession', 'whatsapp-client');
    assertIsFunction(waClient, 'getConnectedSession', 'whatsapp-client');
    assertIsFunction(waClient, 'getClient', 'whatsapp-client');
    assertIsFunction(waClient, 'sendTextMessage', 'whatsapp-client');
    assertIsFunction(waClient, 'sendMediaMessage', 'whatsapp-client');

    const mediaDispatch = require('./media-dispatch');
    assertIsFunction(mediaDispatch, 'dispatchMedia', 'media-dispatch');

    const messaging = require('./messaging');
    assertIsFunction(messaging, 'sendMedia', 'messaging');
    assertIsFunction(messaging, 'sendText', 'messaging');

    const outreach = require('./outreach');
    assertIsFunction(outreach, 'startOutreachJob', 'outreach');
    assertIsFunction(outreach, 'runJob', 'outreach');
    assertIsFunction(outreach, 'retryFailedOutreachRecipients', 'outreach');
    assertIsFunction(outreach, 'getOutreachJob', 'outreach');
    assertIsFunction(outreach, 'getOutreachJobs', 'outreach');

    const db = require('./database');
    assertIsFunction(db, 'getOutreachJob', 'database');
    assertIsFunction(db, 'getOutreachJobs', 'database');
    assertIsFunction(db, 'createOutreachJob', 'database');
    assertIsFunction(db, 'getMediaAssetById', 'database');

    return true;
}

module.exports = {
    verifyWiring
};
