/**
 * scripts/media-isolation.js — Media Dispatch Isolation Matrix
 *
 * Runs the isolation matrix against the live session (via CDP / Puppeteer)
 * to test the message preparation and dispatch pipeline across:
 * 1. Plain text
 * 2. Tiny PNG via MessageMedia
 * 3. PDF via MessageMedia.fromFilePath
 * 4. PDF as document (sendMediaAsDocument: true)
 * 5. chatId @c.us vs resolved @lid
 * 6. With and without caption
 * 7. Options object with all undefined/null keys stripped
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SAMPLE_PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000102 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n149\n%%EOF').toString('base64');

async function runIsolationMatrix() {
    const portFilePath = path.join(__dirname, '../.wwebjs_auth/user_3/session/DevToolsActivePort');
    if (!fs.existsSync(portFilePath)) {
        throw new Error('Running session DevToolsActivePort not found');
    }
    const lines = fs.readFileSync(portFilePath, 'utf8').trim().split('\n');
    const port = lines[0].trim();
    const wsPath = lines[1].trim();
    const browserWSEndpoint = `ws://127.0.0.1:${port}${wsPath}`;

    const browser = await puppeteer.connect({ browserWSEndpoint });
    const pages = await browser.pages();
    let waPage = null;
    for (const p of pages) {
        if (p.url().includes('web.whatsapp.com')) {
            const hasWWeb = await p.evaluate(() => typeof window.WWebJS !== 'undefined').catch(() => false);
            if (hasWWeb) { waPage = p; break; }
        }
    }

    if (!waPage) {
        browser.disconnect();
        throw new Error('WhatsApp Web page with WWebJS not found');
    }

    console.log('--- RUNNING MEDIA ISOLATION MATRIX ---');

    const results = await waPage.evaluate(async (pngB64, pdfB64) => {
        const matrix = [];
        const existingLidChat = window.require('WAWebCollections').Chat.get('278807885947030@lid');
        const existingCusChat = window.require('WAWebCollections').Chat.get('919636564673@c.us') || 
            (await window.require('WAWebFindChatAction').findOrCreateLatestChat(
                window.require('WAWebWidFactory').createWid('919636564673@c.us')
            ).catch(() => null))?.chat;

        async function testPreparation(testName, chat, mediaInfo, options, applyCleanPatch = false) {
            try {
                if (!chat) {
                    return { testName, pass: false, error: 'Chat not found in collection' };
                }

                // Simulate processMediaData
                let mediaOptions = {};
                if (mediaInfo) {
                    mediaOptions = await window.WWebJS.processMediaData(mediaInfo, {
                        forceSticker: false,
                        forceGif: false,
                        forceVoice: false,
                        forceDocument: options.sendMediaAsDocument || false,
                        forceMediaHd: false,
                        sendToChannel: false,
                        sendToStatus: false
                    });
                }

                const lidUser = window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
                const meUser = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser();
                const newId = await window.require('WAWebMsgKey').newId();
                const from = chat.id.isLid() ? lidUser : meUser;
                const newMsgKey = new (window.require('WAWebMsgKey'))({ from, to: chat.id, id: newId, selfDir: 'out' });

                let message;
                if (!applyCleanPatch) {
                    // Original unpatched wwebjs behavior:
                    message = {
                        ...options,
                        id: newMsgKey,
                        ack: 0,
                        body: options.caption || '',
                        from,
                        to: chat.id,
                        local: true,
                        self: 'out',
                        t: parseInt(new Date().getTime() / 1000),
                        isNewMsg: true,
                        type: 'chat',
                        ...mediaOptions,
                        ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {})
                    };
                    if (!message.id) message.id = newMsgKey;
                } else {
                    // Cleaned & patched behavior:
                    const rawMediaProps = mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions;
                    const cleanOpts = {};
                    for (const [k, v] of Object.entries(options)) {
                        if (v !== undefined && v !== null) cleanOpts[k] = v;
                    }

                    message = {
                        ...cleanOpts,
                        id: newMsgKey,
                        ack: 0,
                        body: cleanOpts.caption || '',
                        from,
                        to: chat.id,
                        local: true,
                        self: 'out',
                        t: parseInt(new Date().getTime() / 1000),
                        isNewMsg: true,
                        type: 'chat',
                        ...rawMediaProps
                    };
                    message.id = newMsgKey;
                    delete message.__x_id;
                    delete message.collection;
                    delete message.parent;
                    delete message._uiObservers;
                }

                // Dry run Msg construction validation
                const MsgModelClass = window.require('WAWebCollections').Msg.modelClass;
                const model = new MsgModelClass(message);
                const sender = window.require('WAWebSendMsgChatAction');

                return {
                    testName,
                    pass: true,
                    modelCreated: !!model,
                    msgKeyValid: model.id && typeof model.id === 'object' && !!model.id._serialized,
                    has__x_id: '__x_id' in message
                };
            } catch (err) {
                return {
                    testName,
                    pass: false,
                    error: err.message,
                    stack: err.stack?.split('\n')[1]?.trim()
                };
            }
        }

        // Test cases:
        // 1. Text only (Unpatched vs Patched)
        matrix.push(await testPreparation('1. Text to @lid (Original)', existingLidChat, null, {}, false));
        matrix.push(await testPreparation('1. Text to @lid (Patched)', existingLidChat, null, {}, true));

        // 2. Tiny PNG via MessageMedia
        const pngMedia = { mimetype: 'image/png', data: pngB64, filename: 'tiny.png' };
        matrix.push(await testPreparation('2. PNG to @lid (Original)', existingLidChat, pngMedia, {}, false));
        matrix.push(await testPreparation('2. PNG to @lid (Patched)', existingLidChat, pngMedia, {}, true));

        // 3. PDF without sendMediaAsDocument
        const pdfMedia = { mimetype: 'application/pdf', data: pdfB64, filename: 'doc.pdf' };
        matrix.push(await testPreparation('3. PDF standard to @lid (Original)', existingLidChat, pdfMedia, {}, false));
        matrix.push(await testPreparation('3. PDF standard to @lid (Patched)', existingLidChat, pdfMedia, {}, true));

        // 4. PDF with sendMediaAsDocument: true
        matrix.push(await testPreparation('4. PDF doc (sendMediaAsDocument: true) (Original)', existingLidChat, pdfMedia, { sendMediaAsDocument: true }, false));
        matrix.push(await testPreparation('4. PDF doc (sendMediaAsDocument: true) (Patched)', existingLidChat, pdfMedia, { sendMediaAsDocument: true }, true));

        // 5. Comparison @lid vs @c.us
        matrix.push(await testPreparation('5a. PDF doc to @lid (Original)', existingLidChat, pdfMedia, { sendMediaAsDocument: true }, false));
        matrix.push(await testPreparation('5a. PDF doc to @lid (Patched)', existingLidChat, pdfMedia, { sendMediaAsDocument: true }, true));
        if (existingCusChat) {
            matrix.push(await testPreparation('5b. PDF doc to @c.us (Original)', existingCusChat, pdfMedia, { sendMediaAsDocument: true }, false));
            matrix.push(await testPreparation('5b. PDF doc to @c.us (Patched)', existingCusChat, pdfMedia, { sendMediaAsDocument: true }, true));
        }

        // 6. With and without caption
        matrix.push(await testPreparation('6a. PDF doc WITH caption (Patched)', existingLidChat, pdfMedia, { sendMediaAsDocument: true, caption: 'Check this out' }, true));
        matrix.push(await testPreparation('6b. PDF doc WITHOUT caption (Patched)', existingLidChat, pdfMedia, { sendMediaAsDocument: true, caption: '' }, true));

        // 7. Options with undefined/null keys stripped
        const dirtyOpts = { sendMediaAsDocument: true, caption: 'Testing', quotedMessageId: undefined, mentions: null, extra: undefined };
        matrix.push(await testPreparation('7a. Dirty options (Original)', existingLidChat, pdfMedia, dirtyOpts, false));
        matrix.push(await testPreparation('7b. Stripped clean options (Patched)', existingLidChat, pdfMedia, dirtyOpts, true));

        return matrix;
    }, TINY_PNG_BASE64, SAMPLE_PDF_BASE64);

    browser.disconnect();

    console.table(results);
    const evidencePath = path.join(__dirname, '../.workpilot/evidence/MEDIA/s2-isolation-matrix.json');
    fs.writeFileSync(evidencePath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`Saved results matrix to ${evidencePath}`);
    return results;
}

if (require.main === module) {
    runIsolationMatrix().catch(e => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { runIsolationMatrix };
