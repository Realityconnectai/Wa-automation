'use strict';

const request = require('supertest');
const {
    isPlausibleEpochMs,
    sanitizeOriginalFilename,
    resolveDisplayFilename,
    formatSafeContentDisposition
} = require('../src/utils/media-filename');
const { createMediaAsset, getMediaAssets, getMediaAssetById } = require('../src/services/database');
const { runSql } = require('../src/services/db-pool');

describe('Media Filename Resolution & Display Utilities', () => {
    describe('1. Server-Generated Storage Prefix Stripping vs Genuine User Filename Preservation', () => {
        test('recovers clean original filename from legacy server-generated storage filenames', () => {
            // Real examples reported by user
            expect(resolveDisplayFilename('3_1791911107626_TECH_EVENTS.jpeg')).toBe('TECH_EVENTS.jpeg');
            expect(resolveDisplayFilename('3_1791911094601_WorkPilot_Solutions.pdf')).toBe('WorkPilot_Solutions.pdf');

            // With explicit userId check
            expect(resolveDisplayFilename('3_1791911107626_TECH_EVENTS.jpeg', 3)).toBe('TECH_EVENTS.jpeg');
            expect(resolveDisplayFilename('3_1791911094601_WorkPilot_Solutions.pdf', 3)).toBe('WorkPilot_Solutions.pdf');
        });

        test('preserves genuine user filenames containing leading numbers, dates, or underscores', () => {
            expect(resolveDisplayFilename('2026_Property_Brochure.pdf')).toBe('2026_Property_Brochure.pdf');
            expect(resolveDisplayFilename('2026_01_report.pdf')).toBe('2026_01_report.pdf');
            expect(resolveDisplayFilename('123_456_file.pdf')).toBe('123_456_file.pdf');
            expect(resolveDisplayFilename('1_2_test.png')).toBe('1_2_test.png');
            expect(resolveDisplayFilename('100_villas_overview.pdf')).toBe('100_villas_overview.pdf');
        });

        test('preserves genuine leading numbers even when nested inside a server-generated storage prefix', () => {
            expect(resolveDisplayFilename('3_1791911107626_2026_Property_Brochure.pdf', 3))
                .toBe('2026_Property_Brochure.pdf');
        });

        test('handles files with multiple dots, spaces, dashes and unicode correctly', () => {
            expect(resolveDisplayFilename('3_1791911107626_Floor.Plan.Final.v2.pdf', 3))
                .toBe('Floor.Plan.Final.v2.pdf');
            expect(resolveDisplayFilename('3_1791911107626_Villa_Brochure_日本語.pdf', 3))
                .toBe('Villa_Brochure_日本語.pdf');
        });

        test('handles invalid inputs gracefully', () => {
            expect(resolveDisplayFilename(null)).toBe('');
            expect(resolveDisplayFilename(undefined)).toBe('');
            expect(resolveDisplayFilename('')).toBe('');
            expect(resolveDisplayFilename('   ')).toBe('');
        });
    });

    describe('2. Sanitization of User Upload Original Filenames', () => {
        test('strips directory traversal components while preserving base filename', () => {
            expect(sanitizeOriginalFilename('../../etc/passwd.pdf')).toBe('passwd.pdf');
            expect(sanitizeOriginalFilename('..\\..\\Windows\\System32\\file.png')).toBe('file.png');
            expect(sanitizeOriginalFilename('/var/data/uploads/brochure.pdf')).toBe('brochure.pdf');
        });

        test('sanitizes unsafe filesystem characters and control characters', () => {
            expect(sanitizeOriginalFilename('WorkPilot <Solutions>: "Brochure"?.pdf'))
                .toBe('WorkPilot _Solutions__ _Brochure__.pdf');
        });

        test('preserves legitimate spaces, unicode characters, dots, and file extensions', () => {
            expect(sanitizeOriginalFilename('WorkPilot Solutions (2026).pdf'))
                .toBe('WorkPilot Solutions (2026).pdf');
            expect(sanitizeOriginalFilename('東京_Apartments_FloorPlan.pdf'))
                .toBe('東京_Apartments_FloorPlan.pdf');
        });
    });

    describe('3. Content-Disposition Safe Formatting', () => {
        test('formats attachment disposition with safe ASCII fallback and RFC 5987 UTF-8', () => {
            const header = formatSafeContentDisposition('attachment', 'WorkPilot Solutions (2026).pdf');
            expect(header).toContain('attachment;');
            expect(header).toContain('filename="WorkPilot Solutions (2026).pdf"');
            expect(header).toContain("filename*=UTF-8''WorkPilot%20Solutions%20(2026).pdf");
        });

        test('formats inline disposition safely without header injection', () => {
            const header = formatSafeContentDisposition('inline', 'test\r\ninjection.pdf');
            expect(header).not.toContain('\r');
            expect(header).not.toContain('\n');
            expect(header).toContain('inline;');
        });
    });

    describe('4. Regression: Existing Prefixed Asset Records in Database and API', () => {
        let app, tenant;

        beforeEach(async () => {
            await freshDatabase();
            app = createTestApp();
            tenant = await signup(app, { email: `prefix_test_${Date.now()}@example.com` });
        });

        test('correctly resolves display_name and file_name for existing prefixed records without altering storage_path', async () => {
            const projRes = await request(app).post('/api/inventory/projects')
                .set('Cookie', tenant.cookie)
                .send({ name: 'Sunset Residency', city: 'Mumbai', propertyType: 'residential' });
            expect(projRes.status).toBe(200);
            const projectId = projRes.body.data.id;

            const rawStorage1 = 'C:/WA REAL ESTATE/data/assets/3_1791911107626_TECH_EVENTS.jpeg';
            const rawStorage2 = 'C:/WA REAL ESTATE/data/assets/3_1791911094601_WorkPilot_Solutions.pdf';

            const asset1 = await createMediaAsset(tenant.user.id, {
                projectId,
                assetType: 'photo',
                fileName: '3_1791911107626_TECH_EVENTS.jpeg',
                storagePath: rawStorage1,
                mimeType: 'image/jpeg',
                sizeBytes: 102400
            });

            const asset2 = await createMediaAsset(tenant.user.id, {
                projectId,
                assetType: 'brochure',
                fileName: '3_1791911094601_WorkPilot_Solutions.pdf',
                storagePath: rawStorage2,
                mimeType: 'application/pdf',
                sizeBytes: 204800
            });

            // 1. Verify getMediaAssets directly from database service returns resolved names
            const dbAssets = await getMediaAssets(tenant.user.id, projectId);
            const dbAsset1 = dbAssets.find(a => a.id === asset1.id);
            const dbAsset2 = dbAssets.find(a => a.id === asset2.id);

            expect(dbAsset1.display_name).toBe('TECH_EVENTS.jpeg');
            expect(dbAsset1.file_name).toBe('TECH_EVENTS.jpeg');
            expect(dbAsset1.storage_path).toBe(rawStorage1);

            expect(dbAsset2.display_name).toBe('WorkPilot_Solutions.pdf');
            expect(dbAsset2.file_name).toBe('WorkPilot_Solutions.pdf');
            expect(dbAsset2.storage_path).toBe(rawStorage2);

            // 2. Verify getMediaAssetById
            const byId1 = await getMediaAssetById(tenant.user.id, asset1.id);
            expect(byId1.display_name).toBe('TECH_EVENTS.jpeg');
            expect(byId1.file_name).toBe('TECH_EVENTS.jpeg');
            expect(byId1.storage_path).toBe(rawStorage1);

            // 3. Verify GET /api/inventory/projects/:projectId/assets endpoint response
            const apiRes = await request(app)
                .get(`/api/inventory/projects/${projectId}/assets`)
                .set('Cookie', tenant.cookie);

            expect(apiRes.status).toBe(200);
            expect(apiRes.body.success).toBe(true);
            const fetched1 = apiRes.body.data.find(a => a.id === asset1.id);
            const fetched2 = apiRes.body.data.find(a => a.id === asset2.id);

            expect(fetched1.display_name).toBe('TECH_EVENTS.jpeg');
            expect(fetched1.file_name).toBe('TECH_EVENTS.jpeg');
            expect(fetched2.display_name).toBe('WorkPilot_Solutions.pdf');
            expect(fetched2.file_name).toBe('WorkPilot_Solutions.pdf');

            // 4. Verify GET /api/inventory/assets endpoint response
            const allAssetsRes = await request(app)
                .get('/api/inventory/assets')
                .set('Cookie', tenant.cookie);

            expect(allAssetsRes.status).toBe(200);
            const all1 = allAssetsRes.body.data.find(a => a.id === asset1.id);
            const all2 = allAssetsRes.body.data.find(a => a.id === asset2.id);

            expect(all1.display_name).toBe('TECH_EVENTS.jpeg');
            expect(all1.file_name).toBe('TECH_EVENTS.jpeg');
            expect(all2.display_name).toBe('WorkPilot_Solutions.pdf');
            expect(all2.file_name).toBe('WorkPilot_Solutions.pdf');

            // 5. Verify database storage_path was never mutated in Postgres table
            const [rawRow1] = (await runSql('SELECT file_name, storage_path FROM media_assets WHERE id=$1', [asset1.id])).rows;
            expect(rawRow1.storage_path).toBe(rawStorage1);
        });
    });
});

