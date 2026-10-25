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
function randomDelay() {
    return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
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

/**
 * Starts a bulk-send job for one user against a list of contacts. Returns
 * the job immediately (status 'running', nothing sent yet) — the actual
 * sending happens afterward, off the caller's stack. Poll
 * getOutreachJob(jobId) for progress.
 */
async function startOutreachJob(user, contacts, messageTemplate, mediaAssetId = null) {
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

    const job = await createOutreachJob(user.id, randomUUID(), messageTemplate, contacts, mediaAssetId);

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
    const recipients = await queryAll("SELECT * FROM outreach_recipients WHERE job_id=$1 AND user_id=$2 AND status='pending' ORDER BY id", [job.id, user.id]);
    for (const recipient of recipients) {
        const freshJob = await getStoredOutreachJob(user.id, job.id);
        if (!freshJob || freshJob.status === 'cancel_requested') {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Cancelled before sending' WHERE job_id=$1 AND user_id=$2 AND status='pending'", [job.id,user.id]);
            await runSql("UPDATE outreach_jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2", [job.id,user.id]);
            return;
        }
        const contact = { id: recipient.contact_id, phone: recipient.phone, name: recipient.contact_name };
        await runSql("UPDATE outreach_recipients SET status='sending' WHERE id=$1 AND user_id=$2 AND status='pending'", [recipient.id,user.id]);

        // Re-read the account each iteration. A job can run for 20 minutes,
        // during which an admin may suspend the account — continuing to send
        // on behalf of a suspended tenant is exactly what suspension is
        // supposed to stop.
        const fresh = await getUserById(user.id);
        if (!fresh || fresh.status !== 'active') {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Account is no longer active' WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id,user.id]);
            await runSql("UPDATE outreach_jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2", [job.id,user.id]);
            return;
        }

        // Plan message-limit check, re-evaluated per send since it can change
        // mid-job — same rule /messages/send enforces.
        if (fresh.message_limit && (await getMonthlyOutgoingCount(fresh.id)) >= fresh.message_limit) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Monthly message limit reached' WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id,user.id]);
            break;
        }

        // Optional per-user setting (routes/calendar.js): skip this contact
        // rather than send while the owner's own Google Calendar shows them
        // busy right now. checkAvailabilityNow fails open (busy: false) on
        // any error or if the feature isn't connected, so a Calendar API
        // hiccup can never silently stall a whole outreach job.
        const availability = await checkAvailabilityNow(fresh.id);
        if (availability.busy) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Google Calendar shows you as busy' WHERE id=$1 AND user_id=$2", [recipient.id,user.id]);
            continue;
        }

        // The contact rows come from our own database, but they may predate
        // phone validation (see migration 4), so normalise rather than trust.
        const phone = tryNormalizePhone(contact.phone);
        if (!phone) {
            await runSql("UPDATE outreach_recipients SET status='failed', reason='Not a valid phone number' WHERE id=$1 AND user_id=$2", [recipient.id,user.id]);
            continue;
        }

        // Enforce opt-out suppression: skip any contact who has opted out
        const optOutStatus = await getContactOptOutStatus(fresh.id, phone);
        if (optOutStatus && optOutStatus.is_opted_out) {
            await runSql("UPDATE outreach_recipients SET status='skipped', reason='Contact has opted out' WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
            continue;
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
                if (!mediaAsset.is_active || !fs.existsSync(mediaAsset.storage_path)) {
                    await runSql("UPDATE outreach_recipients SET status='failed', reason='Media file missing on server' WHERE id=$1 AND user_id=$2", [recipient.id, user.id]);
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
            await runSql("UPDATE outreach_recipients SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2", [recipient.id,user.id]);
            logOutreachEvent(fresh.id, { phone, name: contact.name, message: personalized }).catch?.(() => {});
        } catch (err) {
            const isDisconnect = /not connected/i.test(err?.message || '') || err?.code === 'WA_NOT_CONNECTED';
            let detail = err?.message;
            if (!detail || detail === 't' || detail.length <= 1) {
                if (err?.code) {
                    detail = err.code;
                } else if (err?.stack) {
                    const firstLine = err.stack.split('\n')[0].trim();
                    detail = (firstLine && firstLine !== 'Error: t') ? firstLine : (err?.name || String(err));
                } else {
                    detail = String(err || 'Unknown dispatch error');
                }
            }
            const failReason = isDisconnect ? 'WhatsApp disconnected' : `Send failed: ${detail}`.slice(0, 200);
            await runSql("UPDATE outreach_recipients SET status='failed', reason=$1 WHERE id=$2 AND user_id=$3", [failReason, recipient.id, user.id]);
            if (isDisconnect) {
                await runSql("UPDATE outreach_recipients SET status='skipped', reason='Stopped: WhatsApp is disconnected' WHERE job_id=$1 AND user_id=$2 AND status IN ('pending','sending')", [job.id, user.id]);
                break;
            }
        }

        // Skip the delay after the very last send — nothing left to wait for.
        if (recipient !== recipients[recipients.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, randomDelay()));
        }
    }
    await runSql(`UPDATE outreach_jobs
                  SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'completed' END,
                      finished_at=CURRENT_TIMESTAMP
                  WHERE id=$1 AND user_id=$2 AND status IN ('running','cancel_requested')`, [job.id,user.id]);
}

/**
 * Returns a job only to the account that owns it.
 *
 * The ownership check is the authorization boundary for this resource: job
 * ids are short and sequential, so without it any tenant could read another
 * tenant's recipient phone numbers by guessing.
 */
function getOutreachJob(arg1, arg2) {
    const userId = typeof arg1 === 'number' ? arg1 : arg2;
    const jobId = typeof arg1 === 'number' ? arg2 : arg1;
    return getStoredOutreachJob(userId, jobId);
}

async function createOutreachJobService(userId, arg2, maybeTemplate, maybeContacts, maybeMediaAssetId) {
    if (typeof arg2 === 'object' && arg2 !== null && !Array.isArray(arg2)) {
        const { getContactsByIds } = require('./database');
        const template = arg2.messageTemplate || '';
        const contacts = await getContactsByIds(userId, arg2.contactIds || []);
        const mediaAssetId = arg2.mediaAssetId || null;
        const jobId = randomUUID();
        return createOutreachJob(userId, jobId, template, contacts, mediaAssetId);
    }
    return createOutreachJob(userId, arg2, maybeTemplate, maybeContacts, maybeMediaAssetId);
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
        `SELECT id, job_id, user_id, contact_id, phone, contact_name, status, reason, reason AS error_message, sent_at
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

module.exports = {
    startOutreachJob,
    createOutreachJob: createOutreachJobService,
    runJob,
    getOutreachJob,
    getOutreachJobs,
    getOutreachRecipients,
    cancelOutreachJob,
    cancelAllOutreachJobs,
    renderTemplate,
    MAX_RECIPIENTS_PER_JOB,
    MIN_DELAY_MS,
    MAX_DELAY_MS
};




