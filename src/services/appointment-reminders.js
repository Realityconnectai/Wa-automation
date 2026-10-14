/**
 * src/services/appointment-reminders.js
 *
 * Automated 24-hour and 2-hour site visit appointment notifications.
 *
 * Key guarantees:
 * 1. Reuses existing `scheduled_messages` and `scheduler.js` pipeline (no second scheduler).
 * 2. Idempotent: protected by UNIQUE(appointment_id, reminder_type) WHERE status='pending'.
 * 3. Timezone-aware: renders formatted visit time in the tenant's configured IANA timezone.
 * 4. Property-rich: automatically attaches project name, address, and Google Maps URL if available.
 * 5. Customizable templates: supports tenant-level template overrides via `settings` table.
 * 6. Safe cancellation / rescheduling: immediately cancels pending reminders on cancellation or rebooking.
 * 7. Security: never logs full recipient phone numbers.
 */
'use strict';

const {
    getUserById,
    getAvailabilitySettings,
    getSetting,
    getProjectById,
    getCrmDealByPhone,
    createAppointmentReminder,
    cancelAppointmentReminders: dbCancelAppointmentReminders,
    getAppointmentReminders: dbGetAppointmentReminders,
    getUpcomingConfirmedAppointments
} = require('./database');
const { formatInZone } = require('../utils/tz');
const { maskPhoneNumber } = require('../utils/phone-mask');

const REMINDER_TYPES = {
    HOURS_24: '24h',
    HOURS_2: '2h'
};

const MS_24_HOURS = 24 * 60 * 60 * 1000;
const MS_2_HOURS = 2 * 60 * 60 * 1000;

const DEFAULT_TEMPLATES = {
    '24h': '🏠 Reminder: Hi {{name}}, your site visit for {{property}} with {{business_name}} is scheduled for tomorrow at {{time}}.\nLocation: {{location}}\n{{map_url}}\nIf you need to reschedule or cancel, please reply to this message.',
    '2h': '⏰ Reminder: Hi {{name}}, your site visit for {{property}} with {{business_name}} is coming up in 2 hours at {{time}}.\nLocation: {{location}}\n{{map_url}}\nWe look forward to meeting you!'
};

/**
 * Replaces {{key}} variables and cleans up blank / dangling lines.
 */
function renderReminderText(template, vars) {
    let text = template;
    for (const [key, val] of Object.entries(vars)) {
        const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi');
        text = text.replace(regex, val != null ? String(val) : '');
    }

    return text
        .split('\n')
        .map(line => line.trim())
        .filter(line => {
            const lower = line.toLowerCase();
            if (lower === 'location:' || lower === 'location: null' || lower === 'location: undefined' || lower === 'location: none') {
                return false;
            }
            if (lower === 'maps:' || lower === 'maps: null' || lower === 'maps: undefined') {
                return false;
            }
            return line.length > 0;
        })
        .join('\n');
}

/**
 * Resolves project details from appointment or related CRM deals.
 */
async function resolveProjectForAppointment(userId, appointment) {
    if (appointment.project_id) {
        const project = await getProjectById(userId, appointment.project_id);
        if (project) return project;
    }
    if (appointment.phone) {
        let deal = await getCrmDealByPhone(userId, appointment.phone);
        if (!deal) {
            const rawPhone = String(appointment.phone).replace(/^\+/, '');
            deal = await getCrmDealByPhone(userId, rawPhone);
        }
        if (deal && deal.interested_project_id) {
            const project = await getProjectById(userId, deal.interested_project_id);
            if (project) return project;
        }
    }
    return null;
}

/**
 * Constructs the template variable dictionary for an appointment.
 */
function buildReminderVars(appointment, { user, timezone, project }) {
    const startMs = new Date(appointment.start_at).getTime();
    const formattedTime = formatInZone(new Date(startMs), timezone);
    const contactName = (appointment.contact_name || '').trim();

    let locationStr = '';
    if (project) {
        locationStr = [project.address, project.locality, project.city].filter(Boolean).join(', ');
    }
    if (!locationStr && appointment.notes && !/cancelled/i.test(appointment.notes)) {
        locationStr = appointment.notes.trim();
    }

    let propertyStr = '';
    if (project && project.name) {
        propertyStr = project.name.trim();
    } else if (appointment.notes && !/cancelled/i.test(appointment.notes)) {
        propertyStr = appointment.notes.trim();
    } else {
        propertyStr = 'your scheduled property visit';
    }

    const mapUrlStr = project && project.map_url ? `Maps: ${project.map_url.trim()}` : '';

    return {
        name: contactName || 'there',
        contact_name: contactName || 'there',
        property: propertyStr,
        project: propertyStr,
        time: formattedTime,
        start_time: formattedTime,
        location: locationStr,
        address: locationStr,
        map_url: mapUrlStr,
        business_name: user?.business_name || 'our team'
    };
}

/**
 * Schedules 24h and 2h reminders for a confirmed upcoming appointment.
 * Overdue or past trigger times are safely skipped.
 *
 * @param {number} userId - Tenant owner id
 * @param {object} appointment - Appointment DB record
 * @param {object} [options]
 * @param {Date} [options.now] - Optional reference time for testing
 * @returns {Promise<Array<object>>} Scheduled message rows created
 */
async function scheduleAppointmentReminders(userId, appointment, { now = new Date() } = {}) {
    if (!appointment || !appointment.id || appointment.status !== 'confirmed') {
        return [];
    }
    if (!appointment.phone || !appointment.start_at) {
        return [];
    }

    const startMs = new Date(appointment.start_at).getTime();
    if (isNaN(startMs)) {
        return [];
    }

    const currentMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const target24h = new Date(startMs - MS_24_HOURS);
    const target2h = new Date(startMs - MS_2_HOURS);

    // Fetch tenant configuration
    const [user, availSettings, custom24h, custom2h] = await Promise.all([
        getUserById(userId),
        getAvailabilitySettings(userId),
        getSetting(userId, 'reminder_template_24h'),
        getSetting(userId, 'reminder_template_2h')
    ]);

    const timezone = availSettings?.timezone || 'Asia/Kolkata';
    const project = await resolveProjectForAppointment(userId, appointment);
    const vars = buildReminderVars(appointment, { user, timezone, project });

    const scheduled = [];

    // Schedule 24-hour reminder if its scheduled_at is still in the future
    if (target24h.getTime() > currentMs) {
        const template = (custom24h && custom24h.trim()) || DEFAULT_TEMPLATES['24h'];
        const body = renderReminderText(template, vars);
        const row = await createAppointmentReminder(
            userId,
            appointment.id,
            appointment.phone,
            body,
            target24h,
            REMINDER_TYPES.HOURS_24
        );
        if (row) scheduled.push(row);
    }

    // Schedule 2-hour reminder if its scheduled_at is still in the future
    if (target2h.getTime() > currentMs) {
        const template = (custom2h && custom2h.trim()) || DEFAULT_TEMPLATES['2h'];
        const body = renderReminderText(template, vars);
        const row = await createAppointmentReminder(
            userId,
            appointment.id,
            appointment.phone,
            body,
            target2h,
            REMINDER_TYPES.HOURS_2
        );
        if (row) scheduled.push(row);
    }

    if (scheduled.length > 0) {
        const safePhone = maskPhoneNumber(appointment.phone);
        console.log(`⏰ Scheduled ${scheduled.length} reminder(s) for appointment #${appointment.id} (${safePhone})`);
    }

    return scheduled;
}

/**
 * Cancels all pending reminders for a given appointment.
 */
async function cancelAppointmentReminders(userId, appointmentId) {
    if (!userId || !appointmentId) return;
    await dbCancelAppointmentReminders(userId, appointmentId);
}

/**
 * Reschedules reminders for an updated appointment: cancels old pending reminders
 * and schedules new ones based on the updated start_at.
 */
async function rescheduleAppointmentReminders(userId, appointment, options = {}) {
    if (!appointment || !appointment.id) return [];
    await cancelAppointmentReminders(userId, appointment.id);
    if (appointment.status === 'confirmed') {
        return scheduleAppointmentReminders(userId, appointment, options);
    }
    return [];
}

/**
 * Reconciles upcoming confirmed appointments to ensure reminder coverage.
 */
async function syncUpcomingAppointmentReminders(userId = null, { now = new Date() } = {}) {
    const upcoming = await getUpcomingConfirmedAppointments(userId, now);
    let totalScheduled = 0;
    for (const appt of upcoming) {
        const created = await scheduleAppointmentReminders(appt.user_id, appt, { now });
        totalScheduled += created.length;
    }
    return totalScheduled;
}

module.exports = {
    REMINDER_TYPES,
    DEFAULT_TEMPLATES,
    renderReminderText,
    buildReminderVars,
    resolveProjectForAppointment,
    scheduleAppointmentReminders,
    cancelAppointmentReminders,
    rescheduleAppointmentReminders,
    syncUpcomingAppointmentReminders,
    getAppointmentReminders: dbGetAppointmentReminders
};
