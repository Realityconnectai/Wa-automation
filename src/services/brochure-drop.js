/**
 * src/services/brochure-drop.js — Rule-based brochure drop (no AI latency).
 *
 * On an inbound message, checks for real estate intent triggers (#3BHK,
 * "3 BHK", project names, listing IDs, etc.) BEFORE the AI path.
 * If exactly ONE project matches, sends its active brochure then walkthrough.
 * If ZERO or MULTIPLE projects match, sends a clarification question.
 * Never labels a brochure "RERA verified" unless rera_verified=1 in the DB.
 *
 * Timing: inbound_received_at is stamped when processMessage fires (in
 * chatbot.js). send_accepted_at is stamped here after sendMedia() resolves.
 * The elapsed time is returned and can be logged or stored — we do NOT
 * claim a 10-second guarantee, only record the real number.
 *
 * Asset sending uses src/services/messaging.js sendMedia() so the provider
 * boundary is respected.
 *
 * Per-tenant trigger keywords are stored in the 'brochure_triggers' setting
 * as a JSON array of strings: ["3BHK","#3BHK","Plot","Sunrise Towers","ST001"]
 * Default triggers are applied when the setting is absent.
 */
'use strict';

const { getSetting, getProjects, getMediaAssets, logMessage, logBrochureDropEvent } = require('./database');
// messaging is required lazily at call time so tests can mock it via jest.mock
// without needing to patch module-scope references.
function getMessaging() { return require('./messaging'); }

// ─── Default built-in triggers ─────────────────────────────────────────
const DEFAULT_TRIGGERS = [
    // BHK patterns
    /\b1\s*bhk\b/i, /\b2\s*bhk\b/i, /\b3\s*bhk\b/i, /\b4\s*bhk\b/i,
    /\b1bhk\b/i,    /\b2bhk\b/i,    /\b3bhk\b/i,    /\b4bhk\b/i,
    // Hash-tag variants
    /#1bhk/i, /#2bhk/i, /#3bhk/i, /#4bhk/i, /#plot/i,
    // Generic property inquiry
    /\bplot\b/i, /\bflat\b/i, /\bapartment\b/i, /\bvilla\b/i,
    /\bproperty\b/i, /\bbrochure\b/i, /\bprice\s*list\b/i,
];

/**
 * Returns the list of per-tenant trigger regexes.
 * Reads the 'brochure_triggers' setting (JSON array of strings).
 * Falls back to DEFAULT_TRIGGERS if not configured.
 */
async function getTriggers(userId) {
    try {
        const raw = await getSetting(userId, 'brochure_triggers');
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) {
                return arr.map(s => {
                    try { return new RegExp(s.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&'), 'i'); }
                    catch (_) { return null; }
                }).filter(Boolean);
            }
        }
    } catch (_) {}
    return DEFAULT_TRIGGERS;
}

/**
 * Checks whether a message text contains any real estate trigger.
 */
async function hasTrigger(userId, text) {
    const triggers = await getTriggers(userId);
    return triggers.some(re => re.test(text));
}

async function getSelectedAssetIds(userId, projectId) {
    try {
        const raw = await getSetting(userId, 'brochure_asset_selection');
        if (!raw) return null; // No configuration preserves the safe legacy default.
        const config = JSON.parse(raw);
        const selected = config?.[String(projectId)];
        if (!Array.isArray(selected)) return null;
        return new Set(selected.map(Number).filter(Number.isInteger));
    } catch (_) {
        return null;
    }
}

/**
 * Tries to match the message to exactly one active project.
 *
 * Matching strategy (in order):
 *   1. Project name appears in the message (case-insensitive substring)
 *   2. Message contains listing_url or rera_number that matches a project
 *   3. BHK-only messages: if only one active project exists, match it
 *   4. Multiple candidates → return all (caller asks clarification)
 *   5. No candidates → return empty
 *
 * Returns:  { matched: Project[], reason: string }
 */
async function matchProjects(userId, text) {
    const projects = await getProjects(userId, { activeOnly: true });
    if (!projects.length) return { matched: [], reason: 'no_projects' };

    const textLower = text.toLowerCase();

    // Named matches
    const named = projects.filter(p => projectReferences(p).some(ref => textLower.includes(ref)));
    if (named.length === 1) return { matched: named, reason: 'name_match' };
    if (named.length > 1) return { matched: named, reason: 'ambiguous_name' };

    // Fall back to "any active project" when only one exists
    if (projects.length === 1) return { matched: projects, reason: 'only_project' };

    // Multiple projects, no name match
    return { matched: projects, reason: 'ambiguous_generic' };
}

/**
 * Returns the tenant's stored, customer-facing project identifiers.  A portal
 * listing URL is often shared as its final path segment (for example
 * "SUN-009"), rather than as the full URL.  Keep this deterministic and
 * database-backed: it never guesses identifiers from another tenant.
 */
function projectReferences(project) {
    const refs = [project.name, project.rera_number, project.listing_url]
        .map(v => String(v || '').trim().toLowerCase())
        .filter(Boolean);

    if (project.listing_url) {
        try {
            const url = new URL(project.listing_url);
            const segment = url.pathname.split('/').filter(Boolean).pop();
            const listingId = url.searchParams.get('listing_id') || url.searchParams.get('listingId') || url.searchParams.get('id');
            for (const value of [segment, listingId]) {
                const ref = String(value || '').trim().toLowerCase();
                if (ref && ref.length >= 3) refs.push(ref);
            }
        } catch (_) {
            // A tenant may store an opaque portal listing ID instead of a URL.
        }
    }

    return [...new Set(refs)];
}

/**
 * Attempts a brochure drop for an inbound message.
 *
 * Returns:
 *   { handled: true,  action, projectName, elapsedMs } — message was handled
 *   { handled: false, reason }                          — message not triggered
 */
async function tryBrochureDrop(userId, phone, contactName, text, client, msg, inboundReceivedAt) {
    // 1. Match tenant-scoped project references before rejecting a message.
    // Project names and stored portal/RERA listing identifiers are themselves
    // valid triggers; generic real-estate keywords still use hasTrigger().
    const { matched, reason } = await matchProjects(userId, text);
    const triggered = await hasTrigger(userId, text);
    const hasProjectReference = reason === 'name_match' || reason === 'ambiguous_name';
    if (!triggered && !hasProjectReference) return { handled: false, reason: 'no_trigger' };

    // 2. Ambiguous — ask clarification, send nothing
    if (matched.length !== 1) {
        const projects = await getProjects(userId, { activeOnly: true });
        let clarification;
        if (!projects.length) {
            clarification = "Thanks for your interest! I'd be happy to share property details — could you tell me which project or location you're looking for? 😊";
        } else {
            const names = projects.slice(0, 5).map(p => `• ${p.name} (${p.city || 'N/A'})`).join('\n');
            clarification = `Great to hear from you! We have a few projects — which one interests you?\n\n${names}\n\nJust reply with the project name and I'll send the brochure right away! 🏡`;
        }
        await _sendReply(userId, phone, contactName, clarification, client, msg);
        await logBrochureDropEvent(userId, { phone, contactName, action: 'clarification_sent' });
        return { handled: true, action: 'clarification_sent', reason };
    }

    const project = matched[0];

    // 3. Fetch active assets (brochure first, then walkthrough)
    let assets = await getMediaAssets(userId, project.id, { activeOnly: true });
    const selectedAssetIds = await getSelectedAssetIds(userId, project.id);
    if (selectedAssetIds) assets = assets.filter(asset => selectedAssetIds.has(Number(asset.id)));
    const brochures    = assets.filter(a => a.asset_type === 'brochure');
    const walkthroughs = assets.filter(a => a.asset_type === 'walkthrough');

    if (!brochures.length && !walkthroughs.length) {
        // No assets — graceful reply
        const reply = `Hi${contactName ? ' ' + contactName : ''}! Thanks for your interest in *${project.name}*. 🏡\nOur team will send you detailed brochure shortly. Please stay tuned!`;
        await _sendReply(userId, phone, contactName, reply, client, msg);
        await logBrochureDropEvent(userId, { projectId: project.id, phone, contactName, action: 'no_assets_reply' });
        return { handled: true, action: 'no_assets_reply', projectName: project.name };
    }

    // 5. Send intro text
    const reraLine = project.rera_status === 'verified' && project.rera_number
        ? `\n✅ RERA No: ${project.rera_number}` : '';
    const intro = `Hi${contactName ? ' ' + contactName : ''}! Thanks for your interest in *${project.name}*. 🏡${reraLine}\n\nSending you the brochure now…`;
    await _sendReply(userId, phone, contactName, intro, client, msg);

    const sendAcceptedAt = Date.now();
    const elapsedMs = sendAcceptedAt - (inboundReceivedAt || sendAcceptedAt);

    let sentCount = 0;

    // 6. Send brochure(s) — label RERA verified only if flag is set
    for (const asset of brochures.slice(0, 2)) {  // max 2 brochures
        try {
            const reraLabel = asset.rera_verified ? ' (RERA Verified ✅)' : '';
            await getMessaging().sendMedia(userId, phone, {
                filePath: asset.storage_path,
                mimeType: asset.mime_type,
                caption:  `${project.name} — Brochure${reraLabel}`
            });
            sentCount++;
        } catch (e) {
            console.warn(`   ⚠️ Brochure drop: failed to send brochure asset ${asset.id}:`, e.message?.split('\n')[0]);
        }
    }

    // 7. Send walkthrough(s)
    for (const asset of walkthroughs.slice(0, 1)) {  // max 1 walkthrough
        try {
            await getMessaging().sendMedia(userId, phone, {
                filePath: asset.storage_path,
                mimeType: asset.mime_type,
                caption:  `${project.name} — Virtual Walkthrough`
            });
            sentCount++;
        } catch (e) {
            console.warn(`   ⚠️ Brochure drop: failed to send walkthrough asset ${asset.id}:`, e.message?.split('\n')[0]);
        }
    }

    const action = sentCount > 0 ? 'assets_sent' : 'assets_failed';
    await logBrochureDropEvent(userId, { projectId: project.id, phone, contactName, action, assetCount: sentCount });
    return {
        handled: true,
        action,
        projectName: project.name,
        sentCount,
        elapsedMs
    };
}

/** Send a plain text reply and log it */
async function _sendReply(userId, phone, contactName, text, client, msg) {
    try {
        if (msg && typeof msg.reply === 'function') {
            await msg.reply(text);
        } else if (client) {
            const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
            await client.sendMessage(chatId, text);
        }
        await logMessage(userId, {
            phone, contactName, direction: 'outgoing', messageType: 'text', body: text, status: 'sent'
        });
    } catch (e) {
        console.warn('   ⚠️ Brochure drop: reply send failed (non-fatal):', e.message?.split('\n')[0]);
    }
}

module.exports = { tryBrochureDrop, hasTrigger, matchProjects, DEFAULT_TRIGGERS };
