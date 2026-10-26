// Diagnostic: proves which whatsapp-client exports media-dispatch actually receives,
// and whether a circular require hands it a partially-initialised module.
'use strict';
require('dotenv').config();
const Module = require('module');
const path = require('path');

const stack = [];
const cycles = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { return origLoad.apply(this, arguments); }
    const inSrc = resolved.includes(`${path.sep}src${path.sep}`);
    if (inSrc && stack.includes(resolved)) {
        cycles.push([...stack.slice(stack.indexOf(resolved)), resolved].map(p => path.relative(process.cwd(), p)));
    }
    if (inSrc) stack.push(resolved);
    try { return origLoad.apply(this, arguments); } finally { if (inSrc) stack.pop(); }
};

const wa = require('../../src/services/whatsapp-client');
const exportsList = Object.keys(wa).sort();
console.log('whatsapp-client exports:', exportsList.join(', '));
console.log('typeof wa.getSession =', typeof wa.getSession);
console.log('typeof wa.getClient  =', typeof wa.getClient);
console.log('typeof wa.resolveDestinationChatId =', typeof wa.resolveDestinationChatId);
const md = require('../../src/services/media-dispatch');
console.log('media-dispatch exports:', Object.keys(md).join(', '));
console.log('circular requires inside src:', cycles.length ? JSON.stringify(cycles, null, 1) : 'none');
process.exit(0);
