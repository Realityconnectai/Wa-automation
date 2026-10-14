'use strict';

const { normalizeAnalysis, computeLeadTemp } = require('../src/services/lead-analyzer');

function analysis(overrides = {}) {
    return {
        interestStatus: 'interested', interestScore: 10, priority: 'low', suggestedStage: 'new',
        ...overrides
    };
}

describe('Real-estate qualification', () => {
    test.each([
        ['Hindi', {
            lead_type: 'buy', budget_min: '4500000', budget_max: '6000000', preferred_bhk: '2BHK',
            preferred_locality: 'रांची', timeline: '6 महीने', financing_needed: 'yes', site_visit_pref: 'रविवार'
        }, { leadType: 'buy', budgetMin: 4500000, budgetMax: 6000000, preferredBhk: '2BHK', preferredLocality: 'रांची', timeline: '6 महीने', financingNeeded: 'yes', siteVisitPref: 'रविवार' }],
        ['English', {
            lead_type: 'invest', budget_min: 8000000, budget_max: 10000000, preferred_bhk: '3BHK',
            preferred_locality: 'Kanke Road', timeline: 'immediately', financing_needed: 'no'
        }, { leadType: 'invest', budgetMin: 8000000, budgetMax: 10000000, preferredBhk: '3BHK', preferredLocality: 'Kanke Road', timeline: 'immediately', financingNeeded: 'no' }],
        ['Hinglish', {
            lead_type: 'rent', budget_min: '25000', budget_max: '35000', preferred_bhk: '2 bhk',
            preferred_locality: 'Ashok Nagar', timeline: 'next month', financing_needed: 'unknown'
        }, { leadType: 'rent', budgetMin: 25000, budgetMax: 35000, preferredBhk: '2 bhk', preferredLocality: 'Ashok Nagar', timeline: 'next month', financingNeeded: 'unknown' }]
    ])('%s sample normalizes real-estate fields', (_language, raw, expected) => {
        expect(normalizeAnalysis(raw, 1, 'Buyer')).toMatchObject(expected);
    });

    test('invalid model values are ignored rather than stored', () => {
        const normalized = normalizeAnalysis({ lead_type: 'broker', budget_min: '-1', interested_project_id: '2.5' }, 1, 'Buyer');
        expect(normalized.leadType).toBeNull();
        expect(normalized.budgetMin).toBeNull();
        expect(normalized.interestedProjectId).toBeNull();
    });

    test.each([
        ['HOT', analysis({ interestScore: 80 }), 'HOT'],
        ['WARM', analysis({ interestScore: 55 }), 'WARM'],
        ['COLD', analysis({ interestScore: 10 }), 'COLD']
    ])('%s temperature follows explicit rules', (_name, value, expected) => {
        const result = computeLeadTemp(value);
        expect(result.temp).toBe(expected);
        expect(result.reason).toMatch(/rule:/);
    });

    test('AI qualification values merge without null erasure and reject foreign projects', async () => {
        await freshDatabase();
        const db = require('../src/services/database');
        const tenantA = await createUserDirect();
        const tenantB = await createUserDirect();
        const projectA = await db.createProject(tenantA.user.id, { name: 'A Project' });
        const projectB = await db.createProject(tenantB.user.id, { name: 'B Project' });

        await db.aiUpsertCrmDeal(tenantA.user.id, '919800000001', {
            contactName: 'Buyer', suggestedStage: 'qualified', leadType: 'buy', budgetMin: 4500000,
            budgetMax: 6000000, preferredBhk: '2BHK', preferredLocality: 'Ranchi', timeline: '6 months',
            financingNeeded: 'yes', siteVisitPref: 'Sunday', interestedProjectId: projectA.id
        });
        await db.aiUpsertCrmDeal(tenantA.user.id, '919800000001', {
            leadType: null, budgetMin: null, budgetMax: null, preferredBhk: null,
            preferredLocality: null, timeline: null, financingNeeded: null,
            siteVisitPref: null, interestedProjectId: projectB.id
        });

        const deal = await db.getCrmDealByPhone(tenantA.user.id, '919800000001');
        expect(deal.lead_type).toBe('buy');
        expect(Number(deal.budget_min)).toBe(4500000);
        expect(deal.preferred_bhk).toBe('2BHK');
        expect(deal.interested_project_id).toBe(projectA.id);
    });

    test('manual qualification update is tenant-scoped and temperature remains deterministic', async () => {
        await freshDatabase();
        const db = require('../src/services/database');
        const tenantA = await createUserDirect();
        const tenantB = await createUserDirect();
        const projectA = await db.createProject(tenantA.user.id, { name: 'A Project' });
        const projectB = await db.createProject(tenantB.user.id, { name: 'B Project' });
        const deal = await db.createCrmDeal(tenantA.user.id, { phone: '919800000003', contactName: 'Buyer' });
        await db.updateCrmDeal(tenantA.user.id, deal.id, {
            lead_type: 'buy', budget_min: 100, budget_max: 200, preferred_bhk: '2BHK',
            preferred_locality: 'Ranchi', timeline: 'soon', financing_needed: 'yes',
            site_visit_pref: 'Sunday', interested_project_id: projectA.id
        });
        const updated = await db.getCrmDealById(tenantA.user.id, deal.id);
        expect(updated).toMatchObject({ lead_type: 'buy', preferred_bhk: '2BHK', interested_project_id: projectA.id });
        expect(updated.lead_temp).toBe('COLD');
        await expect(db.updateCrmDeal(tenantA.user.id, deal.id, { interested_project_id: projectB.id }))
            .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
        expect(await db.getCrmDeals(tenantA.user.id, { leadTemp: 'COLD' })).toHaveLength(1);
    });

    test('reply context includes only the current tenant’s active vacant inventory', async () => {
        await freshDatabase();
        const db = require('../src/services/database');
        const tenantA = await createUserDirect();
        const tenantB = await createUserDirect();
        const projectA = await db.createProject(tenantA.user.id, { name: 'Tenant A Home', locality: 'Ranchi' });
        const projectB = await db.createProject(tenantB.user.id, { name: 'Tenant B Secret', locality: 'Ranchi' });
        await db.createUnit(tenantA.user.id, projectA.id, { unitNumber: 'A-101', bhk: '2BHK', price: 5000000 });
        await db.createUnit(tenantB.user.id, projectB.id, { unitNumber: 'B-101', bhk: '2BHK', price: 5000000 });
        await db.aiUpsertCrmDeal(tenantA.user.id, '919800000002', { preferredBhk: '2BHK', preferredLocality: 'Ranchi' });

        const { getRealEstateReplyContext } = require('../src/services/ai');
        const context = await getRealEstateReplyContext(tenantA.user.id, '919800000002');
        expect(context).toContain('Tenant A Home');
        expect(context).not.toContain('Tenant B Secret');
    });
});
