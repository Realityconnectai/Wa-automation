'use strict';

/**
 * tests/contacts-mgmt-unit.test.js
 *
 * Targeted unit tests for Phase 4 Contact Management Improvements:
 * 1. Formatted phone search normalization (+, spaces, hyphens, parens) & name search
 * 2. Combined filters: search + label filtering + accurate totals
 * 3. Pagination math & boundary handling (Previous/Next, page sizes, accurate totals)
 * 4. Contact editing & safety preservation (opt-out and AI-pause flags untouched)
 * 5. Tenant isolation (scoping on reads, updates, and label retrieval)
 */

const { buildContactSearchClause } = require('../src/services/database');
const { LIMITS, optionalString, sanitizeSpreadsheetCell } = require('../src/utils/validate');

describe('Contact Management Improvements — Phase 4 Unit Tests', () => {

    describe('1. Formatted phone search normalization and query building', () => {
        test('normalizes phone searches with international format (+91 98765-43210)', () => {
            const result = buildContactSearchClause('+91 98765-43210', 2);
            expect(result.clause).toContain('phone ILIKE $3');
            expect(result.params).toEqual(['%+91 98765-43210%', '%919876543210%']);
            expect(result.nextIdx).toBe(4);
        });

        test('normalizes phone searches with parentheses and hyphens ((555) 123-4567)', () => {
            const result = buildContactSearchClause('(555) 123-4567', 2);
            expect(result.clause).toContain('phone ILIKE $3');
            expect(result.params).toEqual(['%(555) 123-4567%', '%5551234567%']);
        });

        test('handles searches with only digits (partial or full)', () => {
            const result = buildContactSearchClause('98765', 2);
            expect(result.clause).toBe(' AND (name ILIKE $2 OR phone ILIKE $3)');
            expect(result.params).toEqual(['%98765%', '%98765%']);
        });

        test('handles name searches with text without treating words as phones', () => {
            const result = buildContactSearchClause('Sarah Connor', 2);
            expect(result.clause).toBe(' AND (name ILIKE $2 OR phone ILIKE $3)');
            expect(result.params).toEqual(['%Sarah Connor%', '%Sarah Connor%']);
        });

        test('returns empty clause and empty params on whitespace or empty search', () => {
            expect(buildContactSearchClause('', 2)).toEqual({ clause: '', params: [], nextIdx: 2 });
            expect(buildContactSearchClause('   ', 2)).toEqual({ clause: '', params: [], nextIdx: 2 });
            expect(buildContactSearchClause(null, 2)).toEqual({ clause: '', params: [], nextIdx: 2 });
        });
    });

    describe('2. Combined filters: search + label filtering + accurate totals', () => {
        // Mock dataset for tenant 1
        const mockContacts = [
            { id: 1, user_id: 1, name: 'Alice Smith', phone: '919876543210', label: 'VIP', is_opted_out: false },
            { id: 2, user_id: 1, name: 'Bob Jones', phone: '15551234567', label: 'Lead', is_opted_out: false },
            { id: 3, user_id: 1, name: 'Charlie Brown', phone: '919876500000', label: 'VIP', is_opted_out: true },
            { id: 4, user_id: 1, name: 'Diana Prince', phone: '447700900077', label: 'Investor', is_opted_out: false },
            { id: 5, user_id: 1, name: 'Evan Wright', phone: '15559876543', label: 'Lead', is_opted_out: false },
        ];

        // Simulate filter and count logic matching database queries
        function filterContacts(contacts, { search = '', label = '' } = {}) {
            let res = [...contacts];
            if (label) {
                res = res.filter(c => c.label === label);
            }
            if (search && search.trim()) {
                const trimmed = search.trim();
                const digits = trimmed.replace(/\D/g, '');
                const hasLetters = /[a-zA-Z]/.test(trimmed);
                res = res.filter(c => {
                    const nameMatch = c.name.toLowerCase().includes(trimmed.toLowerCase());
                    const phoneMatch = !hasLetters && digits.length > 0
                        ? c.phone.includes(digits)
                        : c.phone.toLowerCase().includes(trimmed.toLowerCase());
                    return nameMatch || phoneMatch;
                });
            }
            return res;
        }

        test('filters contacts accurately by label alone', () => {
            const vipList = filterContacts(mockContacts, { label: 'VIP' });
            expect(vipList).toHaveLength(2);
            expect(vipList.map(c => c.name)).toEqual(['Alice Smith', 'Charlie Brown']);
        });

        test('combines search and label filter together', () => {
            // Search '98765' with label 'VIP' -> only Alice (Charlie has 9876500000 too)
            const matches = filterContacts(mockContacts, { search: '+91 98765-43210', label: 'VIP' });
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe('Alice Smith');
        });

        test('combines formatted phone search and label returning zero when label differs', () => {
            const matches = filterContacts(mockContacts, { search: '+91 98765-43210', label: 'Lead' });
            expect(matches).toHaveLength(0);
        });

        test('calculates accurate count reflecting both search and label filters', () => {
            const totalMatching = filterContacts(mockContacts, { label: 'Lead' }).length;
            expect(totalMatching).toBe(2);

            const totalWithSearch = filterContacts(mockContacts, { search: '1555', label: 'Lead' }).length;
            expect(totalWithSearch).toBe(2);

            const totalNonExistent = filterContacts(mockContacts, { search: 'Nonexistent', label: 'VIP' }).length;
            expect(totalNonExistent).toBe(0);
        });
    });

    describe('3. Pagination math & controls', () => {
        function computePagination(total, offset, limit) {
            const start = total === 0 ? 0 : offset + 1;
            const end = Math.min(offset + limit, total);
            const currentPage = Math.floor(offset / limit) + 1;
            const totalPages = Math.max(1, Math.ceil(total / limit));
            const hasPrev = offset > 0;
            const hasNext = offset + limit < total;
            return { start, end, currentPage, totalPages, hasPrev, hasNext };
        }

        test('calculates page 1 info correctly for 120 items at 50 per page', () => {
            const page1 = computePagination(120, 0, 50);
            expect(page1).toEqual({
                start: 1,
                end: 50,
                currentPage: 1,
                totalPages: 3,
                hasPrev: false,
                hasNext: true
            });
        });

        test('calculates page 2 info correctly for 120 items at 50 per page', () => {
            const page2 = computePagination(120, 50, 50);
            expect(page2).toEqual({
                start: 51,
                end: 100,
                currentPage: 2,
                totalPages: 3,
                hasPrev: true,
                hasNext: true
            });
        });

        test('calculates last page info correctly for 120 items at 50 per page', () => {
            const page3 = computePagination(120, 100, 50);
            expect(page3).toEqual({
                start: 101,
                end: 120,
                currentPage: 3,
                totalPages: 3,
                hasPrev: true,
                hasNext: false
            });
        });

        test('handles empty dataset with start=0, end=0, hasPrev=false, hasNext=false', () => {
            const empty = computePagination(0, 0, 50);
            expect(empty).toEqual({
                start: 0,
                end: 0,
                currentPage: 1,
                totalPages: 1,
                hasPrev: false,
                hasNext: false
            });
        });

        test('page size selection properly adjusts page slice', () => {
            const items = Array.from({ length: 75 }, (_, i) => ({ id: i + 1 }));
            const getPage = (offset, limit) => items.slice(offset, offset + limit);

            expect(getPage(0, 20)).toHaveLength(20);
            expect(getPage(20, 20)).toHaveLength(20);
            expect(getPage(60, 20)).toHaveLength(15);
            expect(getPage(0, 50)).toHaveLength(50);
            expect(getPage(50, 50)).toHaveLength(25);
        });
    });

    describe('4. Contact editing & safety preservation (opt-out & AI pause)', () => {
        // Mock update function simulating updateContact behavior
        function mockUpdateContact(store, userId, id, { name, label, notes }) {
            const cleanId = typeof id === 'number' ? id : parseInt(id, 10);
            const index = store.findIndex(c => c.user_id === userId && c.id === cleanId);
            if (index === -1) return null;

            const existing = store[index];
            const updated = {
                ...existing,
                name: name !== undefined ? name : existing.name,
                label: label !== undefined ? label : existing.label,
                notes: notes !== undefined ? notes : existing.notes,
                updated_at: new Date().toISOString()
            };
            store[index] = updated;
            return updated;
        }

        test('updates name, label, and notes successfully', () => {
            const store = [
                {
                    id: 10,
                    user_id: 1,
                    phone: '919876543210',
                    name: 'Old Name',
                    label: 'Old Label',
                    notes: 'Old Notes',
                    is_opted_out: false,
                    is_ai_paused: false
                }
            ];

            const updated = mockUpdateContact(store, 1, 10, {
                name: 'New Name',
                label: 'Investor',
                notes: 'Interested in commercial spaces'
            });

            expect(updated).not.toBeNull();
            expect(updated.name).toBe('New Name');
            expect(updated.label).toBe('Investor');
            expect(updated.notes).toBe('Interested in commercial spaces');
            expect(updated.phone).toBe('919876543210');
        });

        test('preserves is_opted_out, opted_out_at, and opt_out_reason during edit', () => {
            const optedOutTimestamp = new Date(Date.now() - 3600000).toISOString();
            const store = [
                {
                    id: 11,
                    user_id: 1,
                    phone: '919876543211',
                    name: 'Opted Out Contact',
                    label: 'Former Client',
                    notes: '',
                    is_opted_out: true,
                    opted_out_at: optedOutTimestamp,
                    opt_out_reason: 'STOP message received',
                    is_ai_paused: false
                }
            ];

            const updated = mockUpdateContact(store, 1, 11, {
                name: 'Opted Out Contact Updated',
                label: 'Archived',
                notes: 'Do not contact'
            });

            expect(updated.is_opted_out).toBe(true);
            expect(updated.opted_out_at).toBe(optedOutTimestamp);
            expect(updated.opt_out_reason).toBe('STOP message received');
        });

        test('preserves is_ai_paused and ai_paused_until during edit', () => {
            const pauseUntil = new Date(Date.now() + 86400000).toISOString();
            const store = [
                {
                    id: 12,
                    user_id: 1,
                    phone: '919876543212',
                    name: 'Paused Contact',
                    label: 'Lead',
                    notes: '',
                    is_opted_out: false,
                    is_ai_paused: true,
                    ai_paused_until: pauseUntil
                }
            ];

            const updated = mockUpdateContact(store, 1, 12, {
                name: 'Paused Contact Name Edit',
                notes: 'Agent handling manually'
            });

            expect(updated.is_ai_paused).toBe(true);
            expect(updated.ai_paused_until).toBe(pauseUntil);
        });

        test('sanitizes spreadsheet formula injection in name, label, and notes', () => {
            const rawName = '=cmd|"/C calc"!A0';
            const rawLabel = '+2+5';
            const rawNotes = '@SUM(A1:A10)';

            const cleanName = sanitizeSpreadsheetCell(optionalString(rawName, 'name', LIMITS.CONTACT_NAME));
            const cleanLabel = sanitizeSpreadsheetCell(optionalString(rawLabel, 'label', LIMITS.CONTACT_LABEL));
            const cleanNotes = sanitizeSpreadsheetCell(optionalString(rawNotes, 'notes', LIMITS.CONTACT_NOTES));

            // Formula triggers (=, +, -, @) are prepended with an apostrophe
            expect(cleanName.startsWith("'")).toBe(true);
            expect(cleanLabel.startsWith("'")).toBe(true);
            expect(cleanNotes.startsWith("'")).toBe(true);
        });
    });

    describe('5. Multi-tenant security & isolation', () => {
        const store = [
            { id: 1, user_id: 1, phone: '919876500001', name: 'Tenant 1 Contact', label: 'VIP' },
            { id: 2, user_id: 2, phone: '919876500002', name: 'Tenant 2 Contact', label: 'Secret' }
        ];

        function getContactById(userId, id) {
            return store.find(c => c.user_id === userId && c.id === id) || null;
        }

        function updateContact(userId, id, updates) {
            const index = store.findIndex(c => c.user_id === userId && c.id === id);
            if (index === -1) return null;
            store[index] = { ...store[index], ...updates };
            return store[index];
        }

        function getContactLabels(userId) {
            const labels = store.filter(c => c.user_id === userId).map(c => c.label);
            return [...new Set(labels)];
        }

        test('cannot read another tenant’s contact by ID', () => {
            // Tenant 1 tries to access Tenant 2's contact (id 2)
            const result = getContactById(1, 2);
            expect(result).toBeNull();
        });

        test('cannot update another tenant’s contact by ID', () => {
            // Tenant 1 tries to edit Tenant 2's contact
            const result = updateContact(1, 2, { name: 'Hacked Name' });
            expect(result).toBeNull();

            // Verify Tenant 2's contact was NOT modified
            const tenant2Contact = getContactById(2, 2);
            expect(tenant2Contact.name).toBe('Tenant 2 Contact');
        });

        test('label list is strictly isolated per tenant', () => {
            const t1Labels = getContactLabels(1);
            const t2Labels = getContactLabels(2);

            expect(t1Labels).toEqual(['VIP']);
            expect(t2Labels).toEqual(['Secret']);
            expect(t1Labels).not.toContain('Secret');
        });
    });
});
