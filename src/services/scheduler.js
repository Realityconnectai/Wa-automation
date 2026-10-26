/**
 * scheduler.js — dispatches due scheduled messages.
 *
 * The correctness problem here is duplicate delivery, and it is not
 * hypothetical. The previous implementation guarded with an in-process
 * boolean:
 *
 *     let isRunning = false;
 *     if (isRunning) return;
 *
 * That holds for exactly one process. Two instances behind a load balancer,
 * a rolling deploy where old and new overlap for a few seconds, or a
 * launcher restart while a tick is mid-flight, and both readers see the same
 * `status = 'pending'` row and both send it. The customer receives the same
 * message twice and WhatsApp's spam detection notices — which for this
 * product means the tenant's number gets flagged.
 *
 * So claiming a job is an atomic database operation
 * (database.claimScheduledMessage: UPDATE … WHERE id = ? AND status =
 * 'pending'), and only the caller that observes changes === 1 sends. SQLite
 * serialises the UPDATE, so the guarantee holds across processes, not just
 * within one.
 *
 * The in-process flag is kept as well, but only as an efficiency measure so
 * a slow tick doesn't pile up work — it is no longer load-bearing for
 * correctness.
 */
const cron = require('node-cron');
const {
    getPendingScheduledMessages, updateScheduledMessageStatus, logMessage,
    claimScheduledMessage, reclaimStuckScheduledMessages, getUserById,
    getMonthlyOutgoingCount, expireStaleHolds, getAppointmentById, listUsers,
    getContactOptOutStatus, isConversationAiPaused
} = require('./database');
const whatsappClient = require('./whatsapp-client');
const { tryNormalizePhone } = require('../utils/validate');
const { logOutreachEvent } = require('./google-calendar');
const { checkAndEscalateOverdueSlas } = require('./lead-assignment');

let schedulerTask = null;
let isRunning = false;

// Bound on how many jobs one tick will process. With a 1.2s anti-spam delay
// between sends, 40 jobs is already ~50 seconds — about one tick's worth.
// Anything beyond that waits for the next tick rather than letting one
// backlog monopolise the loop.
const MAX_JOBS_PER_TICK = 40;
const SEND_TIMEOUT_MS = 20000;
const INTER_SEND_DELAY_MS = 1200;

// ─── Initialize the scheduler ────────────────────────────────
async function initScheduler() {
    // On boot, deal with anything left in 'sending' by a process that died
    // mid-send. These are marked failed rather than retried: we cannot know
    // whether WhatsApp accepted the message before the crash, and re-sending
    // something the recipient already got is worse than surfacing a failure.
    try {
        const stuck = await reclaimStuckScheduledMessages(15);
        if (stuck.length) {
            console.warn(`⚠️ Scheduler: ${stuck.length} scheduled message(s) were interrupted mid-send and marked failed (delivery unconfirmed).`);
        }
    } catch (e) {
        console.error('❌ Scheduler: could not reclaim interrupted jobs:', e.message);
    }

    // Run every minute — the outer try/catch ensures a cron error never crashes the process
    schedulerTask = cron.schedule('* * * * *', async () => {
        try {
            await processPendingMessages();
            // Expire stale unit holds (all tenants) on every tick — idempotent
            const expired = await expireStaleHolds(null);
            if (expired > 0) console.log(`🔓 Scheduler: reverted ${expired} expired unit hold(s) to VACANT`);

            // Check SLA breaches and escalate for all tenants
            try {
                const users = await listUsers();
                for (const u of (users || [])) {
                    if (u.status === 'active') {
                        await checkAndEscalateOverdueSlas(u.id);
                    }
                }
            } catch (slaErr) {
                console.error('❌ Scheduler SLA escalation error (non-fatal):', slaErr.message);
            }
        } catch (err) {
            console.error('❌ Scheduler tick error (non-fatal):', err.message);
        }
    });

    console.log('⏰ Scheduler: checking for pending messages every minute');
}

// ─── Process all due scheduled messages ─────────────────────
async function processPendingMessages() {
    // Skip if a previous run is still in-flight (e.g. slow network).
    if (isRunning) return { skipped: true };
    isRunning = true;

    const summary = { claimed: 0, sent: 0, failed: 0, lost: 0 };

    try {
        let pending = [];
        try {
            pending = await getPendingScheduledMessages();
        } catch (dbErr) {
            console.error('❌ Scheduler: failed to query pending messages:', dbErr.message);
            return summary;
        }

        if (pending.length === 0) return summary;

        const batch = pending.slice(0, MAX_JOBS_PER_TICK);
        console.log(`⏰ Processing ${batch.length} of ${pending.length} due scheduled message(s)...`);

        for (const msg of batch) {
            // Atomic claim — this is the line that prevents double sends.
            let claimed = false;
            try {
                claimed = await claimScheduledMessage(msg.id);
            } catch (claimErr) {
                console.error(`❌ Scheduler: could not claim #${msg.id}:`, claimErr.message);
                continue;
            }
            if (!claimed) {
                // Someone else (another instance, or a cancel from the API)
                // got there first. Not an error.
                summary.lost++;
                continue;
            }
            summary.claimed++;

            try {
                // A suspended or deleted account must not keep sending.
                const owner = await getUserById(msg.user_id);
                if (!owner) {
                    await updateScheduledMessageStatus(msg.id, 'cancelled', 'Account no longer exists');
                    continue;
                }
                if (owner.status !== 'active') {
                    await updateScheduledMessageStatus(msg.id, 'cancelled', `Account is not active (${owner.status})`);
                    continue;
                }
                if (owner.role !== 'admin' && !owner.wa_enabled) {
                    await updateScheduledMessageStatus(msg.id, 'cancelled', 'WhatsApp access is disabled for this account');
                    continue;
                }
                if (owner.message_limit && (await getMonthlyOutgoingCount(owner.id)) >= owner.message_limit) {
                    await updateScheduledMessageStatus(msg.id, 'failed', `Monthly message limit reached (${owner.message_limit})`);
                    continue;
                }

                // If message is linked to an appointment, verify the appointment is still confirmed
                if (msg.appointment_id) {
                    const appt = await getAppointmentById(msg.user_id, msg.appointment_id);
                    if (!appt || appt.status !== 'confirmed') {
                        await updateScheduledMessageStatus(msg.id, 'cancelled', 'Appointment is no longer active or was cancelled');
                        continue;
                    }
                }

                const phone = tryNormalizePhone(msg.phone);
                if (!phone) {
                    await updateScheduledMessageStatus(msg.id, 'failed', 'Stored phone number is not valid');
                    summary.failed++;
                    continue;
                }

                // Check opt-out state immediately before dispatch
                try {
                    const optOut = await getContactOptOutStatus(msg.user_id, phone);
                    if (optOut && optOut.is_opted_out) {
                        await updateScheduledMessageStatus(msg.id, 'cancelled', `Contact opted out (${optOut.opt_out_reason || 'Opted out'})`);
                        summary.cancelled = (summary.cancelled || 0) + 1;
                        continue;
                    }
                } catch (optErr) {
                    // Fail closed: do not send if eligibility cannot be established
                    await updateScheduledMessageStatus(msg.id, 'failed', `Safety check error: unable to establish opt-out status (${optErr.message})`);
                    summary.failed++;
                    continue;
                }

                // Check AI-pause / Human Takeover state where message is subject to takeover suppression
                try {
                    const isPaused = await isConversationAiPaused(msg.user_id, phone);
                    if (isPaused) {
                        await updateScheduledMessageStatus(msg.id, 'cancelled', 'Conversation AI paused (Human agent takeover active)');
                        summary.cancelled = (summary.cancelled || 0) + 1;
                        continue;
                    }
                } catch (pauseErr) {
                    // Fail closed: do not send if eligibility cannot be established
                    await updateScheduledMessageStatus(msg.id, 'failed', `Safety check error: unable to check AI pause status (${pauseErr.message})`);
                    summary.failed++;
                    continue;
                }

                // Timeout guard: don't let a single message block the tick.
                const result = await Promise.race([
                    whatsappClient.sendTextMessage(msg.user_id, phone, msg.body),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('sendTextMessage timeout')), SEND_TIMEOUT_MS))
                ]);

                // Mark sent BEFORE logging. If the process dies between the
                // two, the worst outcome is a delivered message missing from
                // the log — annoying. The other order risks a delivered
                // message still marked 'sending', which a later reclaim
                // reports as failed and a human may then re-send.
                const waMsgId = result?.id?._serialized || result?.messageId || (typeof result === 'string' ? result : null);
                await updateScheduledMessageStatus(msg.id, 'sent', null, waMsgId);
                summary.sent++;

                try {
                    await logMessage(msg.user_id, {
                        waMessageId: waMsgId,
                        phone,
                        direction: 'outgoing',
                        messageType: 'text',
                        body: msg.body,
                        status: 'sent'
                    });
                } catch (logErr) {
                    console.warn('⚠️ Could not log scheduled message (non-fatal):', logErr.message);
                }

                console.log(`✅ Scheduled message #${msg.id} sent (waMessageId: ${waMsgId})`);
                // Best-effort; a calendar-import-created scheduled message
                // (see google-calendar.js) logging back to the same calendar
                // it came from is harmless — it's tagged so a resync never
                // re-imports it as a new send.
                await logOutreachEvent(msg.user_id, { phone, name: '', message: msg.body });
            } catch (error) {
                const isTimeout = error.message === 'sendTextMessage timeout';
                if (isTimeout) {
                    // A Promise.race timeout does NOT cancel the underlying send.
                    // The message may still be delivered seconds later. Marking
                    // it 'failed' would be wrong — the UI would show "send failed"
                    // for a message the recipient already received, and an operator
                    // retry would cause a duplicate. 'unknown' means "sent but
                    // delivery not confirmed — do not resend without checking."
                    summary.failed++;
                    console.warn(`⏱️ Scheduled message #${msg.id} timed out — delivery unknown, will not auto-retry`);
                    try {
                        await updateScheduledMessageStatus(msg.id, 'unknown',
                            'Send timed out — message may or may not have been delivered. Check with the recipient before retrying.');
                    } catch (dbErr) {
                        console.error('❌ Could not update unknown status:', dbErr.message);
                    }
                } else {
                    summary.failed++;
                    console.error(`❌ Scheduled message #${msg.id} failed:`, error.message);
                    try {
                        let reason = /not connected/i.test(error.message)
                            ? 'WhatsApp was not connected at the scheduled time'
                            : (/not registered on WhatsApp/i.test(error.message)
                                ? 'Recipient not registered on WhatsApp'
                                : (/^(evaluation failed:\s*)?t(\s*:\s*t)?$/i.test(error.message) || error.message === 't'
                                    ? 'Recipient identifier unresolvable on WhatsApp'
                                    : String(error.message).split('\n')[0].slice(0, 300)));
                        await updateScheduledMessageStatus(msg.id, 'failed', reason);
                    } catch (dbErr) {
                        console.error('❌ Could not update failed status:', dbErr.message);
                    }
                }
            }

            // Anti-spam delay between messages.
            await new Promise(resolve => setTimeout(resolve, INTER_SEND_DELAY_MS));
        }
    } finally {
        // finally, not a trailing assignment: an unexpected throw anywhere
        // above would otherwise leave isRunning true forever and silently
        // stop the scheduler for the life of the process.
        isRunning = false;
    }

    return summary;
}

// ─── Stop the scheduler ──────────────────────────────────────
function stopScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        console.log('⏰ Scheduler stopped');
    }
}

/** True while a tick is in flight — used by graceful shutdown to wait. */
function isSchedulerBusy() {
    return isRunning;
}

module.exports = { initScheduler, stopScheduler, processPendingMessages, isSchedulerBusy, MAX_JOBS_PER_TICK };


