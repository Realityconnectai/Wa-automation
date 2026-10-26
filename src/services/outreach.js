/**
 * outreach.js — bulk "send this message to N contacts" jobs.
 *
 * Why this isn't just a loop inside the route handler: sending to, say, 150
 * contacts with a human-like delay between each takes on the order of
 * 10-20 minutes. Doing that inside a single request/response cycle would
 * hold the connection open that whole time — the browser, any reverse
 * proxy in front of this (Caddy in production), and Render's own proxy in
 * the free-tier test earlier in this project would all time it out well
 * before it finished. So the route kicks the job off in the background and
 * returns immediately with a job id; the frontend polls for progress.
 *
 * The throttle and hard cap below aren't just politeness — WhatsApp's own
 * terms prohibit bulk/automated messaging, and their detection systems are
 * known to flag or ban numbers for sending many messages to many distinct
 * contacts in a short window, which is exactly the pattern an "outreach"
 * feature produces by definition. This can reduce how obviously
 * bot-shaped the traffic looks; it cannot make bulk outreach risk-free.
 * That risk is real and belongs in the product's UI, not just this
 * comment — see the warning copy wired up on the frontend.
 *
 * Job and recipient state is durable. On startup unfinished jobs are marked
 * interrupted rather than retried automatically: WhatsApp delivery may have
 * succeeded just before a crash, and a blind resend could duplicate a message.
 */

const { sendTextMessage } = require('./whatsapp-client');
const {
    logMessage, getContactByPhone, upsertContact, getMonthlyOutgoingCount,
    markContactOutreached, getUserById, createOutreachJob,
    getOutreachJob: getStoredOutreachJob, countRunningOutreachJobs,
    requestOutreachCancellation, getContactOptOutStatus
} = require('./database');
const { runSql, queryAll } = require('./db-pool');
const { randomUUID } = require('crypto');
const { tryNormalizePhone } = require('../utils/validate');
const { checkAvailabilityNow, logOutreachEvent } = require('./google-calendar');

const MAX_RECIPIENTS_PER_JOB = parseInt(process.env.MAX_OUTREACH_RECIPIENTS_PER_JOB, 10) || 25;
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 9000;
// Global and per-user limits for concurrent outreach jobs across the platform.
const MAX_CONCURRENT_OUTREACH_JOBS = parseInt(process.env.MAX_CONCURRENT_OUTREACH_JOBS, 10) || 5;
const MAX_CONCURRENT_JOBS_PER_USER = parseInt(process.env.MAX_CONCURRENT_OUTREACH_PER_USER, 10) || 1;

let _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function setSleepImplementation(fn) {
    _sleep = fn || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
}

function randomDelay() {
    return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function calculateNextDelay(bufferMinutes, bufferJitter = true) {
    const num = Number(bufferMinutes);
    if (!Number.isFinite(num) || num <= 0) {
        return randomDelay();
    }
    const clampedMinutes = Math.max(1, Math.min(15, num));
    const baseMs = clampedMinutes * 60 * 1000;
    if (!bufferJitter) {
        return baseMs;
    }
    // ±20% jitter
    const minJitter = -0.20;
    const maxJitter = 0.20;
    const factor = 1 + (minJitter + Math.random() * (maxJitter - minJitter));
    const jitteredMs = Math.round(baseMs * factor);
    // Bounds: never below 30s and never above 15 min (900,000ms)
    return Math.max(30000, Math.min(900000, jitteredMs));
}

function serializeSendError(err, phone = '') {
    const rawMsg = String(err?.message || '').trim();
    const rawName = String(err?.name || '').trim();
    const rawCode = String(err?.code || '').trim();
    const rawStack = String(err?.stack || '').trim();

    // 1. Session disconnection
    const isDisconnect = /not connected|disconnected|destroyed|session closed/i.test(rawMsg) ||
                         rawCode === 'WA_NOT_CONNECTED' ||
                         rawCode === 'SESSION_NOT_CONNECTED';
    if (isDisconnect) {
        const reason = 'WhatsApp session disconnected (SESSION_NOT_CONNECTED)';
        return {
            code: 'SESSION_NOT_CONNECTED',
            reason,
            message: reason,
            transient: true
        };
    }

    // 2. Timeout
    if (/timed?\s*out/i.test(rawMsg) || rawCode === 'SEND_TIMEOUT' || rawCode === 'ETIMEDOUT') {
        const reason = 'Send timed out while waiting for WhatsApp confirmation (SEND_TIMEOUT)';
        return {
            code: 'SEND_TIMEOUT',
            reason,
            message: reason,
            transient: true
        };
    }

    // 3. Media asset unavailable
    if (/media file missing|file not found|media empty|asset.*unavailable/i.test(rawMsg) ||
        rawCode === 'MEDIA_FILE_NOT_FOUND' || rawCode === 'MEDIA_EMPTY' || rawCode === 'ASSET_UNAVAILABLE') {
        const reason = 'Media asset file unavailable on server (ASSET_UNAVAILABLE)';
        return {
            code: 'ASSET_UNAVAILABLE',
            reason,
            message: reason,
            transient: false
        };
    }

    // 4. Recipient not registered on WhatsApp
    if (/not registered on WhatsApp|not on WhatsApp/i.test(rawMsg) || rawCode === 'RECIPIENT_NOT_ON_WHATSAPP') {
        const reason = 'Recipient is not registered on WhatsApp (RECIPIENT_NOT_ON_WHATSAPP)';
        return {
            code: 'RECIPIENT_NOT_ON_WHATSAPP',
            reason,
            message: reason,
            transient: false
        };
    }

    // 5. Minified WhatsApp Web "t" or "t: t" or unresolvable identifier
    const isMinifiedOrLidError = /^(evaluation failed:\s*)?t(\s*:\s*t)?$/i.test(rawMsg) ||
                                rawMsg === 't' ||
                                rawName === 't' ||
                                /No LID for user|chat not found|wid error|invalid wid/i.test(rawMsg);
    if (isMinifiedOrLidError) {
        const reason = 'Recipient identifier could not be resolved on WhatsApp (RECIPIENT_UNRESOLVABLE)';
        return {
            code: 'RECIPIENT_UNRESOLVABLE',
            reason,
            message: reason,
            transient: false
        };
    }

    // 6. Generic meaningful fallback
    let meaningfulMsg = rawMsg;
    if (!meaningfulMsg || meaningfulMsg === 't' || meaningfulMsg === 't: t' || meaningfulMsg.length <= 1) {
        const firstLine = rawStack.split('\n')[0].replace(/^Error:\s*/, '').trim();
        if (firstLine && firstLine !== 't' && firstLine !== 't: t') {
            meaningfulMsg = firstLine;
        } else if (rawName && rawName !== 't' && rawName !== 'Error') {
            meaningfulMsg = rawName;
        } else {
            meaningfulMsg = 'WhatsApp message dispatch rejected by client';
        }
    }

    const code = rawCode && rawCode !== 't' ? rawCode : 'UNKNOWN_SEND_ERROR';
    const refId = randomUUID().slice(0, 8);
    const reason = `[${code}] ${meaningfulMsg} (ref: ${refId})`.slice(0, 200);
    return {
        code,
        reason,
        message: meaningfulMsg,
        transient: true
    };
}

function renderTemplate(template, contact) {
    if (!template) return '';
    const rawName = contact?.name !== undefined && contact?.name !== null ? String(contact.name).trim() : '';
    const name = rawName || 'there';
    const firstName = name.split(/\s+/)[0] || 'there';
    return String(template)
        .replace(/\{\{\s*name\s*\}\}/gi, name)
        .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
        .replace(/\{\{\s*phone\s*\}\}/gi, contact?.phone || '');
}

async function interruptibleDelay(delayMs, userId, jobId, nextRecipientId) {
    const start = Date.now();
    const nextSendAt = new Date(start + delayMs);
    await runSql(
        "UPDATE outreach_jobs SET next_send_at = $1 WHERE id = $2 AND user_id = $3",
        [nextSendAt, jobId, userId]
    ).catch(() => {});
    if (nextRecipientId) {
        await runSql(
            "UPDATE outreach_recipients SET next_send_at = $1 WHERE id = $2 AND user_id = $3",
            [nextSendAt, nextRecipientId, userId]
        ).catch(() => {});
    }

    const checkIntervalMs = 1000;
    let elapsed = 0;
    while (elapsed < delayMs) {
        const step = Math.min(checkIntervalMs, delayMs - elapsed);
        await _sleep(step);
        elapsed = Date.now() - start;

        const fresh = await getStoredOutreachJob(userId, jobId);
        if (!fresh || fresh.status === 'cancel_requested') {
            await runSql(
                "UPDATE outreach_recipients SET status = 'cancelled', reason = 'Cancelled before sending', next_send_at = NULL WHERE job_id = $1 AND user_id = $2 AND status IN ('pending', 'sending')",
                [jobId, userId]
            );
            await runSql(
                "UPDATE outreach_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, next_send_at = NULL WHERE id = $1 AND user_id = $2",
                [jobId, userId]
            );
            return false;
        }
    }

    await runSql(
        "UPDATE outreach_jobs SET next_send_at = NULL WHERE id = $1 AND user_id = $2",
        [jobId, userId]
    ).catch(() => {});
    return true;
}

/**
 * Starts a bulk-send job for one user against a list of contacts. Returns
 * the job immediately (status 'running', nothing sent yet) — the actual
 * sending happens afterward, off the caller's stack. Poll
 * getOutreachJob(jobId) for progress.
 */
async function startOutreachJob(user, contacts, messageTemplate, mediaAssetId = null, options = {}) {
    if (contacts.length > MAX_RECIPIENTS_PER_JOB) {
        const err = new Error(`Outreach is capped at ${MAX_RECIPIENTS_PER_JOB} recipients per send — you selected ${contacts.length}. Split into smaller batches.`);
        err.status = 400;
        throw err;
    }
    if (await countRunningOutreachJobs() >= MAX_CONCURRENT_OUTREACH_JOBS) {
        const err = new Error('The server is currently at capacity for concurrent outreach campaigns. Please wait a few moments.');
        err.status = 503;
        throw err;
    }
    if (await countRunningOutreachJobs(user.id) >= MAX_CONCURRENT_JOBS_PER_USER) {
        const err = new Error('You already have an outreach send in progress. Wait for it to finish, or cancel it first.');
        err.status = 409;
        throw err;
    }

    let bufferMinutes = 0;
    if (options.bufferMinutes !== undefined && options.bufferMinutes !== null && options.bufferMinutes !== '') {
        const parsed = Number(options.bufferMinutes);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 15) {
            const err = new Error('Delay between messages must be an integer between 0 and 15 minutes.');
            err.status = 400;
            throw err;
        }
        bufferMinutes = parsed;
    }
    const bufferJitter = options.bufferJitter !== false;

    const job = await createOutreachJob(user.id, randomUUID(), messageTemplate, contacts, mediaAssetId, { bufferMinutes, bufferJitter });

    // Deliberately not awaited. The rejection handler matters: an unhandled
    // rejection here would, given server.js's process.exit(1) policy, take
    // down every tenant because one send loop threw.
    runJob(job, user).catch(async err => {
        await runSql("UPDATE outreach_jobs SET status='interrupted', finished_at=CURRENT_TIMESTAMP, error=$1 WHERE id=$2 AND user_id=$3", ['The send stopped unexpectedly. Some messages may not have been sent.', job.id, user.id]).catch(() => {});
        console.error(`❌ Outreach job ${job.id} crashed:`, err.message);
    });
    return job;
}

async function runJob(jobOrId, maybeUser = null) {
    let job = typeof jobOrId === 'object' && jobOrId !== null ? jobOrId : { id: jobOrId };
    let user = maybeUser;
    if (!user || !user.id) {
        const { queryGet } = require('./db-pool');
        const jobRow = await queryGet('SELECT * FROM outreach_jobs WHERE id = $1', [job.id]);
        if (jobRow) {
            job = jobRow;
            user = await getUserById(jobRow.user_id);
        }
    }
    const messageTemplate = job.message_template || job.template || '';
    const bufferMinutes = Number(job.buffer_minutes || 0);
    const bufferJitter = job.buffer_jitter !== false;

    const recipients = await queryAll("SELECT * FROM outreach_recipients WHERE job_id=$1 AND user_id=$2 AND status='pending' ORDER BY id", [job.id, user.id]);
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const nextRecipient = i + 1 < recipients.length ? recipients[i + 1] : null;

        const freshJob = await getStoredOutreachJob(user.id, job.id);
        if (!freshJob || freshJob.status === 'cancel_requested') {
            await runSql("UPDATE outreach_recipients SET status='cancelled', reason='Cancelled before sending', next_send_at=NULL WHERE job_id=$1 AND user_id=$2 AND status IN ('pending', 'sending')", [job.id, user.id]);
            await runSql("UPDATE outreach_jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP, next_send_at=NULL WHERE id=$1 AND user_id=$2", [job.id, user.id]);
            return;
        }
        const contact = { id: recipient.contact_id, phone: recipient.phone, name: recipient.contact_name };
        await runSql("UPDATE outreach_recipients SET status='sending', next_send_at=NULL WHERE id=$1 AND user_id=$2 AND status='pending'", [recipient.id, user.id]);

        // Re-read the account each iteration.
        const fresh = await getUserById(user.id);
        if (!fresh || fresh.status !== 'active') {
            await runSql("UPDATE outreach_recipients SET status='cancelled', reason='Account is no longer active', next_send_at=NULL WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id, user.id]);
            await runSql("UPDATE outreach_jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP, next_send_at=NULL WHERE id=$1 AND user_id=$2", [job.id, user.id]);
            return;
        }

        // Plan message-limit check
        if (fresh.message_limit && (await getMonthlyOutgoingCount(fresh.id)) >= fresh.message_limit) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Monthly message limit reached', next_send_at=NULL WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id, user.id]);
            break;
        }

        // Optional per-user calendar check
        const availability = await checkAvailabilityNow(fresh.id);
        if (availability.busy) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Google Calendar shows you as busy', next_send_at=NULL WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
            continue; // Skipped rows do not consume buffer
        }

        const phone = tryNormalizePhone(contact.phone);
        if (!phone) {
            await runSql("UPDATE outreach_recipients SET status='failed', reason='Not a valid phone number', next_send_at=NULL WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
            if (nextRecipient) {
                const delayMs = calculateNextDelay(bufferMinutes, bufferJitter);
                const ok = await interruptibleDelay(delayMs, user.id, job.id, nextRecipient.id);
                if (!ok) return;
            }
            continue;
        }

        // Enforce opt-out suppression
        const optOutStatus = await getContactOptOutStatus(fresh.id, phone);
        if (optOutStatus && optOutStatus.is_opted_out) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Contact has opted out', next_send_at=NULL WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
            continue; // Skipped rows do not consume buffer
        }

        const personalized = renderTemplate(messageTemplate, contact);
        try {
            let mediaAsset = null;
            if (job.media_asset_id) {
                const { getMediaAssetById } = require('./database');
                mediaAsset = await getMediaAssetById(fresh.id, job.media_asset_id);
            }

            if (mediaAsset) {
                const fs = require('fs');
                const hasBytes = (mediaAsset.data && mediaAsset.data.length > 0) || (mediaAsset.storage_path && fs.existsSync(mediaAsset.storage_path));
                if (!mediaAsset.is_active || !hasBytes) {
                    await runSql("UPDATE outreach_recipients SET status='failed', reason='Media file missing on server', next_send_at=NULL WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
                    if (nextRecipient) {
                        const delayMs = calculateNextDelay(bufferMinutes, bufferJitter);
                        const ok = await interruptibleDelay(delayMs, user.id, job.id, nextRecipient.id);
                        if (!ok) return;
                    }
                    continue;
                }
                const { sendMedia } = require('./messaging');
                const idempotencyKey = `outreach-${job.id}-${recipient.id}`;
                await sendMedia(fresh.id, phone, {
                    filePath: mediaAsset.storage_path,
                    mimeType: mediaAsset.mime_type,
                    fileName: mediaAsset.display_name || mediaAsset.file_name,
                    caption: personalized,
                    idempotencyKey,
                    mediaAssetId: mediaAsset.id
                });
            } else {
                const whatsappClient = require('./whatsapp-client');
                const sender = whatsappClient.sendText || whatsappClient.sendTextMessage || sendTextMessage;
                const result = await sender(fresh.id, phone, personalized);
                await logMessage(fresh.id, {
                    waMessageId: result?.id?._serialized || result?.messageId || null,
                    phone,
                    contactName: contact.name || '',
                    direction: 'outgoing',
                    messageType: 'text',
                    body: personalized,
                    status: 'sent'
                });
            }

            if (!(await getContactByPhone(fresh.id, phone))) await upsertContact(fresh.id, phone, contact.name);
            await markContactOutreached(fresh.id, phone);
            await runSql("UPDATE outreach_recipients SET status='sent', sent_at=CURRENT_TIMESTAMP, next_send_at=NULL WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
            logOutreachEvent(fresh.id, { phone, name: contact.name, message: personalized }).catch?.(() => {});
        } catch (err) {
            const serialized = serializeSendError(err, phone);
            await runSql("UPDATE outreach_recipients SET status='failed', reason=$1, next_send_at=NULL WHERE id=$2 AND user_id=$3", [serialized.reason, recipient.id, user.id]);

            if (serialized.code === 'SESSION_NOT_CONNECTED') {
                const whatsappClient = require('./whatsapp-client');
                let reconnected = false;
                for (let retry = 0; retry < 15; retry++) {
                    await _sleep(2000);
                    const st = whatsappClient.getStatus(user.id);
                    if (st && st.connected) {
                        reconnected = true;
                        break;
                    }
                }
                if (!reconnected) {
                    await runSql("UPDATE outreach_recipients SET status='failed', reason='Stopped: WhatsApp is disconnected (SESSION_NOT_CONNECTED)', next_send_at=NULL WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id, user.id]);
                    break;
                }
            }
        }

        // Wait buffer delay before next message (unless this is the last recipient)
        if (nextRecipient) {
            const delayMs = calculateNextDelay(bufferMinutes, bufferJitter);
            const ok = await interruptibleDelay(delayMs, user.id, job.id, nextRecipient.id);
            if (!ok) return; // Cancelled during wait
        }
    }

    // Honest status derivation invariant
    const counts = await queryAll(
        "SELECT status, COUNT(*)::int AS count FROM outreach_recipients WHERE job_id = $1 AND user_id = $2 GROUP BY status",
        [job.id, user.id]
    );
    const summary = counts.reduce((acc, row) => { acc[row.status] = Number(row.count); return acc; }, {});
    const sentCount = summary.sent || 0;
    const failedCount = summary.failed || 0;
    const skippedCount = (summary.skipped || 0) + (summary.unknown || 0) + (summary.cancelled || 0);

    let finalStatus = 'completed';
    if (sentCount === 0 && failedCount > 0) {
        finalStatus = 'failed';
    } else if (failedCount > 0) {
        finalStatus = 'completed_with_errors';
    } else if (sentCount === 0 && skippedCount > 0) {
        finalStatus = 'cancelled';
    }

    await runSql(`UPDATE outreach_jobs
                  SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE $1 END,
                      finished_at=CURRENT_TIMESTAMP,
                      next_send_at=NULL
                  WHERE id=$2 AND user_id=$3 AND status IN ('running','cancel_requested')`, [finalStatus, job.id, user.id]);
}

/**
 * Returns a job only to the account that owns it.
 */
function getOutreachJob(arg1, arg2) {
    const userId = typeof arg1 === 'number' ? arg1 : arg2;
    const jobId = typeof arg1 === 'number' ? arg2 : arg1;
    return getStoredOutreachJob(userId, jobId);
}

async function createOutreachJobService(userId, arg2, maybeTemplate, maybeContacts, maybeMediaAssetId, maybeOptions = {}) {
    if (typeof arg2 === 'object' && arg2 !== null && !Array.isArray(arg2)) {
        const { getContactsByIds } = require('./database');
        const template = arg2.messageTemplate || '';
        const contacts = await getContactsByIds(userId, arg2.contactIds || []);
        const mediaAssetId = arg2.mediaAssetId || null;
        const jobId = randomUUID();
        const bufferMinutes = arg2.bufferMinutes || 0;
        const bufferJitter = arg2.bufferJitter !== false;
        return createOutreachJob(userId, jobId, template, contacts, mediaAssetId, { bufferMinutes, bufferJitter });
    }
    return createOutreachJob(userId, arg2, maybeTemplate, maybeContacts, maybeMediaAssetId, maybeOptions);
}

function cancelOutreachJob(jobId, userId) {
    return requestOutreachCancellation(userId, jobId);
}

/** Test/shutdown helper: request cancellation of everything in flight. */
async function cancelAllOutreachJobs() {
    return (await runSql("UPDATE outreach_jobs SET status='cancel_requested' WHERE status='running'", [])).changes;
}

async function getOutreachRecipients(userId, jobId) {
    return queryAll(
        `SELECT id, job_id, user_id, contact_id, phone, contact_name, status, reason, reason AS error_message, sent_at, next_send_at
         FROM outreach_recipients
         WHERE user_id = $1 AND job_id = $2
         ORDER BY id ASC`,
        [userId, jobId]
    );
}

async function getOutreachJobs(userId, opts = {}) {
    const { getOutreachJobs: dbGetOutreachJobs } = require('./database');
    return dbGetOutreachJobs(userId, opts);
}

async function retryFailedOutreachRecipients(userId, jobId) {
    const uid = Number(userId);
    const jid = String(jobId);
    const job = await getStoredOutreachJob(uid, jid);
    if (!job) {
        const err = new Error('Campaign not found');
        err.status = 404;
        throw err;
    }
    const failedRecipients = await queryAll(
        "SELECT id, phone, contact_id, contact_name FROM outreach_recipients WHERE job_id = $1 AND user_id = $2 AND status = 'failed' ORDER BY id ASC",
        [jid, uid]
    );
    if (failedRecipients.length === 0) {
        return { retried: 0, message: 'No failed recipients to retry', total: job.total };
    }

    await runSql(
        "UPDATE outreach_recipients SET status = 'pending', reason = '', next_send_at = NULL WHERE job_id = $1 AND user_id = $2 AND status = 'failed'",
        [jid, uid]
    );
    await runSql(
        "UPDATE outreach_jobs SET status = 'running', finished_at = NULL, error = '' WHERE id = $1 AND user_id = $2",
        [jid, uid]
    );

    const user = await getUserById(uid);
    runJob(job, user).catch(async err => {
        await runSql("UPDATE outreach_jobs SET status='interrupted', finished_at=CURRENT_TIMESTAMP, error=$1 WHERE id=$2 AND user_id=$3", ['The retry send stopped unexpectedly.', jid, uid]).catch(() => {});
        console.error(`❌ Retry outreach job ${jid} crashed:`, err.message);
    });

    return { retried: failedRecipients.length, jobId: jid, total: job.total };
}

async function reclaimInterruptedOutreachJobs() {
    const reclaimedRecipients = await runSql(
        "UPDATE outreach_recipients SET status = 'pending', next_send_at = NULL WHERE status = 'sending'",
        []
    );
    const interruptedJobs = await runSql(
        "UPDATE outreach_jobs SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP, next_send_at = NULL WHERE status IN ('running', 'cancel_requested')",
        []
    );
    return {
        reclaimedRecipients: reclaimedRecipients.changes || 0,
        interruptedJobs: interruptedJobs.changes || 0
    };
}

module.exports = {
    startOutreachJob,
    createOutreachJob: createOutreachJobService,
    runJob,
    getOutreachJob,
    getOutreachJobs,
    getOutreachRecipients,
    retryFailedOutreachRecipients,
    cancelOutreachJob,
    cancelAllOutreachJobs,
    reclaimInterruptedOutreachJobs,
    renderTemplate,
    calculateNextDelay,
    serializeSendError,
    setSleepImplementation,
    MAX_RECIPIENTS_PER_JOB,
    MIN_DELAY_MS,
    MAX_DELAY_MS
};




