/**
 * tests/inventory.test.js
 *
 * Tests for Item 2: inventory schema, API, and business rules.
 *
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wa_test \
 *   ALLOW_DESTRUCTIVE_TESTING=true BCRYPT_ROUNDS=4 DISABLE_RATE_LIMITS=true \
 *   npx jest tests/inventory.test.js --forceExit
 */
'use strict';

const request = require('supertest');

jest.mock('../src/services/messaging', () => {
    const actual = jest.requireActual('../src/services/messaging');
    return { ...actual, sendMedia: jest.fn().mockResolvedValue({ waMessageId: 'mock-media-id', sizeBytes: 12, fileName: 'test.pdf' }) };
});

describe('Inventory — projects, units, status transitions, assets', () => {
    let app, tenantA, tenantB;

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
        tenantA = await signup(app, { email: `inv_a_${Date.now()}@example.com` });
        tenantB = await signup(app, { email: `inv_b_${Date.now()}@example.com` });
    });

    // ─── Helper ───────────────────────────────────────────────────────────
    async function makeProject(cookie, overrides = {}) {
        const res = await request(app).post('/api/inventory/projects')
            .set('Cookie', cookie)
            .send({ name: 'Test Project', city: 'Ranchi', propertyType: 'residential', ...overrides });
        expect(res.status).toBe(200);
        return res.body.data;
    }

    async function makeUnit(cookie, projectId, overrides = {}) {
        const res = await request(app)
            .post(`/api/inventory/projects/${projectId}/units`)
            .set('Cookie', cookie)
            .send({ unit_number: `U${Date.now()}`, bhk: '3BHK', price: 5000000, tower: 'A', ...overrides });
        expect(res.status).toBe(200);
        return res.body.data;
    }

    // ─── Projects CRUD ────────────────────────────────────────────────────
    describe('Projects CRUD', () => {
        test('creates a project and lists it', async () => {
            const proj = await makeProject(tenantA.cookie, {
                name: 'Sunrise Towers', city: 'Ranchi', reraStatus: 'verified'
            });
            expect(proj.id).toBeTruthy();
            expect(proj.city).toBe('Ranchi');
            expect(proj.rera_status).toBe('verified');

            const list = await request(app).get('/api/inventory/projects').set('Cookie', tenantA.cookie);
            expect(list.body.data).toHaveLength(1);
        });

        test('GET /projects/:id returns 404 for unknown project', async () => {
            const r = await request(app).get('/api/inventory/projects/99999').set('Cookie', tenantA.cookie);
            expect(r.status).toBe(404);
        });

        test('updates project fields', async () => {
            const proj = await makeProject(tenantA.cookie);
            const r = await request(app).put(`/api/inventory/projects/${proj.id}`)
                .set('Cookie', tenantA.cookie)
                .send({ city: 'Jamshedpur', reraNumber: 'JH/RERA/001' });
            expect(r.status).toBe(200);
            expect(r.body.data.city).toBe('Jamshedpur');
        });

        test('deletes a project', async () => {
            const proj = await makeProject(tenantA.cookie);
            await request(app).delete(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantA.cookie).expect(200);
            await request(app).get(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantA.cookie).expect(404);
        });

        test('project requires name', async () => {
            const r = await request(app).post('/api/inventory/projects')
                .set('Cookie', tenantA.cookie).send({ city: 'Ranchi' });
            expect(r.status).toBe(400);
        });
    });

    describe('Manual project asset delivery', () => {
        test('sends only the caller tenant’s asset for the selected project', async () => {
            const { createMediaAsset } = require('../src/services/database');
            const { sendMedia } = require('../src/services/messaging');
            const project = await makeProject(tenantA.cookie);
            const asset = await createMediaAsset(tenantA.user.id, {
                projectId: project.id, assetType: 'brochure', fileName: 'test.pdf',
                storagePath: 'C:/test-assets/test.pdf', mimeType: 'application/pdf', sizeBytes: 12
            });

            const response = await request(app)
                .post(`/api/inventory/projects/${project.id}/assets/${asset.id}/send`)
                .set('Cookie', tenantA.cookie)
                .set('Idempotency-Key', 'asset-send-once')
                .send({ phone: '919876543210', caption: 'Project brochure' });

            expect(response.status).toBe(200);
            expect(sendMedia).toHaveBeenCalledWith(tenantA.user.id, '919876543210', expect.objectContaining({
                filePath: 'C:/test-assets/test.pdf', mimeType: 'application/pdf', caption: 'Project brochure', idempotencyKey: 'asset-send-once'
            }));
        });

        test('forwards the same caller idempotency key on a retry', async () => {
            const { createMediaAsset } = require('../src/services/database');
            const { sendMedia } = require('../src/services/messaging');
            const project = await makeProject(tenantA.cookie);
            const asset = await createMediaAsset(tenantA.user.id, {
                projectId: project.id, assetType: 'brochure', fileName: 'retry.pdf',
                storagePath: 'C:/test-assets/retry.pdf', mimeType: 'application/pdf', sizeBytes: 12
            });
            const requestBody = { phone: '919876543210' };
            const first = await request(app).post(`/api/inventory/projects/${project.id}/assets/${asset.id}/send`)
                .set('Cookie', tenantA.cookie).set('Idempotency-Key', 'retry-key').send(requestBody);
            const second = await request(app).post(`/api/inventory/projects/${project.id}/assets/${asset.id}/send`)
                .set('Cookie', tenantA.cookie).set('Idempotency-Key', 'retry-key').send(requestBody);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(sendMedia.mock.calls.filter(([, , opts]) => opts.idempotencyKey === 'retry-key')).toHaveLength(2);
        });

        test('does not allow a different tenant to send another tenant’s asset', async () => {
            const { createMediaAsset } = require('../src/services/database');
            const { sendMedia } = require('../src/services/messaging');
            const project = await makeProject(tenantA.cookie);
            const asset = await createMediaAsset(tenantA.user.id, {
                projectId: project.id, assetType: 'brochure', fileName: 'private.pdf',
                storagePath: 'C:/test-assets/private.pdf', mimeType: 'application/pdf', sizeBytes: 12
            });
            const response = await request(app)
                .post(`/api/inventory/projects/${project.id}/assets/${asset.id}/send`)
                .set('Cookie', tenantB.cookie)
                .send({ phone: '919876543210' });
            expect(response.status).toBe(404);
            expect(sendMedia).not.toHaveBeenCalledWith(tenantB.user.id, expect.anything(), expect.anything());
        });

        test('enforces the sender monthly message limit before sending an asset', async () => {
            const { createMediaAsset, logMessage, updateUser } = require('../src/services/database');
            const { sendMedia } = require('../src/services/messaging');
            const project = await makeProject(tenantA.cookie);
            const asset = await createMediaAsset(tenantA.user.id, {
                projectId: project.id, assetType: 'brochure', fileName: 'limited.pdf',
                storagePath: 'C:/test-assets/limited.pdf', mimeType: 'application/pdf', sizeBytes: 12
            });
            await updateUser(tenantA.user.id, { message_limit: 1 });
            await logMessage(tenantA.user.id, {
                phone: '919876543210', direction: 'outgoing', messageType: 'text', body: 'Already sent'
            });

            const response = await request(app)
                .post(`/api/inventory/projects/${project.id}/assets/${asset.id}/send`)
                .set('Cookie', tenantA.cookie)
                .set('Idempotency-Key', 'monthly-limit-key')
                .send({ phone: '919876543210' });

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('MESSAGE_LIMIT');
            expect(sendMedia).not.toHaveBeenCalledWith(tenantA.user.id, expect.anything(), expect.anything());
        });
    });

    // ─── Tenant isolation ─────────────────────────────────────────────────
    describe('Tenant isolation', () => {
        test('tenant B cannot read tenant A project', async () => {
            const proj = await makeProject(tenantA.cookie);
            const r = await request(app).get(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantB.cookie);
            expect(r.status).toBe(404);
        });

        test('tenant B cannot update tenant A project', async () => {
            const proj = await makeProject(tenantA.cookie);
            const r = await request(app).put(`/api/inventory/projects/${proj.id}`)
                .set('Cookie', tenantB.cookie).send({ city: 'HACKED' });
            expect(r.status).toBe(404);
            // A's project unchanged
            const check = await request(app).get(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantA.cookie);
            expect(check.body.data.city).toBe('Ranchi');
        });

        test('tenant B cannot delete tenant A project', async () => {
            const proj = await makeProject(tenantA.cookie);
            await request(app).delete(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantB.cookie).expect(404);
            await request(app).get(`/api/inventory/projects/${proj.id}`).set('Cookie', tenantA.cookie).expect(200);
        });

        test('tenant B cannot list tenant A units', async () => {
            const proj = await makeProject(tenantA.cookie);
            await makeUnit(tenantA.cookie, proj.id);
            const r = await request(app)
                .get(`/api/inventory/projects/${proj.id}/units`).set('Cookie', tenantB.cookie);
            expect(r.status).toBe(404); // B doesn't own the project
        });

        test('tenant B cannot hold tenant A unit', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            const r = await request(app).post(`/api/inventory/units/${unit.id}/hold`)
                .set('Cookie', tenantB.cookie).send({ holdBy: 'B attacker' });
            expect(r.status).toBe(404);
            // A's unit still VACANT
            const { getUnitById } = require('../src/services/database');
            const fresh = await getUnitById(tenantA.user.id, unit.id);
            expect(fresh.status).toBe('VACANT');
        });

        test('search endpoint returns only caller tenant units', async () => {
            const projA = await makeProject(tenantA.cookie, { city: 'Ranchi', name: 'Project Alpha' });
            const projB = await makeProject(tenantB.cookie, { city: 'Ranchi', name: 'Project Beta' });
            await makeUnit(tenantA.cookie, projA.id, { bhk: '2BHK', price: 3000000 });
            await makeUnit(tenantB.cookie, projB.id, { bhk: '2BHK', price: 3000000 });

            const rA = await request(app).get('/api/inventory/units/search?city=Ranchi').set('Cookie', tenantA.cookie);
            const rB = await request(app).get('/api/inventory/units/search?city=Ranchi').set('Cookie', tenantB.cookie);

            expect(rA.body.data).toHaveLength(1);
            expect(rB.body.data).toHaveLength(1);
            // Each tenant sees their own project
            expect(rA.body.data[0].project_name).toBe('Project Alpha');
            expect(rB.body.data[0].project_name).toBe('Project Beta');
        });
    });

    // ─── Unit status transitions ───────────────────────────────────────────
    describe('Unit status transitions', () => {
        test('VACANT → ON_HOLD → BOOKED is valid', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);

            await request(app).post(`/api/inventory/units/${unit.id}/hold`)
                .set('Cookie', tenantA.cookie)
                .send({ holdBy: 'Buyer X', holdMinutes: 30 }).expect(200);

            const r = await request(app).post(`/api/inventory/units/${unit.id}/book`)
                .set('Cookie', tenantA.cookie)
                .send({ bookingRef: 'BK2026001' });
            expect(r.status).toBe(200);
            expect(r.body.data.status).toBe('BOOKED');
            expect(r.body.data.booking_ref).toBe('BK2026001');
        });

        test('VACANT → BOOKED direct transition is valid', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            const r = await request(app).post(`/api/inventory/units/${unit.id}/book`)
                .set('Cookie', tenantA.cookie).send({});
            expect(r.status).toBe(200);
            expect(r.body.data.status).toBe('BOOKED');
        });

        test('BOOKED → ON_HOLD is invalid (409)', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            await request(app).post(`/api/inventory/units/${unit.id}/book`)
                .set('Cookie', tenantA.cookie).send({}).expect(200);
            const r = await request(app).post(`/api/inventory/units/${unit.id}/hold`)
                .set('Cookie', tenantA.cookie).send({});
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('INVALID_TRANSITION');
        });

        test('release returns ON_HOLD unit to VACANT', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            await request(app).post(`/api/inventory/units/${unit.id}/hold`)
                .set('Cookie', tenantA.cookie).send({}).expect(200);
            const r = await request(app).post(`/api/inventory/units/${unit.id}/release`)
                .set('Cookie', tenantA.cookie).send({});
            expect(r.status).toBe(200);
            expect(r.body.data.status).toBe('VACANT');
        });
    });

    describe('Unit editing, deletion, and history', () => {
        test('updates editable unit fields but not its status', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id, { unit_number: 'E-101', area: 950, price: 4500000 });
            const response = await request(app).put(`/api/inventory/units/${unit.id}`)
                .set('Cookie', tenantA.cookie)
                .send({ tower: 'B', unit_number: 'E-102', bhk: '2BHK', area: 1050, areaUnit: 'sqm', price: 4800000, floor: 4, status: 'BOOKED' });

            expect(response.status).toBe(200);
            expect(response.body.data).toMatchObject({ tower: 'B', unit_number: 'E-102', bhk: '2BHK', area_unit: 'sqm', floor: 4, status: 'VACANT' });
            expect(Number(response.body.data.area)).toBe(1050);
            expect(Number(response.body.data.price)).toBe(4800000);
        });

        test('validates unit edit input', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            await request(app).put(`/api/inventory/units/${unit.id}`).set('Cookie', tenantA.cookie)
                .send({ unit_number: '   ' }).expect(400);
            await request(app).put(`/api/inventory/units/${unit.id}`).set('Cookie', tenantA.cookie)
                .send({ areaUnit: 'acre' }).expect(400);
        });

        test('soft-deletes a vacant unit and no longer exposes it', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            await request(app).delete(`/api/inventory/units/${unit.id}`).set('Cookie', tenantA.cookie).expect(200);
            await request(app).get(`/api/inventory/units/${unit.id}`).set('Cookie', tenantA.cookie).expect(404);
            const list = await request(app).get(`/api/inventory/projects/${proj.id}/units`).set('Cookie', tenantA.cookie);
            expect(list.body.data).toHaveLength(0);
        });

        test('blocks deletion while a hold or booking is active', async () => {
            const proj = await makeProject(tenantA.cookie);
            const held = await makeUnit(tenantA.cookie, proj.id, { unit_number: 'H-101' });
            await request(app).post(`/api/inventory/units/${held.id}/hold`).set('Cookie', tenantA.cookie).send({ holdBy: 'Buyer' }).expect(200);
            const heldDelete = await request(app).delete(`/api/inventory/units/${held.id}`).set('Cookie', tenantA.cookie);
            expect(heldDelete.status).toBe(409);
            expect(heldDelete.body.code).toBe('UNIT_ACTIVE_RESERVATION');

            const booked = await makeUnit(tenantA.cookie, proj.id, { unit_number: 'B-101' });
            await request(app).post(`/api/inventory/units/${booked.id}/book`).set('Cookie', tenantA.cookie).send({ bookingRef: 'BK-1' }).expect(200);
            await request(app).delete(`/api/inventory/units/${booked.id}`).set('Cookie', tenantA.cookie).expect(409);
        });

        test('returns the tenant-scoped status history with actor and reason', async () => {
            const proj = await makeProject(tenantA.cookie);
            const unit = await makeUnit(tenantA.cookie, proj.id);
            await request(app).post(`/api/inventory/units/${unit.id}/hold`)
                .set('Cookie', tenantA.cookie).send({ holdBy: 'Buyer', reason: 'Requested a day to decide' }).expect(200);

            const ownHistory = await request(app).get(`/api/inventory/units/${unit.id}/history`).set('Cookie', tenantA.cookie);
            expect(ownHistory.status).toBe(200);
            expect(ownHistory.body.data[0]).toMatchObject({ old_status: 'VACANT', new_status: 'ON_HOLD', changed_by: String(tenantA.user.id), reason: 'Requested a day to decide' });
            await request(app).get(`/api/inventory/units/${unit.id}/history`).set('Cookie', tenantB.cookie).expect(404);
        });
    });

    // ─── Double-hold concurrency ───────────────────────────────────────────
    describe('Double-hold concurrency', () => {
        test('two concurrent holds on the same unit — exactly one succeeds', async () => {
            const { createUser, saveAvailabilitySettings,
                    createProject: dbCreateProject,
                    createUnit: dbCreateUnit,
                    transitionUnitStatus } = require('../src/services/database');

            const proj = await dbCreateProject(tenantA.user.id, {
                name: 'Concurrent Test', propertyType: 'residential'
            });
            const unit = await dbCreateUnit(tenantA.user.id, proj.id, {
                unitNumber: 'C101', bhk: '2BHK', price: 3000000
            });

            const holdArgs = {
                holdExpiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
                holdBy: 'Test',
                changedBy: 'test'
            };

            const [r1, r2] = await Promise.all([
                transitionUnitStatus(tenantA.user.id, unit.id, 'ON_HOLD', holdArgs)
                    .then(u => ({ ok: true, status: u.status }))
                    .catch(e => ({ ok: false, code: e.code })),
                transitionUnitStatus(tenantA.user.id, unit.id, 'ON_HOLD', holdArgs)
                    .then(u => ({ ok: true, status: u.status }))
                    .catch(e => ({ ok: false, code: e.code }))
            ]);

            const successes = [r1, r2].filter(r => r.ok);
            const failures  = [r1, r2].filter(r => !r.ok);
            expect(successes).toHaveLength(1);
            expect(failures).toHaveLength(1);
            expect(failures[0].code).toBe('INVALID_TRANSITION');
        });
    });

    // ─── Hold expiry ──────────────────────────────────────────────────────
    describe('Hold expiry', () => {
        test('expired hold is reverted to VACANT by expireStaleHolds()', async () => {
            const { createProject: dbCreateProject, createUnit: dbCreateUnit,
                    transitionUnitStatus, expireStaleHolds, getUnitById } = require('../src/services/database');

            const proj = await dbCreateProject(tenantA.user.id, { name: 'Expiry Test', propertyType: 'residential' });
            const unit = await dbCreateUnit(tenantA.user.id, proj.id, { unitNumber: 'E101', bhk: '1BHK', price: 2000000 });

            // Set hold that already expired 1 second ago
            const expiredAt = new Date(Date.now() - 1000).toISOString();
            await transitionUnitStatus(tenantA.user.id, unit.id, 'ON_HOLD', {
                holdExpiresAt: expiredAt, holdBy: 'Expired Buyer'
            });

            const count = await expireStaleHolds(tenantA.user.id);
            expect(count).toBeGreaterThanOrEqual(1);

            const fresh = await getUnitById(tenantA.user.id, unit.id);
            expect(fresh.status).toBe('VACANT');
            expect(fresh.hold_by).toBe('');
            expect(fresh.hold_expires_at).toBeNull();
        });

        test('expireStaleHolds is idempotent — running twice gives same result', async () => {
            const { createProject: dbCP, createUnit: dbCU, transitionUnitStatus, expireStaleHolds } = require('../src/services/database');
            const proj = await dbCP(tenantA.user.id, { name: 'Idem Test', propertyType: 'residential' });
            const unit = await dbCU(tenantA.user.id, proj.id, { unitNumber: 'I101', bhk: '2BHK', price: 4000000 });
            await transitionUnitStatus(tenantA.user.id, unit.id, 'ON_HOLD', {
                holdExpiresAt: new Date(Date.now() - 1000).toISOString()
            });
            await expireStaleHolds(tenantA.user.id);
            const second = await expireStaleHolds(tenantA.user.id);
            expect(second).toBe(0); // nothing left to expire
        });

        test('non-expired hold is NOT reverted', async () => {
            const { createProject: dbCP, createUnit: dbCU, transitionUnitStatus, expireStaleHolds, getUnitById } = require('../src/services/database');
            const proj = await dbCP(tenantA.user.id, { name: 'Future Hold', propertyType: 'residential' });
            const unit = await dbCU(tenantA.user.id, proj.id, { unitNumber: 'F101', bhk: '3BHK', price: 6000000 });
            await transitionUnitStatus(tenantA.user.id, unit.id, 'ON_HOLD', {
                holdExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour from now
            });
            const count = await expireStaleHolds(tenantA.user.id);
            expect(count).toBe(0);
            const fresh = await getUnitById(tenantA.user.id, unit.id);
            expect(fresh.status).toBe('ON_HOLD');
        });
    });

    // ─── Search / filter ──────────────────────────────────────────────────
    describe('Unit search', () => {
        test('filters by BHK and price range', async () => {
            const proj = await makeProject(tenantA.cookie, { city: 'Ranchi' });
            await makeUnit(tenantA.cookie, proj.id, { bhk: '2BHK', price: 3000000, unit_number: 'S1' });
            await makeUnit(tenantA.cookie, proj.id, { bhk: '3BHK', price: 7000000, unit_number: 'S2' });

            const r = await request(app)
                .get('/api/inventory/units/search?bhk=2BHK&maxPrice=4000000')
                .set('Cookie', tenantA.cookie);
            expect(r.status).toBe(200);
            expect(r.body.data.every(u => u.bhk.toLowerCase() === '2bhk')).toBe(true);
            expect(r.body.data.every(u => u.price <= 4000000)).toBe(true);
        });
    });
});
