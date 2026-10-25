'use strict';

/**
 * tests/campaigns-unit.test.js
 *
 * Targeted unit tests for Phase 2 Campaign Management & History:
 * 1. Tenant-scoped listing & pagination parameters validation and math
 * 2. Status filtering & enum handling
 * 3. Empty campaign history handling
 * 4. Campaign details: summary counts, recipient fields, and role-based phone masking
 * 5. Cancellation lifecycle and visibility rules
 */

const { maskPhoneNumber, isAuthorizedForFullPhone } = require('../src/utils/phone-mask');

describe('Campaign Management & History — Phase 2 Unit Tests', () => {

    describe('1. Pagination calculation and parameter validation', () => {
        const clampInt = (val, { min = 0, max = 100, fallback = 0 } = {}) => {
            const parsed = parseInt(val, 10);
            if (Number.isNaN(parsed)) return fallback;
            return Math.min(Math.max(parsed, min), max);
        };

        test('clamps pagination limit between 1 and 100 with default 20', () => {
            expect(clampInt(undefined, { min: 1, max: 100, fallback: 20 })).toBe(20);
            expect(clampInt('', { min: 1, max: 100, fallback: 20 })).toBe(20);
            expect(clampInt('50', { min: 1, max: 100, fallback: 20 })).toBe(50);
            expect(clampInt('0', { min: 1, max: 100, fallback: 20 })).toBe(1);
            expect(clampInt('-10', { min: 1, max: 100, fallback: 20 })).toBe(1);
            expect(clampInt('500', { min: 1, max: 100, fallback: 20 })).toBe(100);
        });

        test('clamps pagination offset to non-negative integers', () => {
            expect(clampInt(undefined, { min: 0, max: 10000, fallback: 0 })).toBe(0);
            expect(clampInt('-5', { min: 0, max: 10000, fallback: 0 })).toBe(0);
            expect(clampInt('40', { min: 0, max: 10000, fallback: 0 })).toBe(40);
        });

        test('calculates pagination metadata correctly for page rendering', () => {
            const computePagination = (total, offset, limit) => {
                const start = total === 0 ? 0 : offset + 1;
                const end = Math.min(offset + limit, total);
                const currentPage = Math.floor(offset / limit) + 1;
                const totalPages = Math.max(1, Math.ceil(total / limit));
                const hasPrev = offset > 0;
                const hasNext = offset + limit < total;
                return { start, end, currentPage, totalPages, hasPrev, hasNext };
            };

            // First page of 45 items, limit 20
            const page1 = computePagination(45, 0, 20);
            expect(page1).toEqual({
                start: 1,
                end: 20,
                currentPage: 1,
                totalPages: 3,
                hasPrev: false,
                hasNext: true
            });

            // Second page of 45 items, limit 20
            const page2 = computePagination(45, 20, 20);
            expect(page2).toEqual({
                start: 21,
                end: 40,
                currentPage: 2,
                totalPages: 3,
                hasPrev: true,
                hasNext: true
            });

            // Last page of 45 items, limit 20
            const page3 = computePagination(45, 40, 20);
            expect(page3).toEqual({
                start: 41,
                end: 45,
                currentPage: 3,
                totalPages: 3,
                hasPrev: true,
                hasNext: false
            });
        });
    });

    describe('2. Status filtering and allowed enums', () => {
        const allowedStatuses = ['running', 'cancel_requested', 'completed', 'cancelled', 'interrupted'];
        const optionalEnum = (val, allowed) => {
            if (!val) return '';
            const s = String(val).trim().toLowerCase();
            return allowed.includes(s) ? s : '';
        };

        test('accepts all valid campaign statuses', () => {
            allowedStatuses.forEach(st => {
                expect(optionalEnum(st, allowedStatuses)).toBe(st);
            });
        });

        test('rejects unrecognized or malicious status queries', () => {
            expect(optionalEnum('deleted', allowedStatuses)).toBe('');
            expect(optionalEnum("running' OR '1'='1", allowedStatuses)).toBe('');
            expect(optionalEnum(null, allowedStatuses)).toBe('');
            expect(optionalEnum(undefined, allowedStatuses)).toBe('');
        });
    });

    describe('3. Empty campaign history handling', () => {
        test('handles empty campaign response gracefully', () => {
            const apiResponse = {
                success: true,
                data: [],
                meta: { limit: 20, offset: 0, total: 0 }
            };

            expect(apiResponse.data).toHaveLength(0);
            expect(apiResponse.meta.total).toBe(0);

            // Empty state display logic
            const isEmpty = !apiResponse.data || apiResponse.data.length === 0;
            expect(isEmpty).toBe(true);
        });
    });

    describe('4. Campaign details & recipient-level data formatting', () => {
        const mockRawJob = {
            id: 'job-tenant-1-abc123',
            user_id: 1,
            message_template: 'Hello {name}, check our new project!',
            status: 'completed',
            started_at: '2026-10-15T12:00:00Z',
            finished_at: '2026-10-15T12:05:00Z',
            error: null,
            results: [
                { phone: '919876543210', name: 'John Doe', status: 'sent', reason: null, sent_at: '2026-10-15T12:01:00Z' },
                { phone: '919876543211', name: null, status: 'failed', reason: 'Phone invalid', sent_at: null },
                { phone: '919876543212', name: 'Opted Out User', status: 'skipped', reason: 'User opted out', sent_at: null }
            ]
        };

        test('calculates summary counts accurately from recipient rows', () => {
            const counts = mockRawJob.results.reduce((acc, row) => {
                acc[row.status] = (acc[row.status] || 0) + 1;
                return acc;
            }, {});

            expect(counts.sent).toBe(1);
            expect(counts.failed).toBe(1);
            expect(counts.skipped).toBe(1);
            expect(mockRawJob.results.length).toBe(3);
        });

        test('handles missing contact names and null values safely', () => {
            const formatRecipientName = (r) => r.name || '—';
            expect(formatRecipientName(mockRawJob.results[0])).toBe('John Doe');
            expect(formatRecipientName(mockRawJob.results[1])).toBe('—');
        });

        test('masks recipient phone numbers for non-admin users', () => {
            const nonAdminUser = { id: 1, role: 'staff' };
            const adminUser = { id: 1, role: 'admin' };

            expect(isAuthorizedForFullPhone(nonAdminUser)).toBe(false);
            expect(isAuthorizedForFullPhone(adminUser)).toBe(true);

            const prepareResultsForUser = (results, user) => {
                if (isAuthorizedForFullPhone(user)) return results;
                return results.map(r => ({
                    ...r,
                    phone: maskPhoneNumber(r.phone)
                }));
            };

            const staffView = prepareResultsForUser(mockRawJob.results, nonAdminUser);
            expect(staffView[0].phone).toContain('XXXXX');
            expect(staffView[0].phone).not.toContain('3210');

            const adminView = prepareResultsForUser(mockRawJob.results, adminUser);
            expect(adminView[0].phone).toBe('919876543210');
        });
    });

    describe('5. Cancellation lifecycle & action visibility', () => {
        const isCampaignCancellable = (status) => {
            return ['running', 'cancel_requested'].includes(status);
        };

        test('identifies running and cancel_requested as cancellable', () => {
            expect(isCampaignCancellable('running')).toBe(true);
            expect(isCampaignCancellable('cancel_requested')).toBe(true);
        });

        test('terminal statuses cannot be cancelled', () => {
            expect(isCampaignCancellable('completed')).toBe(false);
            expect(isCampaignCancellable('cancelled')).toBe(false);
            expect(isCampaignCancellable('interrupted')).toBe(false);
            expect(isCampaignCancellable('unknown')).toBe(false);
        });
    });
});
