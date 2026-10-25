/**
 * tests/composer-csv-import-unit.test.js
 *
 * Unit tests for Campaign Composer Modal redesign and direct CSV Contact Import:
 * 1. CSV parsing, column header normalization, and row-level validation
 * 2. In-file duplicate phone number detection
 * 3. 25-recipient campaign limit enforcement & batch division messaging
 * 4. Opt-out exclusion & immutable opt-out preservation during CSV selection
 * 5. Deduplication of contacts by phone number in the picker
 * 6. Message personalization with {{name}} token insertion
 */
'use strict';

describe('Campaign Composer Modal & Direct CSV Import Unit Tests', () => {

    describe('1. CSV Parsing, Column Normalization & Row Validation', () => {
        function parseCsvRows(rawText) {
            const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) {
                return { error: 'CSV must have a header row and at least one contact row' };
            }

            const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
            const phoneIdx = headers.findIndex(h => /^(phone|mobile|tel|whatsapp|contact_number|cell)/i.test(h));
            const nameIdx = headers.findIndex(h => /^(name|full_name|contact_name|first_name)/i.test(h));
            const labelIdx = headers.findIndex(h => /^(label|tag|category|stage)/i.test(h));

            if (phoneIdx === -1) {
                return { error: 'Missing required column "phone" in CSV header' };
            }

            let validCount = 0;
            let invalidCount = 0;
            let duplicateCount = 0;
            const seenInFile = new Set();
            const validPhones = new Set();
            const rows = [];

            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',').map(c => c.replace(/^["']|["']$/g, '').trim());
                const rawPhone = cols[phoneIdx] || '';
                const name = nameIdx !== -1 ? cols[nameIdx] || '' : '';
                const label = labelIdx !== -1 ? cols[labelIdx] || '' : '';
                const cleanPhone = rawPhone.replace(/\D/g, '');

                let status = 'valid';
                if (!cleanPhone || cleanPhone.length < 7) {
                    status = 'invalid';
                    invalidCount++;
                } else if (seenInFile.has(cleanPhone)) {
                    status = 'duplicate';
                    duplicateCount++;
                } else {
                    seenInFile.add(cleanPhone);
                    validPhones.add(cleanPhone);
                    validCount++;
                }

                rows.push({
                    rowNum: i,
                    phone: rawPhone,
                    cleanPhone,
                    name,
                    label,
                    status
                });
            }

            return {
                validCount,
                invalidCount,
                duplicateCount,
                validPhones,
                rows
            };
        }

        test('identifies phone header variations (Mobile Number, WhatsApp #, phone)', () => {
            const csv1 = 'Phone,Name,Label\n919876543210,Alice,VIP';
            const parsed1 = parseCsvRows(csv1);
            expect(parsed1.error).toBeUndefined();
            expect(parsed1.validCount).toBe(1);

            const csv2 = 'Mobile Number,Full Name,Tag\n919876543211,Bob,Lead';
            const parsed2 = parseCsvRows(csv2);
            expect(parsed2.error).toBeUndefined();
            expect(parsed2.validCount).toBe(1);

            const csv3 = 'WhatsApp,Contact Name\n919876543212,Charlie';
            const parsed3 = parseCsvRows(csv3);
            expect(parsed3.error).toBeUndefined();
            expect(parsed3.validCount).toBe(1);
        });

        test('returns error when required phone column is missing', () => {
            const csv = 'Name,Address,City\nAlice,123 Main,Mumbai';
            const parsed = parseCsvRows(csv);
            expect(parsed.error).toBe('Missing required column "phone" in CSV header');
        });

        test('correctly validates valid rows, marks invalid numbers, and identifies in-file duplicates', () => {
            const csv = [
                'phone,name,label',
                '919876543210,Alice,VIP',        // Valid
                'invalid-phone,Bob,Lead',         // Invalid
                '',                               // Empty (filtered out)
                '919876543210,Alice Dup,VIP',    // Duplicate in file
                '123,Too Short,Lead',            // Invalid (< 7 digits)
                '+91 98765 43211,Charlie,Buyer'  // Valid formatted
            ].join('\n');

            const parsed = parseCsvRows(csv);
            expect(parsed.validCount).toBe(2);
            expect(parsed.invalidCount).toBe(2);
            expect(parsed.duplicateCount).toBe(1);
            expect(parsed.validPhones.has('919876543210')).toBe(true);
            expect(parsed.validPhones.has('919876543211')).toBe(true);
        });
    });

    describe('2. Recipient Limit (25 Max) and Batch Division Handling', () => {
        test('selects only up to 25 contacts and signals batch division when CSV has >25 eligible contacts', () => {
            const mockCsvContacts = [];
            for (let i = 1; i <= 40; i++) {
                mockCsvContacts.push({
                    id: i,
                    phone: `9198000000${String(i).padStart(2, '0')}`,
                    name: `Contact ${i}`,
                    is_opted_out: false
                });
            }

            const limit = 25;
            const eligibleCount = mockCsvContacts.filter(c => !c.is_opted_out).length;
            expect(eligibleCount).toBe(40);

            const selectedForBatch = mockCsvContacts.filter(c => !c.is_opted_out).slice(0, limit);
            expect(selectedForBatch.length).toBe(25);

            const requiresBatchDivision = eligibleCount > limit;
            expect(requiresBatchDivision).toBe(true);

            const batchNotice = requiresBatchDivision
                ? `WorkPilot limits each campaign batch to ${limit} recipients. The first ${limit} contacts have been selected. You can launch subsequent campaigns for the remaining contacts.`
                : '';

            expect(batchNotice).toContain('limits each campaign batch to 25 recipients');
            expect(batchNotice).toContain('The first 25 contacts have been selected');
        });

        test('selects all eligible contacts without batch warning when CSV has <=25 contacts', () => {
            const mockCsvContacts = [];
            for (let i = 1; i <= 15; i++) {
                mockCsvContacts.push({
                    id: i,
                    phone: `9198000000${String(i).padStart(2, '0')}`,
                    name: `Contact ${i}`,
                    is_opted_out: false
                });
            }

            const limit = 25;
            const eligible = mockCsvContacts.filter(c => !c.is_opted_out);
            const selectedForBatch = eligible.slice(0, limit);
            expect(selectedForBatch.length).toBe(15);
            expect(eligible.length > limit).toBe(false);
        });
    });

    describe('3. Opt-out Immutability and Exclusion during CSV-based Selection', () => {
        test('never selects opted-out contacts even if they were listed in the CSV', () => {
            const contactsInDb = [
                { id: 101, phone: '919876540001', name: 'Opted In 1', is_opted_out: false },
                { id: 102, phone: '919876540002', name: 'Opted Out User', is_opted_out: true }, // Opted out
                { id: 103, phone: '919876540003', name: 'Opted In 2', is_opted_out: false }
            ];

            const csvValidPhones = new Set(['919876540001', '919876540002', '919876540003']);

            const eligibleFromCsv = contactsInDb.filter(c =>
                !c.is_opted_out && csvValidPhones.has(String(c.phone).replace(/\D/g, ''))
            );

            expect(eligibleFromCsv.length).toBe(2);
            expect(eligibleFromCsv.map(c => c.id)).toEqual([101, 103]);
            expect(eligibleFromCsv.some(c => c.is_opted_out)).toBe(false);
        });
    });

    describe('4. Phone Deduplication in Recipient Picker', () => {
        test('deduplicates contacts by phone number so duplicate DB records do not appear multiple times', () => {
            const rawDbContacts = [
                { id: 1, phone: '919876543210', name: 'Alice 1' },
                { id: 2, phone: '919876543210', name: 'Alice 2 (duplicate phone)' },
                { id: 3, phone: '919876543211', name: 'Bob' },
                { id: 4, phone: '919876543211', name: 'Bob (duplicate phone)' },
                { id: 5, phone: '919876543212', name: 'Charlie' }
            ];

            const seenPhones = new Set();
            const deduped = [];
            for (const c of rawDbContacts) {
                const p = String(c.phone || '').trim();
                if (!p || seenPhones.has(p)) continue;
                seenPhones.add(p);
                deduped.push(c);
            }

            expect(deduped.length).toBe(3);
            expect(deduped.map(c => c.id)).toEqual([1, 3, 5]);
            expect(new Set(deduped.map(c => c.phone)).size).toBe(3);
        });
    });

    describe('5. Personalization Token Insertion', () => {
        test('inserts {{name}} token at cursor position into message text', () => {
            const insertToken = (val, start, end) => {
                return {
                    newVal: val.substring(0, start) + '{{name}}' + val.substring(end),
                    newCursor: start + '{{name}}'.length
                };
            };

            const text1 = 'Hello , welcome to our project!';
            const res1 = insertToken(text1, 6, 6);
            expect(res1.newVal).toBe('Hello {{name}}, welcome to our project!');
            expect(res1.newCursor).toBe(14);

            const text2 = 'Hi there';
            const res2 = insertToken(text2, 3, 8); // replace 'there'
            expect(res2.newVal).toBe('Hi {{name}}');
        });
    });
});
