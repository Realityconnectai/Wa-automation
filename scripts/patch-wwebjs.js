// scripts/patch-wwebjs.js — Automated, reproducible postinstall patch for whatsapp-web.js
// Fixes "Data passed to get must include an id property ... but got undefined"
// by preventing mediaOptions.toJSON() from overwriting message.id with undefined.

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');

function applyPatch() {
    if (!fs.existsSync(targetFile)) {
        console.log('Notice: node_modules/whatsapp-web.js not found, skipping patch.');
        return;
    }

    const content = fs.readFileSync(targetFile, 'utf8');

    // Check if already patched
    if (content.includes('if (!message.id) {') || content.includes('if (!message.id) message.id')) {
        console.log('✔ whatsapp-web.js is already patched with message.id guard.');
        return;
    }

    const targetBlock = '...extraOptions,\n        };';
    const replacementBlock = '...extraOptions,\n        };\n\n        if (!message.id) {\n            message.id = newMsgKey;\n        }';

    if (!content.includes(targetBlock)) {
        // Try CRLF matching
        const targetBlockCRLF = '...extraOptions,\r\n        };';
        const replacementBlockCRLF = '...extraOptions,\r\n        };\r\n\r\n        if (!message.id) {\r\n            message.id = newMsgKey;\r\n        }';
        if (content.includes(targetBlockCRLF)) {
            const updated = content.replace(targetBlockCRLF, replacementBlockCRLF);
            fs.writeFileSync(targetFile, updated, 'utf8');
            console.log('✔ Successfully patched whatsapp-web.js Injected/Utils.js (CRLF).');
            return;
        }
        console.warn('⚠️  Could not locate insertion point in whatsapp-web.js Utils.js');
        return;
    }

    const updated = content.replace(targetBlock, replacementBlock);
    fs.writeFileSync(targetFile, updated, 'utf8');
    console.log('✔ Successfully patched whatsapp-web.js Injected/Utils.js.');
}

applyPatch();
