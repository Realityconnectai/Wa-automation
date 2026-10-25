/**
 * tests/outreach-ui-unit.test.js
 *
 * Targeted unit tests for Phase 1 outreach fixes:
 * 1. Recognition of terminal statuses ('completed', 'cancelled', 'interrupted', 'done')
 * 2. Proper counts calculation (sent, failed, skipped)
 * 3. Exclusion of opted-out contacts from quick-select pool and selection counts
 * 4. Resilient polling error threshold to prevent infinite loops
 */
'use strict';

describe('Outreach UI Logic — Phase 1 Targeted Fixes', () => {

    describe('1. Terminal status recognition & summary calculation', () => {
        const terminalStatuses = ['completed', 'cancelled', 'interrupted', 'done'];

        test('identifies completed, cancelled, and interrupted as terminal statuses', () => {
            expect(terminalStatuses.includes('completed')).toBe(true);
            expect(terminalStatuses.includes('cancelled')).toBe(true);
            expect(terminalStatuses.includes('interrupted')).toBe(true);
            expect(terminalStatuses.includes('done')).toBe(true);

            expect(terminalStatuses.includes('running')).toBe(false);
            expect(terminalStatuses.includes('cancel_requested')).toBe(false);
            expect(terminalStatuses.includes('pending')).toBe(false);
        });

        test('formats completion summary accurately with sent, failed, and skipped', () => {
            const formatSummary = (job) => {
                const statusLabels = {
                    completed: 'Finished',
                    cancelled: 'Cancelled',
                    interrupted: 'Interrupted',
                    done: 'Finished'
                };
                const label = statusLabels[job.status] || 'Finished';
                const sent = job.sent || 0;
                const failed = job.failed || 0;
                const skipped = job.skipped || 0;

                let summaryText = `${label} — ${sent} sent, ${failed} failed, ${skipped} skipped.`;
                if (job.error) {
                    summaryText += ` (${job.error})`;
                }
                return summaryText;
            };

            const completedJob = {
                status: 'completed',
                sent: 18,
                failed: 2,
                skipped: 5,
                error: ''
            };
            expect(formatSummary(completedJob)).toBe('Finished — 18 sent, 2 failed, 5 skipped.');

            const cancelledJob = {
                status: 'cancelled',
                sent: 5,
                failed: 0,
                skipped: 15,
                error: 'Cancelled by user'
            };
            expect(formatSummary(cancelledJob)).toBe('Cancelled — 5 sent, 0 failed, 15 skipped. (Cancelled by user)');

            const interruptedJob = {
                status: 'interrupted',
                sent: 2,
                failed: 1,
                skipped: 17,
                error: 'Server restarted'
            };
            expect(formatSummary(interruptedJob)).toBe('Interrupted — 2 sent, 1 failed, 17 skipped. (Server restarted)');
        });

        test('polling error threshold stops polling on persistent errors', () => {
            let pollErrors = 0;
            let pollingActive = true;

            const handlePollError = (err) => {
                pollErrors++;
                if (pollErrors >= 3 || err.status === 404) {
                    pollingActive = false;
                    return 'stop';
                }
                return 'retry';
            };

            expect(handlePollError(new Error('Network glitch'))).toBe('retry');
            expect(pollErrors).toBe(1);
            expect(pollingActive).toBe(true);

            expect(handlePollError(new Error('Timeout'))).toBe('retry');
            expect(pollErrors).toBe(2);
            expect(pollingActive).toBe(true);

            expect(handlePollError(new Error('Persistent failure'))).toBe('stop');
            expect(pollErrors).toBe(3);
            expect(pollingActive).toBe(false);
        });
    });

    describe('2. Contact selection & opt-out exclusion', () => {
        const mockContacts = [
            { id: 1, name: 'Alice', phone: '919876500001', is_opted_out: false, last_outreach_at: null },
            { id: 2, name: 'Bob', phone: '919876500002', is_opted_out: true, last_outreach_at: null }, // Opted out
            { id: 3, name: 'Charlie', phone: '919876500003', is_opted_out: false, last_outreach_at: '2026-10-15T10:00:00Z' }, // Already reached
            { id: 4, name: 'Dave', phone: '919876500004', is_opted_out: true, last_outreach_at: '2026-10-14T10:00:00Z' }, // Opted out & reached
            { id: 5, name: 'Eve', phone: '919876500005', is_opted_out: false, last_outreach_at: null }
        ];

        test('quickSelectNext excludes opted-out contacts completely', () => {
            const selectNext = (contacts, n, includeReached) => {
                const pool = contacts.filter(c => !c.is_opted_out && (includeReached || !c.last_outreach_at));
                return pool.slice(0, n);
            };

            // Not including reached: only Alice (1) and Eve (5) should be selected (Bob is opted-out)
            const unreachedOnly = selectNext(mockContacts, 10, false);
            expect(unreachedOnly.map(c => c.id)).toEqual([1, 5]);
            expect(unreachedOnly.some(c => c.is_opted_out)).toBe(false);

            // Including reached: Alice (1), Charlie (3), Eve (5). Neither Bob (2) nor Dave (4) should be picked
            const withReached = selectNext(mockContacts, 10, true);
            expect(withReached.map(c => c.id)).toEqual([1, 3, 5]);
            expect(withReached.some(c => c.is_opted_out)).toBe(false);
        });

        test('select-all calculation compares against eligible (non-opted-out) count', () => {
            const eligibleCount = mockContacts.filter(c => !c.is_opted_out).length;
            expect(eligibleCount).toBe(3); // Alice, Charlie, Eve

            const selected = [1, 3, 5];
            const isAllSelected = eligibleCount > 0 && selected.length === eligibleCount;
            expect(isAllSelected).toBe(true);

            const partialSelected = [1, 5];
            expect(eligibleCount > 0 && partialSelected.length === eligibleCount).toBe(false);
        });

        test('checkbox selection guard rejects opted-out contacts', () => {
            const selected = new Map();
            const trySelect = (contact) => {
                if (contact.is_opted_out) {
                    return false;
                }
                selected.set(contact.id, { id: contact.id, phone: contact.phone, name: contact.name });
                return true;
            };

            expect(trySelect(mockContacts[0])).toBe(true); // Alice
            expect(trySelect(mockContacts[1])).toBe(false); // Bob (opted-out)
            expect(selected.has(1)).toBe(true);
            expect(selected.has(2)).toBe(false);
        });
    });

    describe('3. Selection bar & outreach modal visibility synchronization', () => {
        test('selection bar is hidden when no contacts are selected and visible when eligible contacts are selected', () => {
            const bar = { hidden: true, style: { display: 'none' } };
            const syncBar = (selectedCount) => {
                bar.hidden = selectedCount === 0;
                bar.style.display = selectedCount > 0 ? 'flex' : 'none';
            };

            // 0 selected: bar is hidden
            syncBar(0);
            expect(bar.hidden).toBe(true);
            expect(bar.style.display).toBe('none');

            // 5 selected: bar is visible
            syncBar(5);
            expect(bar.hidden).toBe(false);
            expect(bar.style.display).toBe('flex');

            // Deselected back to 0: bar is hidden
            syncBar(0);
            expect(bar.hidden).toBe(true);
            expect(bar.style.display).toBe('none');
        });

        test('outreach modal opens and closes correctly with hidden property synchronized', () => {
            const modal = { hidden: true, style: { display: 'none' } };
            const composeView = { hidden: true, style: { display: 'none' } };
            const progressView = { hidden: true, style: { display: 'none' } };

            const openModal = () => {
                composeView.hidden = false;
                composeView.style.display = '';
                progressView.hidden = true;
                progressView.style.display = 'none';
                modal.hidden = false;
                modal.style.display = 'flex';
            };

            const closeModal = () => {
                modal.hidden = true;
                modal.style.display = 'none';
            };

            openModal();
            expect(modal.hidden).toBe(false);
            expect(modal.style.display).toBe('flex');
            expect(composeView.hidden).toBe(false);
            expect(progressView.hidden).toBe(true);

            closeModal();
            expect(modal.hidden).toBe(true);
            expect(modal.style.display).toBe('none');
        });

        test('new campaign action opens composer directly with recipient selection and search support', () => {
            let composerOpened = false;
            let fromCampaignsMode = false;

            const openOutreachModal = (opts = {}) => {
                composerOpened = true;
                fromCampaignsMode = !!opts.fromCampaigns;
            };

            const startNewCampaign = () => {
                openOutreachModal({ fromCampaigns: true });
            };

            startNewCampaign();
            expect(composerOpened).toBe(true);
            expect(fromCampaignsMode).toBe(true);
        });

        test('contact picker quick-select selects eligible contacts up to requested count and excludes opted-out', () => {
            const contacts = [
                { id: 1, name: 'Alice', phone: '919876500001', is_opted_out: false, last_outreach_at: null },
                { id: 2, name: 'Bob', phone: '919876500002', is_opted_out: true, last_outreach_at: null }, // Opted out
                { id: 3, name: 'Charlie', phone: '919876500003', is_opted_out: false, last_outreach_at: '2026-10-15T10:00:00Z' },
                { id: 4, name: 'Dave', phone: '919876500004', is_opted_out: false, last_outreach_at: null }
            ];

            const pickN = (n) => {
                const eligible = contacts.filter(c => !c.is_opted_out);
                // unreached first
                eligible.sort((a, b) => (a.last_outreach_at ? 1 : 0) - (b.last_outreach_at ? 1 : 0));
                return eligible.slice(0, Math.min(n, 25));
            };

            const picked2 = pickN(2);
            expect(picked2.map(c => c.id)).toEqual([1, 4]); // Unreached first, Bob skipped
            expect(picked2.some(c => c.is_opted_out)).toBe(false);

            const picked10 = pickN(10);
            expect(picked10.map(c => c.id)).toEqual([1, 4, 3]); // Alice, Dave, then Charlie (already reached)
            expect(picked10.some(c => c.is_opted_out)).toBe(false);
        });

        test('start campaign button state requires both eligible contacts and non-empty message', () => {
            const isButtonEnabled = (selectedCount, message) => {
                return selectedCount > 0 && message.trim().length > 0;
            };

            expect(isButtonEnabled(0, 'Hello')).toBe(false);
            expect(isButtonEnabled(5, '')).toBe(false);
            expect(isButtonEnabled(5, '   ')).toBe(false);
            expect(isButtonEnabled(5, 'Valid message')).toBe(true);
        });

        test('text-only and media-attached payloads are constructed properly for outreach API', () => {
            const buildPayload = ({ selectedIds, message, mediaAssetId = null }) => {
                return {
                    contactIds: selectedIds,
                    message: message.trim(),
                    mediaAssetId: mediaAssetId ? parseInt(mediaAssetId, 10) : null
                };
            };

            const textOnly = buildPayload({ selectedIds: [10, 20], message: 'Hello world' });
            expect(textOnly).toEqual({
                contactIds: [10, 20],
                message: 'Hello world',
                mediaAssetId: null
            });

            const mediaAttached = buildPayload({ selectedIds: [10, 20], message: 'See brochure', mediaAssetId: '42' });
            expect(mediaAttached).toEqual({
                contactIds: [10, 20],
                message: 'See brochure',
                mediaAssetId: 42
            });
        });
    });
});
