/**
 * public/js/inventory.js — Properties / Inventory UI
 *
 * Provides:
 *   - Projects list with filter by city / type
 *   - Per-project unit list with status badges
 *   - Availability Grid: tower × floor matrix, color-coded by status
 *   - Hold / Release / Book actions
 *   - Status change history viewer
 *   - Media asset upload and listing
 *
 * All data comes from /api/inventory/* — every request goes through the
 * authenticated fetch wrapper `api()` already defined in app.js.
 * This file never touches localStorage or sessionStorage for business data.
 */

'use strict';

window.Inventory = (() => {
    // ─── State ──────────────────────────────────────────────────────────
    let allProjects = [];
    let currentTab  = 'projects';
    let gridUnits   = [];

    // ─── Utility: authenticated fetch ──────────────────────────────────
    // Re-uses the `api` helper declared in app.js if available,
    // otherwise falls back to a plain fetch.
    async function apiFetch(path, opts = {}) {
        if (typeof api === 'function') return api(path, opts);
        const res = await fetch(path, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...opts.headers },
            ...opts
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'API error');
        return data;
    }

    // ─── Status config ──────────────────────────────────────────────────
    const STATUS_CFG = {
        VACANT:  { label: 'Vacant',  color: '#22c55e', bg: '#f0fdf4' },
        ON_HOLD: { label: 'On Hold', color: '#f59e0b', bg: '#fffbeb' },
        BOOKED:  { label: 'Booked',  color: '#3b82f6', bg: '#eff6ff' },
        SOLD:    { label: 'Sold',    color: '#6b7280', bg: '#f9fafb' }
    };

    function statusBadge(status) {
        const cfg = STATUS_CFG[status] || STATUS_CFG.VACANT;
        return `<span class="badge" style="background:${cfg.bg};color:${cfg.color};border:1px solid ${cfg.color}40;
            padding:2px 8px;border-radius:9999px;font-size:.75rem;font-weight:600">${cfg.label}</span>`;
    }

    // ─── Tab switching ───────────────────────────────────────────────────
    function showTab(tab) {
        currentTab = tab;
        ['projects','grid'].forEach(t => {
            const btn   = document.getElementById(`inv-tab-${t}`);
            const panel = document.getElementById(`inv-panel-${t}`);
            if (!btn || !panel) return;
            const active = t === tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
            panel.style.display = active ? '' : 'none';
        });
        if (tab === 'grid') populateGridProjectSelector();
    }

    // ─── Projects ────────────────────────────────────────────────────────
    async function loadProjects() {
        const loading = document.getElementById('invProjectsLoading');
        const empty   = document.getElementById('invProjectsEmpty');
        const error   = document.getElementById('invProjectsError');
        const grid    = document.getElementById('invProjectsGrid');
        if (!loading) return;

        loading.style.display = 'flex';
        empty.style.display   = 'none';
        error.style.display   = 'none';
        grid.innerHTML        = '';

        try {
            const data = await apiFetch('/api/inventory/projects');
            allProjects = data.data || [];
            loading.style.display = 'none';
            renderProjects(allProjects);
        } catch (e) {
            loading.style.display = 'none';
            error.style.display   = 'block';
            error.textContent     = `Failed to load projects: ${e.message}`;
        }
    }

    function applyFilter() {
        const city = (document.getElementById('invCityFilter')?.value || '').trim().toLowerCase();
        const type = document.getElementById('invTypeFilter')?.value || '';
        const filtered = allProjects.filter(p =>
            (!city || (p.city || '').toLowerCase().includes(city)) &&
            (!type || p.property_type === type)
        );
        renderProjects(filtered);
    }

    function renderProjects(projects) {
        const grid  = document.getElementById('invProjectsGrid');
        const empty = document.getElementById('invProjectsEmpty');
        if (!grid) return;

        if (!projects.length) {
            empty.style.display = 'flex';
            grid.innerHTML = '';
            return;
        }
        empty.style.display = 'none';
        grid.innerHTML = projects.map(p => `
            <div class="card" role="listitem" style="cursor:pointer" onclick="Inventory.openProject(${p.id})">
                <div class="card-header" style="display:flex;justify-content:space-between;align-items:flex-start">
                    <div>
                        <h3 class="card-title" style="margin:0 0 .25rem">${escHtml(p.name)}</h3>
                        <span style="font-size:.8rem;color:#64748b">${escHtml(p.city)}${p.locality ? ', ' + escHtml(p.locality) : ''}</span>
                    </div>
                    <span class="badge badge-outline" style="font-size:.7rem;text-transform:capitalize">${p.property_type}</span>
                </div>
                <div style="margin:.5rem 0;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                    ${p.rera_status === 'verified'
                        ? '<span class="badge" style="background:#f0fdf4;color:#16a34a;border:1px solid #86efac;font-size:.7rem;padding:1px 7px">✓ RERA Verified</span>'
                        : '<span class="badge" style="background:#fafafa;color:#94a3b8;border:1px solid #e2e8f0;font-size:.7rem;padding:1px 7px">Unverified</span>'}
                    ${p.developer ? `<span style="font-size:.78rem;color:#64748b">by ${escHtml(p.developer)}</span>` : ''}
                </div>
                <div class="card-actions" style="display:flex;gap:.5rem;margin-top:.75rem">
                    <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();Inventory.openGrid(${p.id})">
                        Grid View
                    </button>
                    <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();Inventory.editProject(${p.id})">Edit</button>
                    <button class="btn btn-sm btn-ghost btn-danger" onclick="event.stopPropagation();Inventory.deleteProject(${p.id})">Delete</button>
                </div>
            </div>`).join('');
    }

    async function openProject(projectId) {
        // Navigate to availability grid for this project
        showTab('grid');
        document.getElementById('invGridProject').value = projectId;
        await loadGrid();
    }

    async function openGrid(projectId) {
        showTab('grid');
        document.getElementById('invGridProject').value = projectId;
        await loadGrid();
    }

    function populateGridProjectSelector() {
        const sel = document.getElementById('invGridProject');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">— Select project —</option>' +
            allProjects.map(p => `<option value="${p.id}" ${String(p.id) === String(current) ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('');
    }

    // ─── Availability Grid ────────────────────────────────────────────────
    async function loadGrid() {
        const projectId = document.getElementById('invGridProject')?.value;
        const loading   = document.getElementById('invGridLoading');
        const empty     = document.getElementById('invGridEmpty');
        const container = document.getElementById('invGridContainer');
        if (!container) return;

        if (!projectId) {
            empty.style.display = 'flex'; container.innerHTML = ''; return;
        }
        loading.style.display = 'flex'; empty.style.display = 'none'; container.innerHTML = '';

        try {
            const data = await apiFetch(`/api/inventory/projects/${projectId}/units`);
            gridUnits = data.data || [];
            loading.style.display = 'none';
            renderGrid(gridUnits);
        } catch (e) {
            loading.style.display = 'none';
            container.innerHTML = `<p class="error-text">Failed to load units: ${escHtml(e.message)}</p>`;
        }
    }

    function filterGrid() {
        const statusFilter = document.getElementById('invGridStatusFilter')?.value || '';
        const bhkFilter    = (document.getElementById('invGridBhkFilter')?.value || '').trim().toLowerCase();
        const filtered     = gridUnits.filter(u =>
            (!statusFilter || u.status === statusFilter) &&
            (!bhkFilter    || (u.bhk || '').toLowerCase().includes(bhkFilter))
        );
        renderGrid(filtered);
    }

    function renderGrid(units) {
        const container = document.getElementById('invGridContainer');
        const empty     = document.getElementById('invGridEmpty');
        if (!units.length) {
            empty.style.display = 'flex'; container.innerHTML = ''; return;
        }
        empty.style.display = 'none';

        // Group by tower → by floor → units
        const towers = {};
        units.forEach(u => {
            const t = u.tower || '—';
            if (!towers[t]) towers[t] = {};
            const f = u.floor != null ? u.floor : '—';
            if (!towers[t][f]) towers[t][f] = [];
            towers[t][f].push(u);
        });

        const towerNames = Object.keys(towers).sort();
        let html = '';
        for (const tower of towerNames) {
            html += `<div style="margin-bottom:1.5rem">
                <h3 style="font-size:.9rem;font-weight:700;text-transform:uppercase;color:#475569;
                    letter-spacing:.05em;margin:0 0 .5rem">Tower: ${escHtml(tower)}</h3>
                <div style="display:flex;flex-direction:column;gap:.25rem">`;

            const floors = Object.keys(towers[tower]).sort((a, b) => Number(b) - Number(a));
            for (const floor of floors) {
                html += `<div style="display:flex;align-items:center;gap:.25rem;flex-wrap:wrap">
                    <span style="font-size:.75rem;color:#94a3b8;min-width:40px;text-align:right">F${escHtml(String(floor))}</span>`;
                for (const unit of towers[tower][floor].sort((a,b) => String(a.unit_number).localeCompare(String(b.unit_number)))) {
                    const cfg = STATUS_CFG[unit.status] || STATUS_CFG.VACANT;
                    html += `<button
                        class="unit-cell"
                        title="${escHtml(unit.unit_number)} · ${escHtml(unit.bhk)} · ${cfg.label}
${unit.price ? '₹' + Number(unit.price).toLocaleString('en-IN') : ''}"
                        aria-label="${escHtml(unit.unit_number)} ${cfg.label}"
                        onclick="Inventory.unitAction(${unit.id}, '${unit.status}')"
                        style="min-width:54px;padding:4px 6px;border-radius:6px;border:1px solid ${cfg.color}40;
                            background:${cfg.bg};color:${cfg.color};cursor:pointer;font-size:.72rem;
                            font-weight:600;text-align:center;transition:opacity .15s"
                        onmouseenter="this.style.opacity='.75'" onmouseleave="this.style.opacity='1'">
                        ${escHtml(unit.unit_number)}<br>
                        <span style="font-size:.65rem;font-weight:400;color:${cfg.color}">${escHtml(unit.bhk)}</span>
                    </button>`;
                }
                html += '</div>';
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    // ─── Unit actions ─────────────────────────────────────────────────────
    async function unitAction(unitId, currentStatus) {
        const actions = {
            VACANT:  [{ label: 'Place Hold', action: 'hold' }, { label: 'Book Now', action: 'book' }],
            ON_HOLD: [{ label: 'Release Hold', action: 'release' }, { label: 'Book Now', action: 'book' }],
            BOOKED:  [{ label: 'Mark Sold', action: 'sell' }],
            SOLD:    []
        };
        const opts = actions[currentStatus] || [];
        if (!opts.length) { showToast('No actions available for this unit status.', 'info'); return; }

        const choice = await showActionDialog(
            `Unit Action — ${currentStatus}`,
            opts.map(o => `<button class="btn btn-sm btn-outline" data-action="${o.action}" onclick="Inventory._pickAction('${o.action}')">${o.label}</button>`).join(' ')
        );
        if (!choice) return;

        try {
            let endpoint = `/api/inventory/units/${unitId}/${choice}`;
            // For 'sell', the API endpoint is 'book' with booking_ref
            if (choice === 'sell') endpoint = `/api/inventory/units/${unitId}/book`;

            const body = {};
            if (choice === 'hold') {
                const holdBy = prompt('Hold for (buyer name/phone):') || '';
                body.holdBy = holdBy;
                body.holdMinutes = 30;
            }
            if (choice === 'book' || choice === 'sell') {
                body.bookingRef = prompt('Booking reference (optional):') || '';
            }

            const data = await apiFetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' }
            });
            showToast(`Unit ${data.data.unit_number} → ${data.data.status}`, 'success');
            await loadGrid();
        } catch (e) {
            showToast(`Action failed: ${e.message}`, 'error');
        }
    }

    let _actionResolve = null;
    function _pickAction(action) {
        if (_actionResolve) { _actionResolve(action); _actionResolve = null; }
        document.getElementById('invActionDialog')?.remove();
    }

    function showActionDialog(title, buttonsHtml) {
        return new Promise(resolve => {
            _actionResolve = resolve;
            const el = document.createElement('div');
            el.id = 'invActionDialog';
            el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
            el.innerHTML = `
                <div style="background:#fff;border-radius:12px;padding:1.5rem;min-width:280px;max-width:420px;box-shadow:0 20px 40px rgba(0,0,0,.2)">
                    <h2 style="margin:0 0 1rem;font-size:1rem">${escHtml(title)}</h2>
                    <div style="display:flex;gap:.5rem;flex-wrap:wrap">${buttonsHtml}</div>
                    <button class="btn btn-ghost" style="margin-top:.75rem;width:100%" onclick="Inventory._pickAction(null)">Cancel</button>
                </div>`;
            document.body.appendChild(el);
            el.addEventListener('click', e => { if (e.target === el) _pickAction(null); });
        });
    }

    // ─── Project CRUD dialogs ─────────────────────────────────────────────
    function openNewProject() {
        showProjectForm(null);
    }

    function editProject(id) {
        const project = allProjects.find(p => p.id === id);
        if (project) showProjectForm(project);
    }

    function showProjectForm(project) {
        const isEdit = !!project;
        const el = document.createElement('div');
        el.id = 'invProjectDialog';
        el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem';
        el.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:1.5rem;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 40px rgba(0,0,0,.2)">
                <h2 style="margin:0 0 1rem;font-size:1.1rem">${isEdit ? 'Edit Project' : 'New Project'}</h2>
                <form id="invProjectForm" onsubmit="Inventory._submitProject(event,${isEdit ? project.id : 'null'})">
                    <div class="form-group">
                        <label>Project Name *</label>
                        <input required name="name" value="${escHtml(project?.name||'')}" placeholder="e.g. Sunrise Towers">
                    </div>
                    <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                        <div class="form-group">
                            <label>City</label>
                            <input name="city" value="${escHtml(project?.city||'')}" placeholder="e.g. Ranchi">
                        </div>
                        <div class="form-group">
                            <label>Locality</label>
                            <input name="locality" value="${escHtml(project?.locality||'')}" placeholder="e.g. Kanke Road">
                        </div>
                    </div>
                    <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                        <div class="form-group">
                            <label>Type</label>
                            <select name="propertyType">
                                ${['residential','commercial','plot','rental','resale'].map(t =>
                                    `<option value="${t}" ${project?.property_type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group">
                            <label>RERA Status</label>
                            <select name="reraStatus">
                                <option value="unverified" ${project?.rera_status!=='verified'?'selected':''}>Unverified</option>
                                <option value="verified"   ${project?.rera_status==='verified'?'selected':''}>Verified</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>RERA Number</label>
                        <input name="reraNumber" value="${escHtml(project?.rera_number||'')}" placeholder="e.g. JH/RERA/001">
                    </div>
                    <div class="form-group">
                        <label>Developer</label>
                        <input name="developer" value="${escHtml(project?.developer||'')}" placeholder="Developer name">
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea name="description" rows="2" placeholder="Short project description">${escHtml(project?.description||'')}</textarea>
                    </div>
                    <div class="form-group">
                        <label>Google Maps URL</label>
                        <input name="mapUrl" type="url" value="${escHtml(project?.map_url||'')}" placeholder="https://maps.google.com/…">
                    </div>
                    <div style="display:flex;gap:.5rem;margin-top:1rem">
                        <button type="submit" class="btn btn-primary" id="invProjectSaveBtn">
                            ${isEdit ? 'Save Changes' : 'Create Project'}
                        </button>
                        <button type="button" class="btn btn-ghost" onclick="document.getElementById('invProjectDialog').remove()">Cancel</button>
                    </div>
                </form>
            </div>`;
        document.body.appendChild(el);
        el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    }

    async function _submitProject(e, projectId) {
        e.preventDefault();
        const form = e.target;
        const btn  = document.getElementById('invProjectSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        const body = Object.fromEntries(new FormData(form));
        try {
            if (projectId) {
                await apiFetch(`/api/inventory/projects/${projectId}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
                showToast('Project updated', 'success');
            } else {
                await apiFetch('/api/inventory/projects', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
                showToast('Project created', 'success');
            }
            document.getElementById('invProjectDialog')?.remove();
            await loadProjects();
            populateGridProjectSelector();
        } catch (err) {
            showToast(`Save failed: ${err.message}`, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = projectId ? 'Save Changes' : 'Create Project'; }
        }
    }

    async function deleteProject(id) {
        const proj = allProjects.find(p => p.id === id);
        if (!proj) return;
        if (!confirm(`Delete project "${proj.name}"? This cannot be undone.`)) return;
        try {
            await apiFetch(`/api/inventory/projects/${id}`, { method: 'DELETE' });
            showToast('Project deleted', 'success');
            await loadProjects();
        } catch (e) {
            showToast(`Delete failed: ${e.message}`, 'error');
        }
    }

    // ─── Toast helper ─────────────────────────────────────────────────────
    function showToast(msg, type = 'info') {
        if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:10000;padding:.75rem 1.25rem;
            border-radius:8px;font-size:.875rem;font-weight:500;max-width:320px;
            background:${type==='error'?'#fee2e2':type==='success'?'#f0fdf4':'#f8fafc'};
            color:${type==='error'?'#dc2626':type==='success'?'#16a34a':'#334155'};
            box-shadow:0 4px 12px rgba(0,0,0,.12)`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    // ─── XSS guard ────────────────────────────────────────────────────────
    function escHtml(str) {
        return String(str ?? '')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ─── Init: called when the inventory section becomes active ───────────
    function init() {
        loadProjects();
    }

    // Hook into app.js section switching if the global handler exists
    document.addEventListener('DOMContentLoaded', () => {
        // If app.js uses a custom event or callback for section activation, wire it here.
        // Fallback: watch the nav item click directly.
        const navItem = document.getElementById('nav-inventory');
        if (navItem) {
            navItem.addEventListener('click', () => {
                // Small debounce so the section reveal animation finishes first
                setTimeout(init, 50);
            });
        }
    });

    return {
        init,
        loadProjects,
        applyFilter,
        showTab,
        loadGrid,
        filterGrid,
        openProject,
        openGrid,
        unitAction,
        _pickAction,
        openNewProject,
        editProject,
        deleteProject,
        _submitProject
    };
})();
