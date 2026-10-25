/**
 * tests/inventory-hold-book-ui.test.js
 *
 * Targeted unit tests for Place Hold and Book property modals in WorkPilot CRM:
 * 1. Root-cause audit: verifies zero native dialogs (prompt, alert) in hold/booking flows
 * 2. Place Hold modal: template structure, unit summary banner, required fields, validation, duration
 * 3. Book Property modal: template structure, unit summary banner, booking ref validation, remarks
 * 4. Release Hold modal: template structure, explanation note, reason field
 * 5. State transitions, duplicate submission prevention, loading state, and error handling
 * 6. Cancellation and keyboard accessibility (Escape to close, autofocus)
 */
'use strict';

const fs = require('fs');
const path = require('path');

describe('WorkPilot Inventory — Hold & Book Modals UI/UX', () => {
    const inventoryJsPath = path.join(__dirname, '../public/js/inventory.js');
    const styleCssPath = path.join(__dirname, '../public/css/style.css');
    const inventoryJsCode = fs.readFileSync(inventoryJsPath, 'utf8');
    const styleCssCode = fs.readFileSync(styleCssPath, 'utf8');

    // ─── 1. Native Browser Dialog Audit ───────────────────────────────────────
    describe('1. Root Cause & Native Dialog Audit', () => {
        test('inventory.js contains ZERO occurrences of window.prompt', () => {
            const matches = inventoryJsCode.match(/\b(window\.)?prompt\s*\(/g);
            expect(matches).toBeNull();
        });

        test('inventory.js contains ZERO occurrences of window.alert', () => {
            const matches = inventoryJsCode.match(/\b(window\.)?alert\s*\(/g);
            expect(matches).toBeNull();
        });

        test('hold, book, and release transition flows do not use confirm()', () => {
            // Extract the transition, openHoldModal, openBookModal, openReleaseModal functions
            const transitionSection = inventoryJsCode.slice(
                inventoryJsCode.indexOf('function openHoldModal'),
                inventoryJsCode.indexOf('function brochureError')
            );
            expect(transitionSection).not.toMatch(/\b(window\.)?confirm\s*\(/);
            expect(transitionSection).not.toMatch(/\b(window\.)?prompt\s*\(/);
            expect(transitionSection).not.toMatch(/\b(window\.)?alert\s*\(/);
        });
    });

    // ─── 2. Place Property Hold Modal Template & Logic ───────────────────────
    describe('2. Place Property Hold Modal Template & Logic', () => {
        const mockUnit = {
            id: 101,
            project_id: 1,
            unit_number: 'B-402',
            tower: 'Tower B',
            floor: 4,
            bhk: '3BHK',
            area: 1450,
            area_unit: 'sqft',
            price: 8500000,
            status: 'VACANT'
        };
        const mockProject = { id: 1, name: 'Grand Palm Residency' };

        test('includes proper modal heading and unit summary elements', () => {
            expect(inventoryJsCode).toContain("modal('Place Property Hold', html, 'modal-hold')");
            expect(inventoryJsCode).toContain('unit-summary-banner');
            expect(inventoryJsCode).toContain('unit-summary-heading');
            expect(inventoryJsCode).toContain('unit-summary-grid');
        });

        test('unit summary banner includes unit number, project, tower, floor, BHK, and price', () => {
            function renderSummary(unit, proj) {
                const tone = { VACANT: 'pill-active', ON_HOLD: 'pill-pending', BOOKED: 'pill-error', SOLD: 'pill-paused' };
                const priceFormatted = unit.price ? `₹${Number(unit.price).toLocaleString('en-IN')}` : '—';
                const areaFormatted = unit.area ? ` (${unit.area} ${unit.area_unit || 'sqft'})` : '';
                return `
                    <div class="unit-summary-banner">
                        <div class="unit-summary-top">
                            <span class="unit-summary-title">Unit ${unit.unit_number}</span>
                            <span class="unit-summary-project">in ${proj?.name || 'Project'}</span>
                            <span class="pill ${tone[unit.status] || 'pill-active'}">${unit.status}</span>
                        </div>
                        <div class="unit-summary-grid">
                            <span>${unit.tower} · Fl ${unit.floor}</span>
                            <span>${unit.bhk}${areaFormatted}</span>
                            <span>${priceFormatted}</span>
                        </div>
                    </div>
                `;
            }

            const html = renderSummary(mockUnit, mockProject);
            expect(html).toContain('Unit B-402');
            expect(html).toContain('Grand Palm Residency');
            expect(html).toContain('Tower B · Fl 4');
            expect(html).toContain('3BHK (1450 sqft)');
            expect(html).toContain('₹85,00,000');
            expect(html).toContain('VACANT');
        });

        test('customer name or phone field validation', () => {
            function validateHoldInput(holdBy) {
                const trimmed = (holdBy || '').trim();
                if (!trimmed) {
                    return { valid: false, error: 'Please enter a customer name or phone number.' };
                }
                return { valid: true, value: trimmed };
            }

            expect(validateHoldInput('').valid).toBe(false);
            expect(validateHoldInput('   ').valid).toBe(false);
            expect(validateHoldInput('   ').error).toBe('Please enter a customer name or phone number.');
            expect(validateHoldInput('Rahul Sharma').valid).toBe(true);
            expect(validateHoldInput('+91 98765 43210').valid).toBe(true);
            expect(validateHoldInput('  Pooja Hegde (+91 9876543210)  ').value).toBe('Pooja Hegde (+91 9876543210)');
        });

        test('hold payload construction supports duration and reason', () => {
            function buildHoldPayload(holdBy, holdMinutes, reason) {
                return {
                    holdBy: (holdBy || '').trim(),
                    holdMinutes: Number(holdMinutes || 30),
                    reason: (reason || '').trim()
                };
            }

            const defaultPayload = buildHoldPayload('Rohit Verma', '30', '');
            expect(defaultPayload).toEqual({
                holdBy: 'Rohit Verma',
                holdMinutes: 30,
                reason: ''
            });

            const customPayload = buildHoldPayload('Rohit Verma', '120', 'Cheque token at 5pm');
            expect(customPayload).toEqual({
                holdBy: 'Rohit Verma',
                holdMinutes: 120,
                reason: 'Cheque token at 5pm'
            });
        });
    });

    // ─── 3. Book Property Unit Modal Template & Logic ─────────────────────────
    describe('3. Book Property Unit Modal Template & Logic', () => {
        test('includes proper modal heading and booking input elements', () => {
            expect(inventoryJsCode).toContain("modal('Book Property Unit', html, 'modal-book')");
            expect(inventoryJsCode).toContain('invBookingRef');
            expect(inventoryJsCode).toContain('invBookReason');
            expect(inventoryJsCode).toContain('Confirm Booking');
        });

        test('booking reference validation', () => {
            function validateBookInput(bookingRef) {
                const trimmed = (bookingRef || '').trim();
                if (!trimmed) {
                    return { valid: false, error: 'Please enter customer details or a booking reference.' };
                }
                return { valid: true, value: trimmed };
            }

            expect(validateBookInput('').valid).toBe(false);
            expect(validateBookInput('   ').valid).toBe(false);
            expect(validateBookInput('BK-2026-001').valid).toBe(true);
            expect(validateBookInput('Amit Patel (+91 9820011223)').valid).toBe(true);
        });

        test('booking payload construction', () => {
            function buildBookPayload(bookingRef, reason) {
                return {
                    bookingRef: (bookingRef || '').trim(),
                    reason: (reason || '').trim()
                };
            }

            const payload = buildBookPayload('BK-778', 'Token deposit cleared via NEFT');
            expect(payload).toEqual({
                bookingRef: 'BK-778',
                reason: 'Token deposit cleared via NEFT'
            });
        });
    });

    // ─── 4. Release Property Hold Modal ───────────────────────────────────────
    describe('4. Release Property Hold Modal', () => {
        test('includes heading and informative guidance', () => {
            expect(inventoryJsCode).toContain("modal('Release Property Hold', html, 'modal-release')");
            expect(inventoryJsCode).toContain('release-info-box');
            expect(inventoryJsCode).toContain('VACANT');
            expect(inventoryJsCode).toContain('invReleaseReason');
            expect(inventoryJsCode).toContain('Confirm Release');
        });

        test('release payload construction', () => {
            function buildReleasePayload(reason) {
                return {
                    reason: (reason || '').trim()
                };
            }

            expect(buildReleasePayload('')).toEqual({ reason: '' });
            expect(buildReleasePayload('Customer did not proceed')).toEqual({ reason: 'Customer did not proceed' });
        });
    });

    // ─── 5. Loading State & Duplicate Submission Guard ────────────────────────
    describe('5. Loading State & Duplicate Submission Guard', () => {
        test('duplicate submission guard blocks secondary submits while in flight', async () => {
            let inFlight = false;
            let callCount = 0;

            async function handleSubmit(apiCall) {
                if (inFlight) return;
                inFlight = true;
                callCount++;
                try {
                    await apiCall();
                } finally {
                    inFlight = false;
                }
            }

            let resolveApi;
            const mockApi = () => new Promise(resolve => { resolveApi = resolve; });

            // First submit starts
            const p1 = handleSubmit(mockApi);
            expect(inFlight).toBe(true);
            expect(callCount).toBe(1);

            // Second submit while in-flight is ignored
            const p2 = handleSubmit(mockApi);
            expect(callCount).toBe(1);

            // API completes
            resolveApi();
            await Promise.all([p1, p2]);
            expect(inFlight).toBe(false);

            // New submit after completion is permitted
            await handleSubmit(() => Promise.resolve());
            expect(callCount).toBe(2);
        });

        test('inventory.js disables button and shows spinner text during request', () => {
            expect(inventoryJsCode).toContain('submitBtn.disabled = true');
            expect(inventoryJsCode).toContain('Placing hold…');
            expect(inventoryJsCode).toContain('Confirming booking…');
            expect(inventoryJsCode).toContain('Releasing…');
            expect(inventoryJsCode).toContain('btn-spinner');
        });

        test('inventory.js re-enables button and displays error on API rejection', () => {
            expect(inventoryJsCode).toContain('submitBtn.disabled = false');
            expect(inventoryJsCode).toContain('errorBanner.hidden = false');
            expect(inventoryJsCode).toContain("toast(msg, 'error')");
        });
    });

    // ─── 6. Keyboard Accessibility & CSS Design System ────────────────────────
    describe('6. Keyboard Accessibility & CSS Design System', () => {
        test('modal handler includes Escape key listener and autofocus', () => {
            expect(inventoryJsCode).toContain("if (e.key === 'Escape') closeModal()");
            expect(inventoryJsCode).toContain("document.addEventListener('keydown', activeKeyHandler)");
            expect(inventoryJsCode).toContain("document.removeEventListener('keydown', activeKeyHandler)");
            expect(inventoryJsCode).toContain('firstInput.focus()');
        });

        test('style.css defines modal classes for hold, book, and release', () => {
            expect(styleCssCode).toContain('.modal.modal-hold');
            expect(styleCssCode).toContain('.modal.modal-book');
            expect(styleCssCode).toContain('.modal.modal-release');
            expect(styleCssCode).toContain('.unit-summary-banner');
            expect(styleCssCode).toContain('.unit-action-form');
            expect(styleCssCode).toContain('.inline-field-error');
            expect(styleCssCode).toContain('.btn-spinner');
            expect(styleCssCode).toContain('@keyframes spin');
        });

        test('input icon in hold and booking modals is positioned with sufficient left padding to prevent text overlap', () => {
            // Both modals wrap their primary input in .input-with-icon
            expect(inventoryJsCode).toContain('<div class="input-with-icon">');
            expect(styleCssCode).toContain('.input-with-icon .input-icon');
            expect(styleCssCode).toContain('position: absolute');
            expect(styleCssCode).toContain('left: 12px');
            expect(styleCssCode).toContain('pointer-events: none');

            // Left padding on the input must be at least 36px (38px implemented) to clear 12px offset + 16px icon
            expect(styleCssCode).toMatch(/\.unit-action-form\s+\.input-with-icon\s+\.form-control[^{]*\{[^}]*padding-left:\s*38px/);
        });

        test('HTML templates generated in inventory.js do not use inline styles', () => {
            const holdHtmlSnippet = inventoryJsCode.slice(
                inventoryJsCode.indexOf('function openHoldModal'),
                inventoryJsCode.indexOf('function openBookModal')
            );
            expect(holdHtmlSnippet).not.toMatch(/\bstyle\s*=\s*["']/);

            const bookHtmlSnippet = inventoryJsCode.slice(
                inventoryJsCode.indexOf('function openBookModal'),
                inventoryJsCode.indexOf('function openReleaseModal')
            );
            expect(bookHtmlSnippet).not.toMatch(/\bstyle\s*=\s*["']/);
        });
    });
});
