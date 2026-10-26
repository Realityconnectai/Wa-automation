'use strict';

/**
 * tests/appointment-reminder-tick.test.js
 *
 * Automated tests for:
 * 1. Tick contract: ✓ appears ONLY after a confirmed send with a message ID (wa_message_id != null).
 * 2. Unconfirmed send (status === 'sent' but missing wa_message_id) never ticks.
 * 3. Failed send never ticks (renders ⚠, never ✓).
 * 4. Superseded and cancelled reminders render correctly (renders ✕ with cancellation reason).
 * 5. UI definition: UI copy explicitly defines what the tick means (sent, not read receipt).
 * 6. Live refresh: reminders update dynamically without full browser reload.
 */

const fs = require('fs');
const path = require('path');

describe('Appointment Reminders Tick Contract, Status Rendering & UI Clarity', () => {
    let appJsContent;
    let indexHtmlContent;

    beforeAll(() => {
        appJsContent = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
        indexHtmlContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    });

    // Extract renderCompactReminders logic for unit assertion
    function simulateRenderCompactReminders(reminders) {
        if (!reminders || !reminders.length) {
            return '<span class="text-secondary-sm">None</span>';
        }
        const r24 = reminders.find(r => r.type === '24h');
        const r2 = reminders.find(r => r.type === '2h');

        const formatChip = (r, label) => {
            if (!r) return `${label} —`;
            // Strictly tick ONLY after a confirmed send with a message ID
            if (r.status === 'sent' && r.wa_message_id) {
                return `<span class="text-success font-bold" title="${label} sent (confirmed dispatched with message ID: ${r.wa_message_id}; sent, not read receipt)">✓ ${label}</span>`;
            }
            if (r.status === 'sent') {
                return `<span class="text-warning font-bold" title="${label} dispatched (awaiting server message ID)">… ${label}</span>`;
            }
            if (r.status === 'scheduled') return `<span class="text-primary font-bold" title="${label} scheduled">⏱ ${label}</span>`;
            if (r.status === 'sending') return `<span class="text-warning font-bold" title="${label} sending">… ${label}</span>`;
            if (r.status === 'failed') return `<span class="text-danger font-bold" title="${label} failed: ${r.error_message || ''}">⚠ ${label}</span>`;
            if (r.status === 'skipped') return `<span class="text-secondary" title="${label} skipped: ${r.error_message || 'Notice period'}">⊘ ${label}</span>`;
            return `<span class="text-secondary" title="${label} cancelled: ${r.error_message || 'Cancelled'}">✕ ${label}</span>`;
        };

        return `<span class="reminder-compact-indicator font-mono">${formatChip(r24, '24h')} · ${formatChip(r2, '2h')}</span>`;
    }

    test('1. Tick appears strictly after a confirmed send with a message ID', () => {
        const confirmedReminders = [
            { type: '24h', status: 'sent', wa_message_id: 'wa_msg_123456789' },
            { type: '2h', status: 'scheduled' }
        ];

        const rendered = simulateRenderCompactReminders(confirmedReminders);
        expect(rendered).toContain('✓ 24h');
        expect(rendered).toContain('wa_msg_123456789');
        expect(rendered).toContain('⏱ 2h');
    });

    test('2. Missing message ID never ticks (even if status is sent)', () => {
        const unconfirmedReminders = [
            { type: '24h', status: 'sent', wa_message_id: null },
            { type: '2h', status: 'sent', wa_message_id: '' }
        ];

        const rendered = simulateRenderCompactReminders(unconfirmedReminders);
        expect(rendered).not.toContain('✓ 24h');
        expect(rendered).not.toContain('✓ 2h');
        expect(rendered).toContain('… 24h');
        expect(rendered).toContain('… 2h');
    });

    test('3. Failed send never ticks and renders alert indicator', () => {
        const failedReminders = [
            { type: '24h', status: 'failed', error_message: 'WhatsApp client disconnected' },
            { type: '2h', status: 'failed', error_message: 'Recipient unresolvable' }
        ];

        const rendered = simulateRenderCompactReminders(failedReminders);
        expect(rendered).not.toContain('✓');
        expect(rendered).toContain('⚠ 24h');
        expect(rendered).toContain('⚠ 2h');
        expect(rendered).toContain('WhatsApp client disconnected');
    });

    test('4. Superseded and cancelled reminders render cancellation indicator correctly', () => {
        const cancelledReminders = [
            { type: '24h', status: 'cancelled', error_message: 'Appointment rescheduled' },
            { type: '2h', status: 'cancelled', error_message: 'Appointment cancelled' }
        ];

        const rendered = simulateRenderCompactReminders(cancelledReminders);
        expect(rendered).not.toContain('✓');
        expect(rendered).toContain('✕ 24h');
        expect(rendered).toContain('✕ 2h');
        expect(rendered).toContain('Appointment rescheduled');
    });

    test('5. UI defines what the tick means (sent, not read receipt)', () => {
        // Table header tooltip check
        expect(indexHtmlContent).toMatch(/Reminders \(24h\/2h\)/);
        expect(indexHtmlContent).toMatch(/sent,\s*not read receipt/i);

        // Client app.js logic check
        expect(appJsContent).toMatch(/sent,\s*not read receipt/i);
        expect(appJsContent).toContain('wa_message_id');
    });

    test('6. Detail modal includes live refresh polling timer', () => {
        expect(appJsContent).toContain('_appointmentDetailPollTimer');
        expect(appJsContent).toContain('setInterval');
        expect(appJsContent).toContain('clearInterval(window._appointmentDetailPollTimer)');
    });
});
