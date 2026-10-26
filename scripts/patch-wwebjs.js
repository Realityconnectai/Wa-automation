// scripts/patch-wwebjs.js — Automated, reproducible postinstall patch for whatsapp-web.js
// Fixes "Data passed to getter must include an id property ... but got undefined"
// Root cause: Injected/Utils.js spreads mediaOptions (an instance of MediaData),
// leaking internal properties (__x_id: { sentinel... }, parent, collection) into
// the outgoing Msg model and corrupting message.id.
// This patch cleans rawMediaProps and strips private model identifiers.

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');

function applyPatch() {
    if (!fs.existsSync(targetFile)) {
        console.log('Notice: node_modules/whatsapp-web.js not found, skipping patch.');
        return;
    }

    let content = fs.readFileSync(targetFile, 'utf8');

    // Check if the comprehensive patch is already applied
    if (content.includes('delete message.__x_id;') && content.includes('message.id = newMsgKey;')) {
        console.log('✔ whatsapp-web.js is already patched with comprehensive media cleaner & message.id guard.');
        return;
    }

    // If an earlier simple patch was applied, clean it out first
    content = content.replace(
        /\n\s*if \(!message\.id\) \{\s*message\.id = newMsgKey;\s*\}/g,
        ''
    );
    content = content.replace(
        /\r\n\s*if \(!message\.id\) \{\s*message\.id = newMsgKey;\s*\}/g,
        ''
    );

    // Patch 1: Replace direct mediaOptions spread with clean JSON attributes
    const oldMediaSpreadLF = '...mediaOptions,\n            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),';
    const oldMediaSpreadCRLF = '...mediaOptions,\r\n            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),';
    const newMediaSpreadLF = '...(mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions),';

    if (content.includes(oldMediaSpreadLF)) {
        content = content.replace(oldMediaSpreadLF, newMediaSpreadLF);
    } else if (content.includes(oldMediaSpreadCRLF)) {
        content = content.replace(oldMediaSpreadCRLF, newMediaSpreadLF);
    }

    // Patch 2: Add post-assembly cleanup after ...extraOptions, };
    const targetBlockLF = '...extraOptions,\n        };';
    const targetBlockCRLF = '...extraOptions,\r\n        };';
    const replacementLF = `...extraOptions,
        };

        // WORKPILOT MEDIA FIX: Guarantee MsgKey and strip internal MediaData properties
        message.id = newMsgKey;
        delete message.__x_id;
        delete message.collection;
        delete message.parent;
        delete message._uiObservers;`;

    if (content.includes(targetBlockLF)) {
        content = content.replace(targetBlockLF, replacementLF);
    } else if (content.includes(targetBlockCRLF)) {
        content = content.replace(targetBlockCRLF, replacementLF.replace(/\n/g, '\r\n'));
    } else {
        console.warn('⚠️  Could not locate insertion point in whatsapp-web.js Utils.js');
        return;
    }

    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('✔ Successfully applied comprehensive patch to whatsapp-web.js Injected/Utils.js.');
}

applyPatch();
