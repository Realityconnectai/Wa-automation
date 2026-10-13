/**
 * src/routes/inventory.js — real estate inventory API.
 *
 * Projects, units, media assets.
 * Every route is scoped to req.user.id — a tenant can only see and modify
 * their own rows. Mounted at /api/inventory under requireAuth in app.js.
 *
 * Media files are served via GET /api/inventory/assets/:id/file through an
 * authenticated route — never from the public static folder.
 */
'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const os      = require('os');

const {
    createProject, getProjects, getProjectById, updateProject, deleteProject,
    createUnit, getUnits, getUnitById, updateUnit, deleteUnit, getUnitStatusHistory, searchUnits,
    transitionUnitStatus, expireStaleHolds,
    createMediaAsset, getMediaAssets, getMediaAssetById, deleteMediaAsset,
    getMonthlyOutgoingCount,
    assertPersistable
} = require('../services/database');

const { validateMediaFile, sendMedia } = require('../services/messaging');
const { asyncHandler }      = require('../utils/errors');
const { perUser }           = require('../middleware/rateLimit');
const { requireId, requireString, optionalString, clampNumber, clampInt, requireEnum, normalizePhone, LIMITS }
    = require('../utils/validate');

const writeLimiter = perUser('inventory-write', {
    windowMs: 60 * 1000, max: 120,
    message: 'Too many inventory changes. Please slow down.'
});

function requireDurableWrite(req, res, next) { assertPersistable(); next(); }

// ─── Multer — write uploaded files to the server's data directory ─────────
// Files land outside the public folder so they are never directly accessible.
const ASSET_STORE_DIR = process.env.ASSET_STORE_DIR
    || path.join(process.env.PERSIST_ROOT || path.resolve(__dirname, '..', '..'), 'data', 'assets');

try { fs.mkdirSync(ASSET_STORE_DIR, { recursive: true }); } catch (_) {}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ASSET_STORE_DIR),
        filename:    (req, file, cb) => {
            const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
            cb(null, `${req.user.id}_${Date.now()}_${safe}`);
        }
    }),
    limits: { fileSize: 17 * 1024 * 1024, files: 1 },  // hard ceiling at upload layer
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf','image/jpeg','image/jpg','image/png','video/mp4'];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        cb(Object.assign(new Error('File type not allowed'), { code: 'MEDIA_TYPE_NOT_ALLOWED' }), false);
    }
});

// ─── Projects ────────────────────────────────────────────────────────────
router.get('/projects', asyncHandler(async (req, res) => {
    const q = req.query;
    const projects = await getProjects(req.user.id, {
        city:         optionalString(q.city,         'city',         100),
        propertyType: optionalString(q.propertyType, 'propertyType', 40),
        activeOnly:   q.activeOnly !== 'false'
    });
    res.json({ success: true, data: projects });
}));

router.post('/projects', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name || typeof b.name !== 'string' || !b.name.trim()) {
        return res.status(400).json({ success: false, error: 'name is required.' });
    }
    const project = await createProject(req.user.id, {
        name:           optionalString(b.name,           'name',           200).trim(),
        developer:      optionalString(b.developer,      'developer',      200),
        city:           optionalString(b.city,           'city',           100),
        locality:       optionalString(b.locality,       'locality',       200),
        address:        optionalString(b.address,        'address',        500),
        mapUrl:         optionalString(b.mapUrl||b.map_url, 'mapUrl',      500),
        propertyType:   optionalString(b.propertyType||b.property_type, 'propertyType', 40) || 'residential',
        reraNumber:     optionalString(b.reraNumber||b.rera_number, 'reraNumber', 50),
        reraStatus:     ['unverified','verified'].includes(b.reraStatus||b.rera_status) ? (b.reraStatus||b.rera_status) : 'unverified',
        possessionDate: b.possessionDate || b.possession_date || null,
        description:    optionalString(b.description, 'description', 4000),
        listingUrl:     optionalString(b.listingUrl||b.listing_url, 'listingUrl', 500)
    });
    res.json({ success: true, data: project });
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'project id');
    const project = await getProjectById(req.user.id, id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    res.json({ success: true, data: project });
}));

router.put('/projects/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'project id');
    const existing = await getProjectById(req.user.id, id);
    if (!existing) return res.status(404).json({ success: false, error: 'Project not found' });
    const b = req.body || {};
    const updated = await updateProject(req.user.id, id, {
        name:         b.name         !== undefined ? optionalString(b.name,         'name',         200).trim() : undefined,
        developer:    b.developer    !== undefined ? optionalString(b.developer,    'developer',    200) : undefined,
        city:         b.city         !== undefined ? optionalString(b.city,         'city',         100) : undefined,
        locality:     b.locality     !== undefined ? optionalString(b.locality,     'locality',     200) : undefined,
        address:      b.address      !== undefined ? optionalString(b.address,      'address',      500) : undefined,
        mapUrl:       (b.mapUrl||b.map_url) !== undefined ? optionalString(b.mapUrl||b.map_url, 'mapUrl', 500) : undefined,
        reraNumber:   (b.reraNumber||b.rera_number) !== undefined ? optionalString(b.reraNumber||b.rera_number,'reraNumber',50) : undefined,
        reraStatus:   (b.reraStatus||b.rera_status) !== undefined ? (b.reraStatus||b.rera_status) : undefined,
        description:  b.description  !== undefined ? optionalString(b.description, 'description',  4000) : undefined,
        listingUrl:   (b.listingUrl||b.listing_url) !== undefined ? optionalString(b.listingUrl||b.listing_url,'listingUrl',500) : undefined,
        isActive:     b.isActive     !== undefined ? (b.isActive ? 1 : 0) : undefined
    });
    res.json({ success: true, data: updated });
}));

router.delete('/projects/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'project id');
    const existing = await getProjectById(req.user.id, id);
    if (!existing) return res.status(404).json({ success: false, error: 'Project not found' });
    await deleteProject(req.user.id, id);
    res.json({ success: true });
}));

// ─── Units ────────────────────────────────────────────────────────────────
router.get('/projects/:projectId/units', asyncHandler(async (req, res) => {
    const projectId = requireId(req.params.projectId, 'project id');
    const project = await getProjectById(req.user.id, projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    const q = req.query;
    const units = await getUnits(req.user.id, projectId, {
        status: optionalString(q.status, 'status', 10) || undefined,
        bhk:    optionalString(q.bhk,    'bhk',    20) || undefined
    });
    res.json({ success: true, data: units });
}));

router.post('/projects/:projectId/units', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const projectId = requireId(req.params.projectId, 'project id');
    const project = await getProjectById(req.user.id, projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    const b = req.body || {};
    if (!b.unit_number && !b.unitNumber) {
        return res.status(400).json({ success: false, error: 'unit_number is required.' });
    }
    const unit = await createUnit(req.user.id, projectId, {
        tower:      optionalString(b.tower,      'tower',       50),
        unitNumber: optionalString(b.unitNumber||b.unit_number, 'unitNumber', 50),
        bhk:        optionalString(b.bhk,        'bhk',         30),
        area:       clampNumber(b.area,          { min:0, max:100000, fallback:0 }),
        areaUnit:   ['sqft','sqm','sqyd'].includes(b.areaUnit||b.area_unit) ? (b.areaUnit||b.area_unit) : 'sqft',
        price:      clampNumber(b.price,         { min:0, max:1e12,   fallback:0 }),
        floor:      b.floor != null ? clampInt(b.floor, { min:-5, max:200, fallback:null }) : null
    });
    res.json({ success: true, data: unit });
}));

router.get('/units/search', asyncHandler(async (req, res) => {
    const q = req.query;
    const units = await searchUnits(req.user.id, {
        city:         optionalString(q.city,         'city',         100) || undefined,
        locality:     optionalString(q.locality,     'locality',     200) || undefined,
        bhk:          optionalString(q.bhk,          'bhk',          30)  || undefined,
        minPrice:     q.minPrice ? clampNumber(q.minPrice, { min:0, max:1e12, fallback:undefined }) : undefined,
        maxPrice:     q.maxPrice ? clampNumber(q.maxPrice, { min:0, max:1e12, fallback:undefined }) : undefined,
        propertyType: optionalString(q.propertyType, 'propertyType', 40)  || undefined,
        status:       optionalString(q.status,       'status',       10)  || undefined
    });
    res.json({ success: true, data: units });
}));

router.get('/units/:id', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'unit id');
    const unit = await getUnitById(req.user.id, id);
    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
    res.json({ success: true, data: unit });
}));

router.put('/units/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'unit id');
    const b = req.body || {};
    const rawUnitNumber = b.unitNumber ?? b.unit_number;
    if (rawUnitNumber !== undefined && (!String(rawUnitNumber).trim())) {
        return res.status(400).json({ success: false, error: 'unit_number cannot be blank.' });
    }
    const rawAreaUnit = b.areaUnit ?? b.area_unit;
    if (rawAreaUnit !== undefined && !['sqft', 'sqm', 'sqyd'].includes(rawAreaUnit)) {
        return res.status(400).json({ success: false, error: 'areaUnit must be sqft, sqm, or sqyd.' });
    }
    const unit = await updateUnit(req.user.id, id, {
        tower: b.tower === undefined ? undefined : optionalString(b.tower, 'tower', 50),
        unitNumber: rawUnitNumber === undefined ? undefined : optionalString(rawUnitNumber, 'unitNumber', 50),
        bhk: b.bhk === undefined ? undefined : optionalString(b.bhk, 'bhk', 30),
        area: b.area === undefined ? undefined : clampNumber(b.area, { min: 0, max: 100000, fallback: 0 }),
        areaUnit: rawAreaUnit,
        price: b.price === undefined ? undefined : clampNumber(b.price, { min: 0, max: 1e12, fallback: 0 }),
        floor: b.floor === undefined ? undefined : (b.floor === null || b.floor === '' ? null : clampInt(b.floor, { min: -5, max: 200, fallback: null }))
    });
    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
    res.json({ success: true, data: unit });
}));

router.delete('/units/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'unit id');
    try {
        await deleteUnit(req.user.id, id);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'UNIT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
        if (err.code === 'UNIT_ACTIVE_RESERVATION') return res.status(409).json({ success: false, error: err.message, code: err.code });
        throw err;
    }
}));

router.get('/units/:id/history', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'unit id');
    const unit = await getUnitById(req.user.id, id);
    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
    const history = await getUnitStatusHistory(req.user.id, id);
    res.json({ success: true, data: history });
}));

// Status transitions: hold / release / book
const TRANSITION_ENDPOINTS = {
    hold:    { newStatus: 'ON_HOLD' },
    release: { newStatus: 'VACANT'  },
    book:    { newStatus: 'BOOKED'  }
};

for (const [action, { newStatus }] of Object.entries(TRANSITION_ENDPOINTS)) {
    router.post(`/units/:id/${action}`, writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
        const id = requireId(req.params.id, 'unit id');
        const b = req.body || {};
        try {
            const holdMs = 30 * 60 * 1000; // default 30-min hold window
            const holdExpiresAt = newStatus === 'ON_HOLD'
                ? new Date(Date.now() + (b.holdMinutes ? b.holdMinutes * 60000 : holdMs)).toISOString()
                : null;
            const unit = await transitionUnitStatus(req.user.id, id, newStatus, {
                holdExpiresAt,
                holdBy:     optionalString(b.holdBy     || b.hold_by,    'holdBy',     100),
                bookingRef: optionalString(b.bookingRef || b.booking_ref,'bookingRef', 100),
                changedBy:  String(req.user.id),
                reason:     optionalString(b.reason, 'reason', 500)
            });
            res.json({ success: true, data: unit });
        } catch (err) {
            if (['UNIT_NOT_FOUND','INVALID_TRANSITION'].includes(err.code)) {
                return res.status(err.code === 'UNIT_NOT_FOUND' ? 404 : 409)
                    .json({ success: false, error: err.message, code: err.code });
            }
            throw err;
        }
    }));
}

// ─── Media Assets ─────────────────────────────────────────────────────────
router.get('/projects/:projectId/assets', asyncHandler(async (req, res) => {
    const projectId = requireId(req.params.projectId, 'project id');
    const project = await getProjectById(req.user.id, projectId);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    const q = req.query;
    const assets = await getMediaAssets(req.user.id, projectId, {
        assetType: optionalString(q.assetType || q.asset_type, 'assetType', 30) || undefined,
        unitId:    q.unitId ? requireId(q.unitId, 'unitId') : undefined
    });
    res.json({ success: true, data: assets });
}));

router.post('/projects/:projectId/assets', writeLimiter, requireDurableWrite,
    upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded.' });
        }
        const projectId = requireId(req.params.projectId, 'project id');
        const project = await getProjectById(req.user.id, projectId);
        if (!project) {
            fs.unlink(req.file.path, () => {});
            return res.status(404).json({ success: false, error: 'Project not found' });
        }

        // Validate magic bytes after upload
        const validation = validateMediaFile(req.file.path, req.file.mimetype);
        if (!validation.ok) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ success: false, error: validation.message, code: validation.code });
        }

        const b = req.body || {};
        const VALID_ASSET_TYPES = ['brochure','floor_plan','photo','walkthrough','price_sheet'];
        const assetType = VALID_ASSET_TYPES.includes(b.assetType||b.asset_type)
            ? (b.assetType||b.asset_type) : 'photo';

        const asset = await createMediaAsset(req.user.id, {
            projectId,
            unitId:       b.unitId ? requireId(b.unitId, 'unitId') : null,
            assetType,
            fileName:     validation.fileName,
            storagePath:  req.file.path,
            mimeType:     req.file.mimetype,
            sizeBytes:    validation.sizeBytes,
            reraVerified: b.reraVerified === 'true' || b.reraVerified === true
        });
        res.json({ success: true, data: asset });
    })
);

// Manual delivery is intentionally bound to an asset already owned by this
// tenant and project.  The browser never supplies a disk path or arbitrary
// file identifier, so it cannot turn this endpoint into a file sender.
router.post('/projects/:projectId/assets/:assetId/send', writeLimiter, requireDurableWrite,
    asyncHandler(async (req, res) => {
        if (req.user.role !== 'admin' && !req.user.wa_enabled) {
            return res.status(403).json({ success: false, error: 'WhatsApp access has not been enabled for your account.', code: 'WA_NOT_ENABLED' });
        }
        const projectId = requireId(req.params.projectId, 'project id');
        const assetId = requireId(req.params.assetId, 'asset id');
        const project = await getProjectById(req.user.id, projectId);
        const asset = await getMediaAssetById(req.user.id, assetId);
        if (!project || !asset || !asset.is_active || Number(asset.project_id) !== Number(projectId)) {
            return res.status(404).json({ success: false, error: 'Asset not found' });
        }
        const phone = normalizePhone(req.body?.phone);
        const caption = optionalString(req.body?.caption, 'caption', LIMITS.MESSAGE_BODY);
        const rawKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;
        const idempotencyKey = requireString(String(rawKey || ''), 'Idempotency-Key', { max: 120 });
        if (req.user.message_limit && (await getMonthlyOutgoingCount(req.user.id)) >= req.user.message_limit) {
            return res.status(403).json({
                success: false,
                error: `Monthly message limit reached (${req.user.message_limit}). Contact your administrator to raise it.`,
                code: 'MESSAGE_LIMIT'
            });
        }
        const result = await sendMedia(req.user.id, phone, {
            filePath: asset.storage_path,
            mimeType: asset.mime_type,
            caption,
            idempotencyKey
        });
        res.json({ success: true, data: { assetId: asset.id, fileName: asset.file_name, ...result } });
    })
);

// Serve a file — authenticated, tenant-scoped, never from public folder
router.get('/assets/:id/file', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'asset id');
    const asset = await getMediaAssetById(req.user.id, id);
    if (!asset || !asset.is_active) {
        return res.status(404).json({ success: false, error: 'Asset not found' });
    }
    if (!fs.existsSync(asset.storage_path)) {
        return res.status(404).json({ success: false, error: 'File not found on server' });
    }
    res.setHeader('Content-Type', asset.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${asset.file_name}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.resolve(asset.storage_path));
}));

router.delete('/assets/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'asset id');
    const asset = await getMediaAssetById(req.user.id, id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    await deleteMediaAsset(req.user.id, id);
    res.json({ success: true });
}));

module.exports = router;
