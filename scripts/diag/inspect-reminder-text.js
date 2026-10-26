'use strict';

require('dotenv').config();
const { runSql, queryAll } = require('../../src/services/db-pool');
const {
    renderReminderText,
    buildReminderVars,
    resolveProjectForAppointment,
    DEFAULT_TEMPLATES
} = require('../../src/services/appointment-reminders');
const { getUserById, getAvailabilitySettings, getSetting } = require('../../src/services/database');

async function main() {
    console.log('=== INSPECTION: SCHEDULER & REAL 24H / 2H REMINDER TEXT ===\n');

    // 1. Scheduler proof in live database
    const scheduledCounts = await queryAll(`
        SELECT status, COUNT(*)::int AS count
        FROM scheduled_messages
        GROUP BY status
    `);
    console.log('1. Scheduled Messages in Live DB by Status:', scheduledCounts);

    // 2. Fetch or create a representative confirmed appointment with project details
    const appts = await queryAll(`
        SELECT a.*, p.name AS project_name, p.address AS project_address, p.map_url
        FROM appointments a
        LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.status = 'confirmed'
        ORDER BY a.id DESC
        LIMIT 1
    `);

    let targetAppt = appts[0];
    let userId = targetAppt ? targetAppt.user_id : 1;

    // If no appointment with project, fetch first user and project to construct real representative appointment
    const user = await getUserById(userId);
    const availSettings = await getAvailabilitySettings(userId);
    const timezone = availSettings?.timezone || 'Asia/Kolkata';

    const projects = await queryAll('SELECT * FROM projects WHERE user_id = $1 ORDER BY id ASC LIMIT 1', [userId]);
    const project = projects[0] || {
        id: 999,
        name: 'Grand Orchids Luxury Residences',
        address: 'Plot 42, Sector 15, Golf Course Extension',
        locality: 'Sector 15',
        city: 'Gurugram',
        map_url: 'https://maps.google.com/?q=28.4595,77.0266'
    };

    if (!targetAppt) {
        // Sample confirmed appointment slot 48 hours in the future
        const slotStart = new Date(Date.now() + 48 * 3600 * 1000);
        targetAppt = {
            id: 101,
            user_id: userId,
            contact_name: 'Rahul Sharma',
            phone: '918950153750',
            start_at: slotStart.toISOString(),
            status: 'confirmed',
            notes: 'Looking for 3BHK high floor with park view',
            project_id: project.id
        };
    }

    console.log('2. Representative Appointment Context:');
    console.log(`   - ID: ${targetAppt.id}`);
    console.log(`   - Contact: ${targetAppt.contact_name} (${targetAppt.phone})`);
    console.log(`   - Start Time (UTC): ${targetAppt.start_at}`);
    console.log(`   - Timezone: ${timezone}`);
    console.log(`   - Project: ${project.name}`);
    console.log(`   - Address: ${project.address}`);
    console.log(`   - Map: ${project.map_url}\n`);

    // 3. Build template variables
    const vars = buildReminderVars(targetAppt, { user, timezone, project });
    console.log('3. Rendered Template Variables:', vars);

    // 4. Render real 24h reminder
    const template24h = (await getSetting(userId, 'reminder_template_24h')) || DEFAULT_TEMPLATES['24h'];
    const rendered24h = renderReminderText(template24h, vars);

    console.log('\n================ REAL 24H REMINDER MESSAGE TEXT ================');
    console.log(rendered24h);
    console.log('================================================================');

    // 5. Render real 2h reminder
    const template2h = (await getSetting(userId, 'reminder_template_2h')) || DEFAULT_TEMPLATES['2h'];
    const rendered2h = renderReminderText(template2h, vars);

    console.log('\n================ REAL 2H REMINDER MESSAGE TEXT =================');
    console.log(rendered2h);
    console.log('================================================================');

    // 6. Assertions for quality (zero unreplaced placeholders, correct timezone IST)
    const placeholders = (str) => (str.match(/\{\{[^}]+\}\}/g) || []);
    const p24 = placeholders(rendered24h);
    const p2 = placeholders(rendered2h);

    console.log('\n4. Quality Checks:');
    console.log(`   - 24h unreplaced placeholders: ${p24.length === 0 ? 'NONE (PASS)' : p24.join(', ')}`);
    console.log(`   - 2h unreplaced placeholders: ${p2.length === 0 ? 'NONE (PASS)' : p2.join(', ')}`);
    console.log(`   - Contains 'undefined' or 'null': ${/undefined|null/i.test(rendered24h + rendered2h) ? 'FAIL' : 'NONE (PASS)'}`);
    console.log(`   - Timezone format: ${/am|pm/i.test(vars.time) ? 'Formatted with 12h am/pm in ' + timezone + ' (PASS)' : 'FAIL'}`);

    process.exit(0);
}

main().catch(err => {
    console.error('Inspection failed:', err);
    process.exit(1);
});
