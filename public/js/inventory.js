/* Properties UI. CSP blocks inline handlers, so all interaction is bound here. */
'use strict';
window.Inventory = (() => {
    let projects = [], units = [], initialized = false;
    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const cleanFileName = name => {
        if (!name || typeof name !== 'string') return '';
        const m = name.trim().match(/^(\d+)_(\d{10,15})_(.+)$/);
        return m ? m[3] : name.trim();
    };
    const icon = (name, cls) => typeof window.Icon === 'function' ? window.Icon(name, cls) : '';
    const formatAssetType = t => (t || 'file').replace(/_/g, ' ');
    function getAssetIcon(mime, type) {
        if ((mime && mime.startsWith('video/')) || type === 'walkthrough') {
            return icon('play', 'asset-type-svg');
        }
        if ((mime && mime.startsWith('image/')) || type === 'photo' || type === 'floor_plan') {
            return icon('folder-open', 'asset-type-svg');
        }
        return icon('file-text', 'asset-type-svg');
    }
    async function apiFetch(url, options = {}) {
        // app.js correctly defaults JSON requests to Content-Type: application/json.
        // Browser-managed multipart boundaries are required for file uploads.
        if (!(options.body instanceof FormData)) return api(url, options);
        const headers = CURRENT_ACCESS_TOKEN ? { Authorization: `Bearer ${CURRENT_ACCESS_TOKEN}` } : {};
        const response = await fetch(url, { ...options, credentials: 'include', headers });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'API request failed');
        return data.data;
    }
    const show = (id, on) => { const el = $(id); if (el) { el.hidden = !on; el.style.display = on ? '' : 'none'; } };
    const toast = (m, t = 'info') => window.showToast(m, t);
    function error(message, retry) { const el = $('invProjectsError'); el.hidden = false; el.style.display = ''; el.innerHTML = `<div class="error-banner" role="alert"><span>${esc(message)}</span><button class="error-retry" type="button">Retry</button></div>`; el.querySelector('button').addEventListener('click', retry); }
    function clearError() { const el = $('invProjectsError'); if (el) { el.hidden = true; el.style.display = 'none'; el.innerHTML = ''; } }
    function gridError(message) { const el = $('invGridError'); if (el) { el.hidden = false; el.style.display = ''; el.innerHTML = `<div class="error-banner" role="alert"><span>${esc(message)}</span><button class="error-retry" type="button" data-inv="reload-grid">Retry</button></div>`; } }
    function clearGridError() { const el = $('invGridError'); if (el) { el.hidden = true; el.style.display = 'none'; el.innerHTML = ''; } }
    function showTab(tab) { ['projects','grid','brochure'].forEach(name => { const on = name === tab; const btn = $(`inv-tab-${name}`); if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-selected', String(on)); } const panel = $(`inv-panel-${name}`); if (panel) { panel.hidden = !on; panel.style.display = on ? '' : 'none'; } }); if (tab === 'grid') populateProjects(); if (tab === 'brochure') loadBrochureDrops(); }
    function filtered() { const city = $('invCityFilter').value.trim().toLowerCase(), type = $('invTypeFilter').value; return projects.filter(p => (!city || (p.city || '').toLowerCase().includes(city)) && (!type || p.property_type === type)); }
    function renderProjects(rows) { const target = $('invProjectsGrid'); if (!rows.length) { show('invProjectsEmpty', true); target.innerHTML = ''; return; } show('invProjectsEmpty', false); target.innerHTML = rows.map(p => `<article class="card" role="listitem"><h2 class="card-title">${esc(p.name)}</h2><p class="card-note">${esc([p.city,p.locality].filter(Boolean).join(', ') || 'Location not set')}</p><p class="card-note">${esc(p.property_type)} · ${p.rera_status === 'verified' ? 'RERA verified' : 'RERA unverified'}</p><div class="modal-actions"><button class="btn btn-secondary btn-sm" type="button" data-inv="grid" data-project="${p.id}">Availability</button><button class="btn btn-secondary btn-sm" type="button" data-inv="assets" data-project="${p.id}">Assets</button><button class="btn btn-secondary btn-sm" type="button" data-inv="edit" data-project="${p.id}">Edit</button><button class="btn btn-danger btn-sm" type="button" data-inv="delete" data-project="${p.id}">Delete</button></div></article>`).join(''); }
    async function loadProjects() { show('invProjectsLoading', true); show('invProjectsEmpty', false); clearError(); $('invProjectsGrid').innerHTML = ''; try { projects = await apiFetch('/api/inventory/projects'); renderProjects(filtered()); populateProjects(); } catch (e) { error(`Failed to load projects: ${e.message}`, loadProjects); } finally { show('invProjectsLoading', false); } }
    function populateProjects() { const select = $('invGridProject'), prior = select.value; select.innerHTML = '<option value="">Select project</option>' + projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join(''); select.value = prior; $('invNewUnitBtn').disabled = !select.value; }
    function renderGrid(rows) { const target = $('invGridContainer'); if (!rows.length) { show('invGridEmpty', true); target.innerHTML = ''; return; } show('invGridEmpty', false); const tone = {VACANT:'pill-active',ON_HOLD:'pill-pending',BOOKED:'pill-error',SOLD:'pill-paused'}; target.innerHTML = `<div class="card"><div class="table-container"><table class="data-table"><thead><tr><th>Unit</th><th>Tower</th><th>Floor</th><th>BHK</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(u => `<tr><td>${esc(u.unit_number)}</td><td>${esc(u.tower)}</td><td>${esc(u.floor ?? '—')}</td><td>${esc(u.bhk)}</td><td><span class="pill ${tone[u.status] || 'pill-paused'}">${esc(u.status)}</span></td><td><button class="btn btn-secondary btn-sm" type="button" data-inv="unit" data-unit="${u.id}">Manage</button></td></tr>`).join('')}</tbody></table></div></div>`; }
    function filterGrid() { const status = $('invGridStatusFilter').value, bhk = $('invGridBhkFilter').value.trim().toLowerCase(); renderGrid(units.filter(u => (!status || u.status === status) && (!bhk || (u.bhk || '').toLowerCase().includes(bhk)))); }
    async function loadGrid() { const id = $('invGridProject').value; $('invNewUnitBtn').disabled = !id; clearGridError(); if (!id) { units = []; renderGrid([]); return; } show('invGridLoading', true); try { units = await apiFetch(`/api/inventory/projects/${id}/units`); filterGrid(); } catch (e) { gridError(`Failed to load units: ${e.message}`); } finally { show('invGridLoading', false); } }
    let activeKeyHandler = null;
    function closeModal() {
        if (activeKeyHandler) {
            document.removeEventListener('keydown', activeKeyHandler);
            activeKeyHandler = null;
        }
        $('invModalBackdrop')?.remove();
    }
    function modal(title, html, extraClass = '') {
        closeModal();
        const el = document.createElement('div');
        el.id = 'invModalBackdrop';
        el.className = 'modal-backdrop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        const modalCls = extraClass ? `modal ${extraClass}` : 'modal';
        el.innerHTML = `<div class="${modalCls}"><div class="modal-header"><h2>${esc(title)}</h2><button class="modal-close" type="button" aria-label="Close">×</button></div><div class="modal-body" id="invModalBody">${html}</div></div>`;
        document.body.appendChild(el);
        el.addEventListener('click', e => {
            if (e.target === el || e.target.closest('.modal-close,[data-inv="close"]')) closeModal();
        });
        activeKeyHandler = e => {
            if (e.key === 'Escape') closeModal();
        };
        document.addEventListener('keydown', activeKeyHandler);
        setTimeout(() => {
            const firstInput = el.querySelector('input:not([type="hidden"]), select, textarea, button.btn-primary');
            if (firstInput && typeof firstInput.focus === 'function') firstInput.focus();
        }, 50);
    }
    function projectForm(project) { const edit = !!project; modal(edit ? 'Edit Project' : 'New Project', `<form id="invProjectForm"><div class="form-group"><label for="invName">Project name</label><input id="invName" name="name" required value="${esc(project?.name)}"></div><div class="form-row"><div class="form-group"><label for="invCity">City</label><input id="invCity" name="city" value="${esc(project?.city)}"></div><div class="form-group"><label for="invType">Type</label><select id="invType" name="propertyType">${['residential','commercial','plot','rental','resale'].map(t => `<option value="${t}" ${project?.property_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div><div class="form-group"><label for="invLocality">Locality</label><input id="invLocality" name="locality" value="${esc(project?.locality)}"></div><div class="form-row"><div class="form-group"><label for="invReraNumber">RERA / listing ID</label><input id="invReraNumber" name="reraNumber" value="${esc(project?.rera_number)}"></div><div class="form-group"><label for="invListingUrl">Listing URL or ID</label><input id="invListingUrl" name="listingUrl" value="${esc(project?.listing_url)}"></div></div><p class="form-text">The project name, RERA number, and listing URL/ID are all brochure-drop identifiers.</p><div class="modal-actions"><button class="btn btn-primary" type="submit">${edit ? 'Save changes' : 'Create project'}</button><button class="btn btn-secondary" type="button" data-inv="close">Cancel</button></div></form>`); $('invProjectForm').addEventListener('submit', async e => { e.preventDefault(); try { await apiFetch(edit ? `/api/inventory/projects/${project.id}` : '/api/inventory/projects', {method:edit?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))}); closeModal(); toast(edit ? 'Project updated' : 'Project created','success'); await loadProjects(); } catch (err) { toast(err.message || 'Could not save project','error'); } }); }
    function unitForm(unit) { const edit = !!unit, project = $('invGridProject').value; if (!project && !edit) return; modal(edit ? `Edit ${unit.unit_number}` : 'New Unit', `<form id="invUnitForm"><div class="form-row"><div class="form-group"><label for="invUnitNumber">Unit number</label><input id="invUnitNumber" name="unit_number" required value="${esc(unit?.unit_number)}"></div><div class="form-group"><label for="invTower">Tower</label><input id="invTower" name="tower" value="${esc(unit?.tower)}"></div></div><div class="form-row"><div class="form-group"><label for="invFloor">Floor</label><input id="invFloor" name="floor" type="number" min="-5" max="200" value="${esc(unit?.floor ?? '')}"></div><div class="form-group"><label for="invBhk">BHK</label><input id="invBhk" name="bhk" placeholder="2BHK" value="${esc(unit?.bhk)}"></div></div><div class="form-row"><div class="form-group"><label for="invArea">Area</label><input id="invArea" name="area" type="number" min="0" max="100000" step="0.01" value="${esc(unit?.area ?? '')}"></div><div class="form-group"><label for="invAreaUnit">Area unit</label><select id="invAreaUnit" name="areaUnit">${['sqft','sqm','sqyd'].map(value => `<option value="${value}" ${unit?.area_unit === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div><div class="form-group"><label for="invPrice">Price</label><input id="invPrice" name="price" type="number" min="0" max="1000000000000" step="0.01" value="${esc(unit?.price ?? '')}"></div><div class="modal-actions"><button class="btn btn-primary" type="submit">${edit ? 'Save unit' : 'Create unit'}</button><button class="btn btn-secondary" type="button" data-inv="close">Cancel</button></div></form>`); $('invUnitForm').addEventListener('submit', async e => { e.preventDefault(); const button = e.target.querySelector('[type="submit"]'); button.disabled = true; try { await apiFetch(edit ? `/api/inventory/units/${unit.id}` : `/api/inventory/projects/${project}/units`,{method:edit?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))}); closeModal(); toast(edit ? 'Unit updated' : 'Unit created','success'); await loadGrid(); } catch (err) { toast(err.message || 'Could not save unit','error'); } finally { button.disabled = false; } }); }
    const bytes = value => `${(Number(value || 0) / 1024 / 1024).toFixed(2)} MB`;
    async function assets(project) {
        modal('Project Assets', '<p class="card-note">Loading assets…</p>', 'modal-assets');
        try {
            const [rows, contacts] = await Promise.all([
                apiFetch(`/api/inventory/projects/${project}/assets`),
                apiFetch('/api/contacts?limit=200')
            ]);
            const recipientOptions = contacts.map(c => `<option value="${esc(c.phone)}">${esc(c.name || 'Contact')} · ••••${esc(String(c.phone).slice(-4))}</option>`).join('');
            
            $('invModalBody').innerHTML = `
                <div class="asset-upload-card">
                    <div class="asset-upload-header">
                        <h3 class="asset-section-title">
                            <span class="asset-title-icon" aria-hidden="true">${icon('upload')}</span>
                            <span>Upload New Asset</span>
                        </h3>
                        <span class="asset-upload-hint">PDF, JPEG, PNG, MP4 (max 25MB)</span>
                    </div>
                    <form id="invAssetForm" class="asset-upload-form">
                        <div class="asset-form-col asset-form-file">
                            <label for="invAsset">Asset file</label>
                            <div class="asset-file-wrap">
                                <input id="invAsset" name="file" type="file" required accept="application/pdf,image/jpeg,image/png,video/mp4" class="asset-file-input">
                            </div>
                        </div>
                        <div class="asset-form-col asset-form-type">
                            <label for="invAssetType">Type</label>
                            <select id="invAssetType" name="assetType" class="asset-type-select">
                                <option value="photo">Photo</option>
                                <option value="brochure">Brochure</option>
                                <option value="floor_plan">Floor plan</option>
                                <option value="walkthrough">Walkthrough</option>
                                <option value="price_sheet">Price sheet</option>
                            </select>
                        </div>
                        <div class="asset-form-col asset-form-submit">
                            <button class="btn btn-primary asset-upload-btn" type="submit">
                                <span class="btn-icon" data-icon="upload" aria-hidden="true">${icon('upload')}</span>
                                <span>Upload Asset</span>
                            </button>
                        </div>
                    </form>
                </div>

                <div class="asset-list-card">
                    <div class="asset-list-header">
                        <div class="asset-list-title-wrap">
                            <h3 class="asset-section-title">
                                <span class="asset-title-icon" aria-hidden="true">${icon('folder-open')}</span>
                                <span>Uploaded Assets</span>
                            </h3>
                            <span class="asset-count-badge">${rows.length}</span>
                        </div>
                        ${rows.length ? `<span class="asset-list-subtitle">Files attached to this project</span>` : ''}
                    </div>

                    ${rows.length ? `
                    <div class="asset-items-list" role="list">
                        ${rows.map(a => {
                            const dName = cleanFileName(a.display_name || a.file_name);
                            const typeLabel = formatAssetType(a.asset_type);
                            const formattedDate = a.created_at ? new Date(a.created_at).toLocaleDateString(undefined, {
                                year: 'numeric', month: 'short', day: 'numeric'
                            }) : 'Unknown date';
                            return `
                            <div class="asset-row-card" role="listitem">
                                <div class="asset-row-main">
                                    <div class="asset-type-badge-icon" aria-hidden="true" title="${esc(typeLabel)}">
                                        ${getAssetIcon(a.mime_type, a.asset_type)}
                                    </div>
                                    <div class="asset-row-details">
                                        <div class="asset-row-filename" title="${esc(dName)}">
                                            ${esc(dName)}
                                        </div>
                                        <div class="asset-row-meta">
                                            <span class="asset-pill-type">${esc(typeLabel)}</span>
                                            <span class="asset-meta-separator" aria-hidden="true">•</span>
                                            <span class="asset-meta-size">${esc(bytes(a.size_bytes))}</span>
                                            <span class="asset-meta-separator" aria-hidden="true">•</span>
                                            <span class="asset-meta-date">${esc(formattedDate)}</span>
                                        </div>
                                    </div>
                                </div>
                                <div class="asset-row-actions">
                                    <button class="btn btn-secondary btn-sm asset-action-btn" type="button" data-inv="preview-asset" data-asset="${a.id}" data-name="${esc(dName)}" data-mime="${esc(a.mime_type)}" title="Preview asset">
                                        <span class="btn-icon" data-icon="eye" aria-hidden="true">${icon('eye')}</span>
                                        <span>Preview</span>
                                    </button>
                                    <a class="btn btn-secondary btn-sm asset-action-btn" href="/api/inventory/assets/${a.id}/file?download=1" target="_blank" rel="noopener" title="Download file">
                                        <span class="btn-icon" data-icon="download" aria-hidden="true">${icon('download')}</span>
                                        <span>Download</span>
                                    </a>
                                    <button class="btn btn-secondary btn-sm asset-action-btn" type="button" data-inv="asset-history" data-asset="${a.id}" data-name="${esc(dName)}" title="View send history">
                                        <span class="btn-icon" data-icon="clock" aria-hidden="true">${icon('clock')}</span>
                                        <span>History</span>
                                    </button>
                                    <button class="btn btn-secondary btn-sm asset-action-btn" type="button" data-inv="send-asset" data-asset="${a.id}" data-project="${project}" data-filename="${esc(dName)}" title="Send via WhatsApp">
                                        <span class="btn-icon" data-icon="send" aria-hidden="true">${icon('send')}</span>
                                        <span>Send</span>
                                    </button>
                                    <button class="btn btn-danger btn-sm asset-action-btn asset-delete-btn" type="button" data-inv="delete-asset" data-asset="${a.id}" data-project="${project}" title="Delete asset">
                                        <span class="btn-icon" data-icon="trash-2" aria-hidden="true">${icon('trash-2')}</span>
                                        <span>Delete</span>
                                    </button>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>` : `
                    <div class="asset-empty-state">
                        <div class="asset-empty-icon" aria-hidden="true">${icon('folder-open')}</div>
                        <h4>No assets uploaded yet</h4>
                        <p>Upload brochures, floor plans, site photos, or walkthrough videos above to share them with leads.</p>
                    </div>`}
                </div>
                <template id="invRecipients">${recipientOptions}</template>`;

            $('invAssetForm').addEventListener('submit', async e => {
                e.preventDefault();
                const button = e.target.querySelector('[type="submit"]');
                button.disabled = true;
                try {
                    await apiFetch(`/api/inventory/projects/${project}/assets`, {
                        method: 'POST',
                        body: new FormData(e.target)
                    });
                    toast('Asset uploaded', 'success');
                    assets(project);
                } catch(err) {
                    toast(err.message || 'Upload failed', 'error');
                } finally {
                    button.disabled = false;
                }
            });
        } catch(err) {
            $('invModalBody').innerHTML = `<div class="error-banner" role="alert"><span>${esc(`Failed to load assets: ${err.message}`)}</span><button class="error-retry" type="button" data-inv="assets" data-project="${project}">Retry</button></div>`;
        }
    }
    function assetPreview(assetId, name, mime) { const clean = cleanFileName(name); const url = `/api/inventory/assets/${assetId}/file`; modal(`Preview ${clean}`, '<p class="card-note">Loading preview…</p>'); let media = mime.startsWith('image/') ? `<img class="asset-preview-media" alt="${esc(clean)}" src="${url}">` : mime.startsWith('video/') ? `<video class="asset-preview-media" controls src="${url}"></video>` : `<iframe class="asset-preview-media" title="${esc(clean)}" src="${url}"></iframe>`; $('invModalBody').innerHTML = `<div class="card"><p class="card-note">${esc(mime)}</p>${media}<p><a class="btn btn-secondary btn-sm" href="${url}?download=1" target="_blank" rel="noopener">Download</a></p></div>`; }
    async function assetHistory(assetId, name) { const clean = cleanFileName(name); modal(`Send history · ${clean}`, '<p class="card-note">Loading send history…</p>'); try { const rows = await apiFetch(`/api/inventory/assets/${assetId}/history`); if (!rows.length) { $('invModalBody').innerHTML = '<div class="empty-state"><p>This asset has not been sent from this workspace yet.</p></div>'; return; } $('invModalBody').innerHTML = `<div class="table-container"><table class="data-table"><thead><tr><th>Recipient</th><th>Status</th><th>Type</th><th>When</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.contact_name || 'Contact')} · ••••${esc(row.phone_last4)}</td><td>${esc(row.status)}</td><td>${esc(row.message_type)}</td><td>${esc(row.created_at ? new Date(row.created_at).toLocaleString() : '—')}</td></tr>`).join('')}</tbody></table></div>`; } catch (err) { $('invModalBody').innerHTML = `<div class="error-banner" role="alert"><span>${esc(`Failed to load send history: ${err.message}`)}</span><button class="error-retry" type="button" data-inv="asset-history" data-asset="${assetId}" data-name="${esc(clean)}">Retry</button></div>`; } }
    function newIdempotencyKey() { return window.crypto?.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    function sendAsset(project, asset, name) { const clean = cleanFileName(name); const options = $('invRecipients')?.innerHTML || ''; modal(`Send ${clean}`, `<form id="invSendAssetForm"><div class="form-group"><label for="invAssetRecipient">Recipient</label><select id="invAssetRecipient" name="phone" required><option value="">Select a contact</option>${options}</select></div><div class="form-group"><label for="invAssetCaption">Caption (optional)</label><textarea id="invAssetCaption" name="caption" rows="2" maxlength="2000"></textarea></div><p class="form-text">This sends the selected project asset through your connected WhatsApp account.</p><div class="modal-actions"><button class="btn btn-primary" type="submit">Send file</button><button class="btn btn-secondary" type="button" data-inv="close">Cancel</button></div></form>`); const formElement = $('invSendAssetForm'); formElement.dataset.idempotencyKey = newIdempotencyKey(); formElement.addEventListener('submit', async e => { e.preventDefault(); const form = new FormData(e.target); const recipient = e.target.elements.phone.selectedOptions[0]?.textContent || 'this contact'; if (!window.confirm(`Send ${clean} to ${recipient}?`)) return; const button = e.target.querySelector('[type="submit"]'); button.disabled = true; try { await apiFetch(`/api/inventory/projects/${project}/assets/${asset}/send`, {method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':e.target.dataset.idempotencyKey},body:JSON.stringify(Object.fromEntries(form))}); closeModal(); toast('File sent','success'); } catch(err) { toast(err.message || 'Could not send file','error'); } finally { button.disabled = false; } }); }
    function manage(unitId) { const unit = units.find(u => Number(u.id) === Number(unitId)); if (!unit) return; const choices = unit.status === 'VACANT' ? [['hold','Place hold'],['book','Book']] : unit.status === 'ON_HOLD' ? [['release','Release hold'],['book','Book']] : []; modal(`Manage ${unit.unit_number}`, `<p class="card-note">${esc(unit.status)} · ${esc(unit.bhk || 'BHK not set')}</p><div class="modal-actions">${choices.map(([action,label]) => `<button class="btn btn-primary" type="button" data-inv="transition" data-unit="${unitId}" data-transition="${action}">${label}</button>`).join('')}<button class="btn btn-secondary" type="button" data-inv="edit-unit" data-unit="${unitId}">Edit</button><button class="btn btn-secondary" type="button" data-inv="history-unit" data-unit="${unitId}">Status history</button><button class="btn btn-danger" type="button" data-inv="delete-unit" data-unit="${unitId}">Delete</button><button class="btn btn-secondary" type="button" data-inv="close">Cancel</button></div>`); }
    async function unitHistory(unitId) { modal('Unit status history', '<p class="card-note">Loading history…</p>'); try { const rows = await apiFetch(`/api/inventory/units/${unitId}/history`); if (!rows.length) { $('invModalBody').innerHTML = '<div class="empty-state"><p>No status changes have been recorded for this unit.</p></div>'; return; } $('invModalBody').innerHTML = `<div class="table-container"><table class="data-table"><thead><tr><th>From</th><th>To</th><th>Who</th><th>Why</th><th>When</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.old_status)}</td><td>${esc(row.new_status)}</td><td>${esc(row.changed_by || 'System')}</td><td>${esc(row.reason || '—')}</td><td>${esc(row.changed_at ? new Date(row.changed_at).toLocaleString() : '—')}</td></tr>`).join('')}</tbody></table></div>`; } catch (err) { $('invModalBody').innerHTML = `<div class="error-banner" role="alert"><span>${esc(`Failed to load history: ${err.message}`)}</span><button class="error-retry" type="button" data-inv="history-unit" data-unit="${unitId}">Retry</button></div>`; } }
    function getUnitContext(unitId) {
        const unit = units.find(u => Number(u.id) === Number(unitId));
        if (!unit) return null;
        const proj = projects.find(p => Number(p.id) === Number(unit.project_id))
            || { name: $('invGridProject')?.selectedOptions?.[0]?.textContent || 'Project' };
        return { unit, proj };
    }

    function renderUnitSummary(unit, proj) {
        const tone = { VACANT: 'pill-active', ON_HOLD: 'pill-pending', BOOKED: 'pill-error', SOLD: 'pill-paused' };
        const priceFormatted = unit.price ? `₹${Number(unit.price).toLocaleString('en-IN')}` : '—';
        const areaFormatted = unit.area ? ` (${esc(unit.area)} ${esc(unit.area_unit || 'sqft')})` : '';
        return `
            <div class="unit-summary-banner">
                <div class="unit-summary-top">
                    <div class="unit-summary-heading">
                        <span class="unit-summary-icon" aria-hidden="true">${icon('building-2')}</span>
                        <span class="unit-summary-title">Unit ${esc(unit.unit_number)}</span>
                        <span class="unit-summary-project">in ${esc(proj?.name || 'Project')}</span>
                    </div>
                    <span class="pill ${tone[unit.status] || 'pill-active'}">${esc(unit.status)}</span>
                </div>
                <div class="unit-summary-grid">
                    <div class="unit-summary-metric">
                        <span class="metric-label">Tower / Floor</span>
                        <span class="metric-val">${esc(unit.tower || '—')} · Fl ${esc(unit.floor ?? '—')}</span>
                    </div>
                    <div class="unit-summary-metric">
                        <span class="metric-label">Type &amp; Area</span>
                        <span class="metric-val">${esc(unit.bhk || '—')}${areaFormatted}</span>
                    </div>
                    <div class="unit-summary-metric">
                        <span class="metric-label">Price</span>
                        <span class="metric-val price-val">${priceFormatted}</span>
                    </div>
                </div>
            </div>
        `;
    }

    function openHoldModal(unitId) {
        const ctx = getUnitContext(unitId);
        if (!ctx) return;
        const { unit, proj } = ctx;

        const html = `
            ${renderUnitSummary(unit, proj)}
            <form id="invHoldForm" class="unit-action-form" novalidate>
                <div class="form-group">
                    <label for="invHoldBy" class="form-label required">Customer name or phone number <span class="required-star">*</span></label>
                    <div class="input-with-icon">
                        <span class="input-icon" aria-hidden="true">${icon('user')}</span>
                        <input type="text" id="invHoldBy" name="holdBy" class="form-control" placeholder="e.g. Rahul Sharma or +91 98765 43210" required maxlength="100" autocomplete="off">
                    </div>
                    <div id="invHoldByError" class="inline-field-error" hidden></div>
                    <span class="form-helper">Enter the prospect or lead reserving this unit.</span>
                </div>

                <div class="form-group">
                    <label for="invHoldMinutes" class="form-label">Hold duration</label>
                    <select id="invHoldMinutes" name="holdMinutes" class="form-control">
                        <option value="30" selected>30 minutes (Standard)</option>
                        <option value="60">1 hour</option>
                        <option value="120">2 hours</option>
                        <option value="240">4 hours</option>
                        <option value="1440">24 hours (1 day)</option>
                        <option value="2880">48 hours (2 days)</option>
                    </select>
                    <span class="form-helper">Unit will automatically revert to Vacant if not confirmed before expiry.</span>
                </div>

                <div class="form-group">
                    <label for="invHoldReason" class="form-label">Reason / Notes (optional)</label>
                    <input type="text" id="invHoldReason" name="reason" class="form-control" placeholder="e.g. Client visiting site at 4 PM" maxlength="500">
                </div>

                <div id="invHoldErrorBanner" class="modal-form-alert error" hidden role="alert"></div>

                <div class="modal-actions">
                    <button class="btn btn-secondary" type="button" data-inv="close">Cancel</button>
                    <button class="btn btn-primary" type="submit" id="invHoldSubmitBtn">
                        <span class="btn-icon" data-icon="lock" aria-hidden="true">${icon('lock')}</span>
                        <span class="btn-text">Confirm Hold</span>
                    </button>
                </div>
            </form>
        `;

        modal('Place Property Hold', html, 'modal-hold');

        const form = $('invHoldForm');
        const inputHoldBy = $('invHoldBy');
        const errorDiv = $('invHoldByError');
        const errorBanner = $('invHoldErrorBanner');
        const submitBtn = $('invHoldSubmitBtn');
        const cancelBtn = form?.querySelector('[data-inv="close"]');

        inputHoldBy?.addEventListener('input', () => {
            if (inputHoldBy.value.trim()) {
                inputHoldBy.removeAttribute('aria-invalid');
                errorDiv.hidden = true;
                errorDiv.textContent = '';
            }
        });

        form?.addEventListener('submit', async e => {
            e.preventDefault();
            const holdBy = inputHoldBy.value.trim();
            if (!holdBy) {
                inputHoldBy.setAttribute('aria-invalid', 'true');
                errorDiv.hidden = false;
                errorDiv.textContent = 'Please enter a customer name or phone number.';
                inputHoldBy.focus();
                return;
            }

            submitBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            submitBtn.innerHTML = `<span class="btn-spinner" aria-hidden="true">${icon('loader-2')}</span> <span class="btn-text">Placing hold…</span>`;
            errorBanner.hidden = true;
            errorBanner.textContent = '';

            try {
                await apiFetch(`/api/inventory/units/${unitId}/hold`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        holdBy,
                        holdMinutes: Number($('invHoldMinutes')?.value || 30),
                        reason: $('invHoldReason')?.value?.trim() || ''
                    })
                });
                closeModal();
                toast('Property hold placed successfully', 'success');
                await loadGrid();
            } catch (err) {
                const msg = err.message || 'Failed to place property hold';
                errorBanner.hidden = false;
                errorBanner.textContent = msg;
                toast(msg, 'error');
                submitBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
                submitBtn.innerHTML = `<span class="btn-icon" data-icon="lock" aria-hidden="true">${icon('lock')}</span> <span class="btn-text">Confirm Hold</span>`;
            }
        });
    }

    function openBookModal(unitId) {
        const ctx = getUnitContext(unitId);
        if (!ctx) return;
        const { unit, proj } = ctx;

        const html = `
            ${renderUnitSummary(unit, proj)}
            <form id="invBookForm" class="unit-action-form" novalidate>
                <div class="form-group">
                    <label for="invBookingRef" class="form-label required">Customer name, phone, or booking reference <span class="required-star">*</span></label>
                    <div class="input-with-icon">
                        <span class="input-icon" aria-hidden="true">${icon('user-check')}</span>
                        <input type="text" id="invBookingRef" name="bookingRef" class="form-control" placeholder="e.g. BK-2024-001 or Priya Verma (+91 98765 43210)" required maxlength="100" autocomplete="off">
                    </div>
                    <div id="invBookingRefError" class="inline-field-error" hidden></div>
                    <span class="form-helper">Enter the booking reference or customer details for this reservation.</span>
                </div>

                <div class="form-group">
                    <label for="invBookReason" class="form-label">Booking notes / remarks (optional)</label>
                    <textarea id="invBookReason" name="reason" rows="2" class="form-control" placeholder="e.g. Booking token received via cheque, agreement scheduled next Monday" maxlength="500"></textarea>
                </div>

                <div id="invBookErrorBanner" class="modal-form-alert error" hidden role="alert"></div>

                <div class="modal-actions">
                    <button class="btn btn-secondary" type="button" data-inv="close">Cancel</button>
                    <button class="btn btn-primary" type="submit" id="invBookSubmitBtn">
                        <span class="btn-icon" data-icon="check-circle" aria-hidden="true">${icon('check-circle')}</span>
                        <span class="btn-text">Confirm Booking</span>
                    </button>
                </div>
            </form>
        `;

        modal('Book Property Unit', html, 'modal-book');

        const form = $('invBookForm');
        const inputRef = $('invBookingRef');
        const errorDiv = $('invBookingRefError');
        const errorBanner = $('invBookErrorBanner');
        const submitBtn = $('invBookSubmitBtn');
        const cancelBtn = form?.querySelector('[data-inv="close"]');

        inputRef?.addEventListener('input', () => {
            if (inputRef.value.trim()) {
                inputRef.removeAttribute('aria-invalid');
                errorDiv.hidden = true;
                errorDiv.textContent = '';
            }
        });

        form?.addEventListener('submit', async e => {
            e.preventDefault();
            const bookingRef = inputRef.value.trim();
            if (!bookingRef) {
                inputRef.setAttribute('aria-invalid', 'true');
                errorDiv.hidden = false;
                errorDiv.textContent = 'Please enter customer details or a booking reference.';
                inputRef.focus();
                return;
            }

            submitBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            submitBtn.innerHTML = `<span class="btn-spinner" aria-hidden="true">${icon('loader-2')}</span> <span class="btn-text">Confirming booking…</span>`;
            errorBanner.hidden = true;
            errorBanner.textContent = '';

            try {
                await apiFetch(`/api/inventory/units/${unitId}/book`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bookingRef,
                        reason: $('invBookReason')?.value?.trim() || ''
                    })
                });
                closeModal();
                toast('Property unit booked successfully', 'success');
                await loadGrid();
            } catch (err) {
                const msg = err.message || 'Failed to book property unit';
                errorBanner.hidden = false;
                errorBanner.textContent = msg;
                toast(msg, 'error');
                submitBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
                submitBtn.innerHTML = `<span class="btn-icon" data-icon="check-circle" aria-hidden="true">${icon('check-circle')}</span> <span class="btn-text">Confirm Booking</span>`;
            }
        });
    }

    function openReleaseModal(unitId) {
        const ctx = getUnitContext(unitId);
        if (!ctx) return;
        const { unit, proj } = ctx;

        const html = `
            ${renderUnitSummary(unit, proj)}
            <form id="invReleaseForm" class="unit-action-form">
                <div class="release-info-box">
                    <span class="release-info-icon" aria-hidden="true">${icon('info')}</span>
                    <div class="release-info-text">
                        <strong>Release this hold?</strong>
                        <p>This unit is currently held${unit.hold_by ? ` for <em>${esc(unit.hold_by)}</em>` : ''}. Releasing it will immediately change its status back to <strong>VACANT</strong>.</p>
                    </div>
                </div>

                <div class="form-group">
                    <label for="invReleaseReason" class="form-label">Reason / Notes (optional)</label>
                    <input type="text" id="invReleaseReason" name="reason" class="form-control" placeholder="e.g. Customer cancelled token discussion" maxlength="500">
                </div>

                <div id="invReleaseErrorBanner" class="modal-form-alert error" hidden role="alert"></div>

                <div class="modal-actions">
                    <button class="btn btn-secondary" type="button" data-inv="close">Cancel</button>
                    <button class="btn btn-danger" type="submit" id="invReleaseSubmitBtn">
                        <span class="btn-text">Confirm Release</span>
                    </button>
                </div>
            </form>
        `;

        modal('Release Property Hold', html, 'modal-release');

        const form = $('invReleaseForm');
        const submitBtn = $('invReleaseSubmitBtn');
        const cancelBtn = form?.querySelector('[data-inv="close"]');
        const errorBanner = $('invReleaseErrorBanner');

        form?.addEventListener('submit', async e => {
            e.preventDefault();
            submitBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            submitBtn.innerHTML = `<span class="btn-spinner" aria-hidden="true">${icon('loader-2')}</span> <span class="btn-text">Releasing…</span>`;
            errorBanner.hidden = true;

            try {
                await apiFetch(`/api/inventory/units/${unitId}/release`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        reason: $('invReleaseReason')?.value?.trim() || ''
                    })
                });
                closeModal();
                toast('Property hold released successfully', 'success');
                await loadGrid();
            } catch (err) {
                const msg = err.message || 'Failed to release hold';
                errorBanner.hidden = false;
                errorBanner.textContent = msg;
                toast(msg, 'error');
                submitBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
                submitBtn.innerHTML = `<span class="btn-text">Confirm Release</span>`;
            }
        });
    }

    function transition(unitId, state) {
        if (state === 'hold') return openHoldModal(unitId);
        if (state === 'book') return openBookModal(unitId);
        if (state === 'release') return openReleaseModal(unitId);
    }
    function brochureError(message) { const el = $('invBrochureError'); if (el) { el.hidden = false; el.style.display = ''; el.innerHTML = `<div class="error-banner" role="alert"><span>${esc(message)}</span><button class="error-retry" type="button" data-inv="reload-brochure">Retry</button></div>`; } }
    function renderBrochureDrops(settings, assetRows, events) {
        let selection = {};
        try { selection = JSON.parse(settings.brochure_asset_selection || '{}'); } catch (_) {}
        let triggers = [];
        try { triggers = JSON.parse(settings.brochure_triggers || '[]'); } catch (_) {}
        const isEnabled = settings.brochure_drop_enabled !== 'false';
        const dedupHours = settings.brochure_dedup_window_hours || '24';
        const assetsByProject = assetRows.reduce((byProject, asset) => { (byProject[asset.project_id] ||= []).push(asset); return byProject; }, {});
        const projectCards = projects.map(project => {
            const configured = Array.isArray(selection[String(project.id)]);
            const selected = new Set((selection[String(project.id)] || []).map(Number));
            const matchingAssets = (assetsByProject[project.id] || []).filter(asset => ['brochure','walkthrough'].includes(asset.asset_type));
            return `<article class="card brochure-project-card"><div class="section-header"><div><h3 class="card-title">${esc(project.name)}</h3><p class="card-note brochure-project-meta">Identifiers: ${esc([project.name, project.rera_number, project.listing_url].filter(Boolean).join(' · ') || 'Project name only')}</p></div><button class="btn btn-secondary btn-sm" type="button" data-inv="edit" data-project="${project.id}">Edit identifiers</button></div>${matchingAssets.length ? `<fieldset class="form-group brochure-asset-fieldset"><legend class="brochure-asset-legend">Assets to send</legend><p class="form-text brochure-asset-note">${configured ? 'Only checked assets will be sent.' : 'All brochure and walkthrough assets are sent until you save a selection.'}</p><div class="brochure-asset-list">${matchingAssets.map(asset => `<label class="checkbox-label brochure-asset-item"><input type="checkbox" data-brochure-asset data-project="${project.id}" value="${asset.id}" ${!configured || selected.has(Number(asset.id)) ? 'checked' : ''}> <span class="brochure-asset-name">${esc(asset.display_name || asset.file_name)}</span> <span class="brochure-asset-badge">(${esc(asset.asset_type)})</span></label>`).join('')}</div></fieldset>` : '<div class="empty-state"><p>No brochure or walkthrough assets are available for this project.</p></div>'}</article>`;
        }).join('');
        const eventRows = events.length ? `<div class="table-container"><table class="data-table"><thead><tr><th>Contact</th><th>Project</th><th>Result</th><th>Assets</th><th>When</th></tr></thead><tbody>${events.map(event => `<tr><td>${esc(event.contact_name || 'Contact')} · ••••${esc(event.phone_last4)}</td><td>${esc(event.project_name || 'Needs clarification')}</td><td>${esc(event.action.replaceAll('_', ' '))}</td><td>${esc(event.asset_count)}</td><td>${esc(event.created_at ? new Date(event.created_at).toLocaleString() : '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>No brochure drops have been recorded yet.</p></div>';
        $('invBrochureContent').innerHTML = `<div class="card brochure-settings-card"><div class="brochure-settings-header"><h2 class="card-title">Brochure Automation Settings</h2><p class="brochure-settings-subtitle">Automatically send digital brochures and walkthroughs when leads ask about properties on WhatsApp.</p></div><form id="invBrochureForm" class="brochure-settings-form"><div class="form-group brochure-toggle-group"><label class="checkbox-label brochure-toggle-label" for="invBrochureEnabled"><input type="checkbox" id="invBrochureEnabled" ${isEnabled ? 'checked' : ''}><span class="brochure-toggle-text"><strong>Enable automatic brochure drops on inbound messages</strong></span></label><p class="card-note brochure-field-hint">When enabled, incoming inquiries with property triggers (e.g. 3BHK, brochure, project name) will automatically receive project brochures and walkthroughs.</p></div><div class="form-group brochure-field-group"><label for="invBrochureDedupHours" class="brochure-field-label">Duplicate send prevention window (hours)</label><div class="brochure-input-wrapper"><input type="number" id="invBrochureDedupHours" min="1" max="720" value="${esc(dedupHours)}" class="brochure-number-input"><span class="brochure-unit-label">hours cooldown</span></div><p class="card-note brochure-field-hint">Prevents sending the same project brochure to the same lead within this cooldown window.</p></div><div class="form-group brochure-field-group"><label for="invBrochureTriggers" class="brochure-field-label">Trigger keywords (one per line)</label><p class="card-note brochure-field-hint brochure-trigger-hint">Project names, RERA numbers, and listing IDs are always matched tenant-by-tenant. Add additional keywords or phrases below.</p><textarea id="invBrochureTriggers" rows="4" maxlength="1900" placeholder="3 BHK&#10;brochure&#10;plot" class="brochure-textarea">${esc(triggers.join('\n'))}</textarea></div><div class="brochure-form-actions"><button class="btn btn-primary" type="submit">Save brochure-drop settings</button></div></form></div><div class="cards-grid brochure-projects-grid">${projectCards || '<div class="empty-state"><p>Add a project before configuring brochure drops.</p></div>'}</div><div class="card brochure-history-card"><div class="brochure-section-header"><h2 class="card-title">Recent brochure drops</h2><p class="brochure-settings-subtitle">Log of automated brochures and media sent to contacts.</p></div>${eventRows}</div>`;
        $('invBrochureForm').addEventListener('submit', saveBrochureDrops);
    }
    async function loadBrochureDrops() {
        show('invBrochureLoading', true); const errEl = $('invBrochureError'); if (errEl) { errEl.hidden = true; errEl.style.display = 'none'; }
        try {
            if (!projects.length) projects = await apiFetch('/api/inventory/projects');
            const assets = (await Promise.all(projects.map(project => apiFetch(`/api/inventory/projects/${project.id}/assets`)))).flat();
            const [settings, events] = await Promise.all([api('/api/settings'), apiFetch('/api/inventory/brochure-drops')]);
            renderBrochureDrops(settings, assets, events);
        } catch (err) { brochureError(`Failed to load brochure-drop settings: ${err.message}`); }
        finally { show('invBrochureLoading', false); }
    }
    async function saveBrochureDrops(event) {
        event.preventDefault();
        const brochureEnabled = $('invBrochureEnabled')?.checked ? 'true' : 'false';
        const dedupHours = $('invBrochureDedupHours')?.value?.trim() || '24';
        const triggerValues = $('invBrochureTriggers').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const selection = {};
        document.querySelectorAll('[data-brochure-asset]').forEach(input => {
            selection[input.dataset.project] ||= [];
            if (input.checked) selection[input.dataset.project].push(Number(input.value));
        });
        const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
        try {
            await api('/api/settings', { method: 'PUT', body: JSON.stringify({ brochure_drop_enabled: brochureEnabled, brochure_dedup_window_hours: dedupHours, brochure_triggers: JSON.stringify(triggerValues), brochure_asset_selection: JSON.stringify(selection) }) });
            toast('Brochure-drop settings saved', 'success'); await loadBrochureDrops();
        } catch (err) { toast(err.message || 'Could not save brochure-drop settings', 'error'); }
        finally { button.disabled = false; }
    }
    async function action(e) { const b = e.target.closest('[data-inv]'); if (!b) return; const type = b.dataset.inv, project = Number(b.dataset.project), unitId = b.dataset.unit; if (type === 'close') return closeModal(); if (type === 'reload-grid') return loadGrid(); if (type === 'reload-brochure') return loadBrochureDrops(); if (type === 'transition') return transition(unitId, b.dataset.transition); if (type === 'edit-unit') return unitForm(units.find(u => Number(u.id) === Number(unitId))); if (type === 'history-unit') return unitHistory(unitId); if (type === 'delete-unit') { if (!window.confirm('Delete this unit? This keeps its audit history but removes it from availability.')) return; try { await apiFetch(`/api/inventory/units/${unitId}`, { method:'DELETE' }); closeModal(); toast('Unit deleted','success'); await loadGrid(); } catch (err) { toast(err.message || 'Could not delete unit','error'); } return; } if (type === 'grid') { showTab('grid'); $('invGridProject').value = String(project); return loadGrid(); } if (type === 'assets') return assets(project); if (type === 'preview-asset') return assetPreview(b.dataset.asset, b.dataset.name, b.dataset.mime); if (type === 'asset-history') return assetHistory(b.dataset.asset, b.dataset.name); if (type === 'send-asset') return sendAsset(project, b.dataset.asset, b.dataset.filename); if (type === 'edit') return projectForm(projects.find(p => Number(p.id) === project)); if (type === 'delete') { if (!window.confirm('Delete this project and its units?')) return; try { await apiFetch(`/api/inventory/projects/${project}`,{method:'DELETE'}); toast('Project deleted','success'); loadProjects(); } catch(err) { toast(err.message || 'Delete failed','error'); } return; } if (type === 'delete-asset') { try { await apiFetch(`/api/inventory/assets/${b.dataset.asset}`,{method:'DELETE'}); toast('Asset deleted','success'); assets(project); } catch(err) { toast(err.message || 'Delete failed','error'); } return; } if (type === 'unit') return manage(unitId); }
    function init() { if (initialized) return loadProjects(); initialized = true; $('invNewProjectBtn').addEventListener('click',()=>projectForm()); $('invNewUnitBtn').addEventListener('click',()=>unitForm()); document.querySelectorAll('[data-inventory-tab]').forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.inventoryTab))); $('invCityFilter').addEventListener('input',()=>renderProjects(filtered())); $('invTypeFilter').addEventListener('change',()=>renderProjects(filtered())); $('invRefreshProjectsBtn').addEventListener('click',loadProjects); $('invGridProject').addEventListener('change',loadGrid); $('invGridStatusFilter').addEventListener('change',filterGrid); $('invGridBhkFilter').addEventListener('input',filterGrid); document.addEventListener('click',action); showTab('projects'); loadProjects(); }
    document.addEventListener('DOMContentLoaded', () => $('nav-inventory')?.addEventListener('click', () => setTimeout(init, 0)));
    return {
        init,
        showTab,
        loadProjects,
        loadGrid,
        filterGrid,
        openNewProject: () => projectForm(),
        openHoldModal,
        openBookModal,
        openReleaseModal,
        manage,
        transition,
        closeModal
    };
})();
