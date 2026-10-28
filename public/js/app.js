/* ═══════════════════════════════════════════════════════════
   WhatsApp Automation Dashboard — Frontend Logic v2
   ═══════════════════════════════════════════════════════════ */

const API = '';

// ─── State ──────────────────────────────────────────────────
let currentSection = 'dashboard';
let CURRENT_USER = null;
let CURRENT_ACCESS_TOKEN = null;

async function refreshSession() {
    try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            if (data.accessToken) {
                CURRENT_ACCESS_TOKEN = data.accessToken;
                return true;
            }
        }
    } catch (e) {}
    return false;
}

// ─── Auth gate ──────────────────────────────────────────────
// Every page under /app requires a logged-in session. If the cookie is
// missing/expired the API returns 401 and we bounce to the login page.
async function checkAuth() {
    try {
        if (!CURRENT_ACCESS_TOKEN) {
            const ok = await refreshSession();
            if (!ok) {
                window.location.href = '/login';
                return false;
            }
        }
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${CURRENT_ACCESS_TOKEN}` }
        });
        if (!res.ok) {
            window.location.href = '/login';
            return false;
        }
        const json = await res.json();
        CURRENT_USER = json.data;

        const nameEl   = document.getElementById('topbarUserName');
        const avatarEl = document.getElementById('topbarAvatar');
        const adminNav = document.getElementById('nav-admin');
        const label = CURRENT_USER.business_name || CURRENT_USER.owner_name || CURRENT_USER.email;
        if (nameEl)   nameEl.textContent = label;
        if (adminNav) {
            adminNav.hidden = CURRENT_USER.role !== 'admin';
        }

        return true;
    } catch (err) {
        window.location.href = '/login';
        return false;
    }
}

async function logout() {
    stopSSE();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    window.location.href = '/login';
}

// ─── API Client ─────────────────────────────────────────────
async function api(endpoint, options = {}) {
    try {
        let headers = { 'Content-Type': 'application/json', ...options.headers };
        if (CURRENT_ACCESS_TOKEN) {
            headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
        }
        
        let res = await fetch(`${API}${endpoint}`, {
            ...options,
            headers
        });
        
        if (res.status === 401) {
            const ok = await refreshSession();
            if (ok) {
                headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
                res = await fetch(`${API}${endpoint}`, {
                    ...options,
                    headers
                });
            } else {
                window.location.href = '/login';
                throw new Error('Not authenticated');
            }
        }
        let data;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!data) {
            throw new Error(`Server returned HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}`);
        }
        if (!data.success) {
            let errMsg = data.error || data.message || `API error (${res.status})`;
            if (typeof errMsg !== 'string') errMsg = JSON.stringify(errMsg);
            if (errMsg === 't' || errMsg.length <= 1) errMsg = data.code || `WhatsApp operation failed (${errMsg})`;
            const errorObj = new Error(errMsg);
            if (data.code) errorObj.code = data.code;
            if (data.ref) errorObj.ref = data.ref;
            errorObj.status = res.status;
            throw errorObj;
        }
        return data.data;
    } catch (err) {
        console.error(`API Error [${endpoint}]:`, err);
        throw err;
    }
}

async function apiWithMeta(endpoint, options = {}) {
    try {
        let headers = { 'Content-Type': 'application/json', ...options.headers };
        if (CURRENT_ACCESS_TOKEN) {
            headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
        }
        
        let res = await fetch(`${API}${endpoint}`, {
            ...options,
            headers
        });
        
        if (res.status === 401) {
            const ok = await refreshSession();
            if (ok) {
                headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
                res = await fetch(`${API}${endpoint}`, {
                    ...options,
                    headers
                });
            } else {
                window.location.href = '/login';
                throw new Error('Not authenticated');
            }
        }
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'API request failed');
        return data;
    } catch (err) {
        console.error(`API Error [${endpoint}]:`, err);
        throw err;
    }
}

// ─── Toast Notifications ────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const iconNames = { success: 'check-circle', error: 'x-circle', info: 'info' };

    let text = message;
    if (typeof text !== 'string') {
        text = text?.message || text?.error || (text ? JSON.stringify(text) : 'Notification');
    }
    if (text === 't' || text.length === 1) {
        text = `Action failed (${text})`;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${Icon(iconNames[type] || 'info')}</span>
        <span class="toast-text">${escapeHtml(text)}</span>
        <button class="toast-close" aria-label="Dismiss notification" type="button">×</button>
    `;
    container.appendChild(toast);
    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 4000);
}

// ─── Error Banner ────────────────────────────────────────────
function showErrorBanner(containerId, message, retryFn) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.hidden = false;
    el.removeAttribute('style');
    el.innerHTML = `
        <div class="error-banner" role="alert">
            <span aria-hidden="true">${Icon('triangle-alert')}</span>
            <span>${escapeHtml(message)}</span>
            ${retryFn ? `<button class="error-retry" type="button">Retry</button>` : ''}
        </div>
    `;
    if (retryFn) {
        el.querySelector('.error-retry').addEventListener('click', () => {
            clearErrorBanner(containerId);
            retryFn();
        });
    }
}

function clearErrorBanner(containerId) {
    const el = document.getElementById(containerId);
    if (el) { el.hidden = true; el.removeAttribute('style'); el.innerHTML = ''; }
}

// ─── Skeleton Helpers ─────────────────────────────────────────
function showSkeleton(id) {
    const el = document.getElementById(id);
    if (el) { el.hidden = false; el.removeAttribute('style'); }
}

function hideSkeleton(id) {
    const el = document.getElementById(id);
    if (el) { el.hidden = true; el.removeAttribute('style'); }
}

// ─── Navigation ─────────────────────────────────────────────
function navigateTo(section) {
    // Guard against being called with nothing. Without this, `undefined`
    // matches every nav item that has no data-section (the Admin link) and
    // matches no section at all — which highlights Admin and blanks the
    // whole page instead of navigating anywhere.
    if (!section) return;

    currentSection = section;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        const active = !!item.dataset.section && item.dataset.section === section;
        item.classList.toggle('active', active);
        item.setAttribute('aria-current', active ? 'page' : 'false');
    });

    document.addEventListener('click', (event) => {
        const mediaButton = event.target.closest('[data-contact-media]');
        if (mediaButton) viewContactMedia(mediaButton.dataset.contactMedia);
    });

    // Show section
    document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === `section-${section}`);
    });

    // Close mobile sidebar
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const menuToggle = document.getElementById('menuToggle');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');

    // Load section data
    loadSectionData(section);
}

function loadSectionData(section) {
    switch (section) {
        case 'dashboard': loadDashboard(); break;
        case 'messages':  loadMessages();  break;
        case 'leads':     loadLeads(); break;
        case 'crm':       loadCrm(); break;
        case 'chatbot':   loadChatbotRules(); break;
        case 'contacts':  loadContactLabels(); loadContacts(0); break;
        case 'campaigns': loadCampaigns(); break;
        case 'scheduled': loadScheduled(); break;
        case 'appointments': loadAppointments(); break;
        case 'settings':  loadSettings(); break;
    }
}

// ─── Settings Tab Switching ──────────────────────────────────
function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;

            // Update tab buttons
            tabs.forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });

            // Update panels
            document.querySelectorAll('.settings-panel').forEach(panel => {
                panel.classList.toggle('active', panel.id === `stab-${target}`);
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
    clearErrorBanner('dashboardError');
    try {
        const stats = await api('/api/dashboard/stats');

        // Update demo mode indicator
        const indicator = document.getElementById('modeIndicator');
        if (indicator) {
            indicator.removeAttribute('style');
            if (stats.demoMode) {
                indicator.innerHTML = `${Icon('flask-conical', 'icon-inline')}Demo Mode`;
                indicator.classList.add('text-warning');
                indicator.classList.remove('text-success');
            } else {
                indicator.innerHTML = `<span class="live-dot"></span>Live`;
                indicator.classList.add('text-success');
                indicator.classList.remove('text-warning');
            }
        }

        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        // ── Messages ──
        animateValue('valSentToday',        stats.sentToday);
        animateValue('valReceivedToday',    stats.receivedToday);
        animateValue('valTotalMessages',    stats.totalMessages);
        animateValue('valPendingScheduled', stats.pendingScheduled);

        // ── Leads ──
        const leads = stats.leads || {};
        animateValue('valDashLeadsTotal',   leads.total || 0);
        animateValue('valDashInterested',   leads.interested || 0);
        animateValue('valDashHighPriority', leads.highPriority || 0);
        animateValue('valDashAwaiting',     stats.awaitingAnalysis || 0);

        // ── Sales pipeline ──
        const crm = stats.crm || {};
        const cur = stats.currency || '₹';
        setText('valDashPipeline', `${cur}${(parseFloat(crm.pipelineValue) || 0).toLocaleString('en-IN')}`);
        animateValue('valDashOpenDeals', crm.openDeals || 0);
        animateValue('valDashWon',       crm.wonDeals || 0);
        animateValue('valDashFollowups', crm.followupsDue || 0);

        // ── Workspace ──
        animateValue('valContacts',    stats.totalContacts);
        animateValue('valActiveRules', stats.activeRules);

        const waEl = document.getElementById('valWaStatus');
        if (waEl) {
            waEl.removeAttribute('style');
            waEl.textContent = stats.waConnected ? 'Connected' : 'Offline';
            waEl.classList.toggle('text-success', Boolean(stats.waConnected));
            waEl.classList.toggle('text-danger', !stats.waConnected);
        }
        const aiEl = document.getElementById('valAiStatus');
        if (aiEl) {
            aiEl.removeAttribute('style');
            aiEl.textContent = stats.aiConfigured ? 'Active' : 'Setup needed';
            aiEl.classList.toggle('text-success', Boolean(stats.aiConfigured));
            aiEl.classList.toggle('text-warning', !stats.aiConfigured);
        }
    } catch (err) {
        showErrorBanner('dashboardError', 'Failed to load dashboard data.', loadDashboard);
    }
}

function animateValue(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const safeTarget = Number.isFinite(target) ? target : (parseInt(target, 10) || 0);
    const start = parseInt(el.textContent, 10) || 0;
    const duration = 600;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(start + (safeTarget - start) * eased);
        if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGES
// ═══════════════════════════════════════════════════════════
function maskConversationPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits ? `••••${digits.slice(-4)}` : 'Unknown contact';
}

async function loadMessages() {
    clearErrorBanner('messagesError');
    try {
        const phone     = document.getElementById('messageSearch')?.value || '';
        const direction = document.getElementById('messageFilter')?.value || '';

        let endpoint = '/api/messages?limit=200';
        if (phone)     endpoint += `&phone=${encodeURIComponent(phone)}`;
        if (direction) endpoint += `&direction=${direction}`;

        const messages = await api(endpoint);
        const tbody = document.getElementById('messagesBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('message-square')}</span>
                            <div class="empty-state-title">No messages found</div>
                            <p>Try adjusting your search or filter.</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td><span class="badge badge-${msg.direction}">${msg.direction === 'incoming' ? Icon('arrow-down-left') + ' In' : Icon('arrow-up-right') + ' Out'}</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm" type="button" data-open-conversation="${escapeHtml(msg.phone)}">${escapeHtml(msg.contact_name || maskConversationPhone(msg.phone))}</button>
                    ${msg.contact_name ? `<br><small class="text-secondary">${maskConversationPhone(msg.phone)}</small>` : ''}
                </td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span>${msg.message_type && msg.message_type !== 'text' ? ` <span class="badge badge-incoming">${escapeHtml(msg.message_type)}</span>` : ''}</td>
                <td><span class="badge badge-${msg.status}">${escapeHtml(msg.status)}</span></td>
                <td class="text-secondary-nowrap">${formatDate(msg.created_at)}</td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('messagesError', 'Failed to load messages.', loadMessages);
        document.getElementById('messagesBody').innerHTML =
            '<tr><td colspan="5" class="empty-state">Could not load messages.</td></tr>';
    }
}

function closeConversationModal() {
    const backdrop = document.getElementById('conversationModalBackdrop');
    if (backdrop) {
        backdrop.hidden = true;
        backdrop.style.display = 'none';
    }
}

async function openConversation(phone) {
    const backdrop = document.getElementById('conversationModalBackdrop');
    const body = document.getElementById('conversationModalBody');
    const title = document.getElementById('conversationModalTitle');
    title.textContent = `Conversation · ${maskConversationPhone(phone)}`;
    body.innerHTML = '<div class="empty-state">Loading conversation…</div>';
    if (backdrop) {
        backdrop.hidden = false;
        backdrop.style.display = 'flex';
    }
    try {
        const messages = await api(`/api/messages/conversation/${encodeURIComponent(phone)}?limit=500`);
        if (!messages.length) {
            body.innerHTML = '<div class="empty-state"><p>No messages in this conversation yet.</p></div>';
            return;
        }
        const contactName = messages.find(message => message.contact_name)?.contact_name || '';
        title.textContent = contactName ? `Conversation · ${contactName}` : `Conversation · ${maskConversationPhone(phone)}`;
        body.innerHTML = `<div class="conversation-thread" aria-live="polite">${messages.map(message => `<article class="conversation-message ${message.direction === 'outgoing' ? 'outgoing' : 'incoming'}"><div class="conversation-media">${message.message_type !== 'text' ? `${escapeHtml(message.message_type)} attachment${message.media_asset_id ? ` <button class="btn btn-secondary btn-sm" type="button" data-message-media="${message.media_asset_id}">Preview</button>` : message.direction === 'incoming' ? ' · metadata only (file is not stored)' : ' (metadata only)'}` : ''}</div><p>${escapeHtml(message.body || '(no text)')}</p><small class="conversation-meta">${escapeHtml(formatDate(message.created_at))} · ${escapeHtml(message.status || 'unknown')}</small></article>`).join('')}</div><form id="conversationReplyForm" class="form-group mt-14"><label for="conversationReply">Manual reply</label><textarea id="conversationReply" rows="3" maxlength="4000" required placeholder="Write a reply…"></textarea><div class="modal-actions"><button class="btn btn-primary" type="submit">Send reply</button><button class="btn btn-secondary" type="button" id="conversationCloseBtn">Close</button></div></form>`;
        body.querySelector('#conversationCloseBtn').addEventListener('click', closeConversationModal);
        body.querySelectorAll('[data-message-media]').forEach(button => button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const response = await fetch(`/api/inventory/assets/${button.dataset.messageMedia}/file`, { credentials: 'include', headers: CURRENT_ACCESS_TOKEN ? { Authorization: `Bearer ${CURRENT_ACCESS_TOKEN}` } : {} });
                if (!response.ok) throw new Error('Media is unavailable');
                const objectUrl = URL.createObjectURL(await response.blob());
                window.open(objectUrl, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
            } catch (err) { showToast(err.message || 'Could not preview media', 'error'); }
            finally { button.disabled = false; }
        }));
        body.querySelector('#conversationReplyForm').addEventListener('submit', async event => {
            event.preventDefault();
            const input = body.querySelector('#conversationReply');
            const button = event.target.querySelector('[type="submit"]');
            const text = input.value.trim();
            if (!text) return;
            button.disabled = true;
            try {
                const idempotencyKey = window.crypto?.randomUUID?.() || `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                await api('/api/messages/send', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ phone, body: text }) });
                showToast('Reply sent', 'success');
                await openConversation(phone); loadMessages();
            } catch (err) { showToast(err.message || 'Could not send reply', 'error'); }
            finally { button.disabled = false; }
        });
    } catch (err) {
        body.innerHTML = `<div class="error-banner" role="alert"><span>${escapeHtml(`Could not load conversation: ${err.message}`)}</span><button class="error-retry" type="button" id="conversationRetryBtn">Retry</button></div>`;
        body.querySelector('#conversationRetryBtn').addEventListener('click', () => openConversation(phone));
    }
}

// ═══════════════════════════════════════════════════════════
//  LEAD ANALYSIS
// ═══════════════════════════════════════════════════════════
const INTEREST_META = {
    interested:     { label: () => Icon('check-circle') + ' Interested',     cls: 'lead-badge-interested' },
    not_interested: { label: () => Icon('x-circle') + ' Not Interested',     cls: 'lead-badge-not-interested' },
    neutral:        { label: () => Icon('minus-circle') + ' Neutral',        cls: 'lead-badge-neutral' },
    unclear:        { label: () => Icon('help-circle') + ' Unclear',         cls: 'lead-badge-neutral' }
};

const PRIORITY_META = {
    high:   { label: () => Icon('flame') + ' High',           cls: 'lead-priority-high' },
    medium: { label: () => Icon('zap') + ' Medium',            cls: 'lead-priority-medium' },
    low:    { label: () => Icon('circle-dashed') + ' Low',     cls: 'lead-priority-low' }
};

async function loadLeads() {
    clearErrorBanner('leadsError');
    try {
        const interest = document.getElementById('leadInterestFilter')?.value || '';
        const priority = document.getElementById('leadPriorityFilter')?.value || '';
        const temperature = document.getElementById('leadTemperatureFilter')?.value || '';

        let endpoint = '/api/leads';
        const params = [];
        if (interest) params.push(`interest=${encodeURIComponent(interest)}`);
        if (priority) params.push(`priority=${encodeURIComponent(priority)}`);
        if (temperature) params.push(`temperature=${encodeURIComponent(temperature)}`);
        if (params.length) endpoint += `?${params.join('&')}`;

        const { leads, stats, pending } = await api(endpoint);

        animateValue('valLeadsTotal',      stats.total);
        animateValue('valLeadsInterested', stats.interested);
        animateValue('valLeadsHigh',       stats.highPriority);
        animateValue('valLeadsPending',    pending.length);

        const container = document.getElementById('leadsList');

        let html = '';

        // Chats not yet analyzed (or with new messages)
        if (pending.length > 0 && !interest && !priority) {
            html += `
                <div class="card mb-16">
                    <h2 class="card-title">${Icon('hourglass', 'icon-inline')}Awaiting Analysis (${pending.length})</h2>
                    <div class="pending-leads">
                        ${pending.map(p => `
                            <div class="pending-lead-row">
                                <div>
                                    <strong>${escapeHtml(p.contact_name || p.phone)}</strong>
                                    <small class="text-secondary-ml-8">${escapeHtml(p.phone)} · ${p.message_count} msgs</small>
                                </div>
                                <button class="btn btn-sm btn-secondary" data-action="analyze-lead" data-phone="${escapeHtml(p.phone)}" type="button">${Icon('brain', 'icon-inline')}Analyze</button>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        }

        if (leads.length === 0) {
            html += `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('target')}</span>
                    <div class="empty-state-title">No lead analyses yet</div>
                    <p>${(interest || priority) ? 'No leads match these filters.' : 'Click "Analyze All Chats" to let the AI review your conversations.'}</p>
                </div>`;
        } else {
            html += leads.map(renderLeadCard).join('');
        }

        container.innerHTML = html;
    } catch (err) {
        showErrorBanner('leadsError', 'Failed to load lead analyses.', loadLeads);
        document.getElementById('leadsList').innerHTML = '';
    }
}

function renderLeadCard(lead) {
    const interest = INTEREST_META[lead.interest_status] || INTEREST_META.unclear;
    const priority = PRIORITY_META[lead.priority] || PRIORITY_META.low;

    let issues = [];
    try { issues = JSON.parse(lead.issues || '[]'); } catch (e) { issues = []; }

    return `
        <div class="card lead-card" data-phone="${escapeHtml(lead.phone)}">
            <div class="lead-card-header">
                <div class="lead-identity">
                    <strong>${escapeHtml(lead.contact_name || lead.phone)}</strong>
                    <small class="text-secondary">${escapeHtml(lead.phone)}</small>
                </div>
                <div class="lead-badges">
                    <span class="lead-badge ${interest.cls}">${interest.label()}</span>
                    <span class="lead-badge ${priority.cls}">${priority.label()}</span>
                    ${lead.crm_lead_temp ? `<span class="lead-badge lead-temp-${escapeHtml(lead.crm_lead_temp.toLowerCase())}">${escapeHtml(lead.crm_lead_temp)}</span>` : ''}
                    <span class="lead-badge lead-badge-score" title="Interest score">${lead.interest_score}/100</span>
                </div>
            </div>

            <div class="lead-summary">${escapeHtml(lead.summary)}</div>

            ${(lead.issue_category || issues.length) ? `
                <div class="lead-issues">
                    ${lead.issue_category ? `<span class="lead-badge lead-badge-category">${Icon('tag')} ${escapeHtml(lead.issue_category)}</span>` : ''}
                    ${issues.length ? `<ul>${issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
                </div>` : ''}

            ${lead.next_action ? `
                <div class="lead-next-action">
                    <strong>${Icon('corner-down-right', 'icon-inline')}Next action:</strong> ${escapeHtml(lead.next_action)}
                </div>` : ''}

            <div class="lead-card-footer">
                <span class="text-secondary-xs">
                    ${escapeHtml(lead.priority_reason || '')}
                    · Sentiment: ${escapeHtml(lead.sentiment)}
                    · ${lead.message_count} msgs
                    · Analyzed ${timeAgo(lead.last_analyzed_at)}
                </span>
                <button class="btn btn-sm btn-secondary" data-action="analyze-lead" data-phone="${escapeHtml(lead.phone)}" type="button" title="Re-analyze with latest messages">${Icon('refresh-cw', 'icon-inline')}Re-analyze</button>
            </div>
        </div>`;
}

async function analyzeLead(phone) {
    showToast(`Analyzing conversation with ${phone}…`, 'info');
    try {
        await api(`/api/leads/analyze/${encodeURIComponent(phone)}`, { method: 'POST' });
        showToast('Analysis complete!', 'success');
        loadLeads();
    } catch (err) {
        showToast(err.message || 'Analysis failed', 'error');
    }
}

async function analyzeAllLeads() {
    const btn = document.getElementById('analyzeAllBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('hourglass')}</span> Analyzing… (this can take a while)`;

    try {
        const result = await api('/api/leads/analyze-all', { method: 'POST' });
        const failedNote = result.failed.length ? `, ${result.failed.length} failed` : '';
        showToast(`Analyzed ${result.analyzed} chat(s), ${result.skipped} already up to date${failedNote}.`,
                  result.failed.length ? 'error' : 'success');
        loadLeads();
    } catch (err) {
        showToast(err.message || 'Bulk analysis failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('brain')}</span> Analyze All Chats`;
    }
}

// ═══════════════════════════════════════════════════════════
//  CRM
// ═══════════════════════════════════════════════════════════
const STAGE_META = {
    new:         { text: 'New',          icon: 'circle-plus',    color: '#6B7280' },
    contacted:   { text: 'Contacted',    icon: 'phone',          color: '#3B82F6' },
    qualified:   { text: 'Qualified',    icon: 'star',           color: '#8B5CF6' },
    proposal:    { text: 'Proposal',     icon: 'file-text',      color: '#F59E0B' },
    negotiation: { text: 'Negotiation',  icon: 'handshake',      color: '#F97316' },
    won:         { text: 'Won',          icon: 'trophy',         color: '#22C55E' },
    lost:        { text: 'Lost',         icon: 'x-circle',       color: '#EF4444' }
};
// `label()` = icon + text (for headers/badges); plain `text` alone for <option> elements
Object.values(STAGE_META).forEach(s => { s.label = () => Icon(s.icon) + ' ' + s.text; });

let crmCurrency = '₹';
let crmDealsCache = [];

function fmtMoney(value) {
    const n = parseFloat(value) || 0;
    return `${crmCurrency}${n.toLocaleString('en-IN')}`;
}

// ─── CRM Analytics Charts ───────────────────────────────────
// Palette validated for colour-vision safety on the cream surface (#FFFDF6).
const CHART_INK = { text: '#23312A', sub: '#7B8378', grid: '#EFE8D8', surface: '#FFFDF6', tooltipBg: '#223129' };
const STAGE_RAMP = ['#79BF94', '#50AC76', '#2F8F58', '#1B7144', '#0D5231']; // ordinal: new → negotiation
const OPEN_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation'];
const INTEREST_ORDER = [
    { key: 'interested',     label: 'Interested',     color: '#1B9457' },
    { key: 'unclear',        label: 'Unclear',        color: '#C99B2E' },
    { key: 'not_interested', label: 'Not Interested', color: '#C4553D' },
    { key: 'neutral',        label: 'Neutral',        color: '#5E7FBF' }
];
const ACTIVITY_COLORS = { outgoing: '#1B9457', incoming: '#3E7CB1' };

let crmCharts = {};

function destroyCrmCharts() {
    Object.values(crmCharts).forEach(c => { try { c.destroy(); } catch (e) {} });
    crmCharts = {};
}

function chartTooltipStyle() {
    return {
        backgroundColor: CHART_INK.tooltipBg,
        titleColor: '#FBF8EE',
        bodyColor: '#FBF8EE',
        padding: 10,
        cornerRadius: 10,
        boxPadding: 4,
        displayColors: true
    };
}

function renderHtmlLegend(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    el.innerHTML = items.map((i, idx) => `
        <div class="chart-legend-row">
            <span class="chart-legend-swatch ${escapeHtml(i.cls || '')}" data-legend-idx="${idx}"></span>
            <span class="chart-legend-label">${escapeHtml(i.label)}</span>
            <span class="chart-legend-value">${i.formatted !== undefined ? i.formatted : i.value} · ${Math.round(i.value / total * 100)}%</span>
        </div>`).join('');
}

function renderCrmCharts(a) {
    const grid = document.getElementById('crmChartsGrid');
    if (!grid) return;
    if (typeof Chart === 'undefined') { grid.hidden = true; return; } // CDN unavailable — charts skipped
    grid.hidden = false;
    destroyCrmCharts();

    Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = CHART_INK.sub;

    const byStage = {};
    (a.stageBreakdown || []).forEach(r => { byStage[r.stage] = r; });
    const stageLabels = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation'];
    const stageCounts = OPEN_STAGES.map(s => byStage[s]?.count || 0);
    const stageValues = OPEN_STAGES.map(s => byStage[s]?.value || 0);
    const cur = a.currency || crmCurrency || '₹';

    // ── 1. Donut: open deals by stage (ordinal green ramp) ──
    const donutEl = document.getElementById('chartStageDeals');
    const legendDealsEl = document.getElementById('legendStageDeals');
    if (donutEl) {
        if (stageCounts.every(c => c === 0)) {
            donutEl.hidden = true;
            if (legendDealsEl) legendDealsEl.innerHTML = '<p class="chart-empty">No open deals yet — analyzed sales chats will appear here.</p>';
        } else {
            donutEl.hidden = false;
            crmCharts.stageDeals = new Chart(donutEl, {
                type: 'doughnut',
                data: {
                    labels: stageLabels,
                    datasets: [{
                        data: stageCounts,
                        backgroundColor: STAGE_RAMP,
                        borderColor: CHART_INK.surface,
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    cutout: '62%',
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: chartTooltipStyle()
                    }
                }
            });
            renderHtmlLegend('legendStageDeals', stageLabels.map((l, i) => ({
                label: l, value: stageCounts[i], color: STAGE_RAMP[i], cls: `swatch-stage-${i}`
            })).filter(i => i.value > 0));
        }
    }

    // ── 2. Bars: pipeline value by stage (same ordinal ramp) ──
    const barEl = document.getElementById('chartStageValue');
    if (barEl) {
        crmCharts.stageValue = new Chart(barEl, {
            type: 'bar',
            data: {
                labels: stageLabels,
                datasets: [{
                    data: stageValues,
                    backgroundColor: STAGE_RAMP,
                    borderRadius: { topLeft: 4, topRight: 4 },
                    maxBarThickness: 34
                }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        ...chartTooltipStyle(),
                        callbacks: { label: (ctx) => ` ${cur}${(ctx.parsed.y || 0).toLocaleString('en-IN')}` }
                    }
                },
                scales: {
                    x: { grid: { display: false }, border: { color: CHART_INK.grid } },
                    y: {
                        beginAtZero: true,
                        grid: { color: CHART_INK.grid },
                        border: { display: false },
                        ticks: { callback: (v) => cur + (v >= 1000 ? (v / 1000) + 'k' : v), maxTicksLimit: 6 }
                    }
                }
            }
        });
    }

    // ── 3. Donut: lead interest mix ──
    const intEl = document.getElementById('chartInterest');
    const legendIntEl = document.getElementById('legendInterest');
    if (intEl) {
        const mixMap = {};
        (a.interestMix || []).forEach(r => { mixMap[r.interest_status] = r.count; });
        const items = INTEREST_ORDER.map(i => ({ ...i, value: mixMap[i.key] || 0 }));
        if (items.every(i => i.value === 0)) {
            intEl.hidden = true;
            if (legendIntEl) legendIntEl.innerHTML = '<p class="chart-empty">No lead analyses yet — run "Analyze All Chats" in the Lead Analysis tab.</p>';
        } else {
            intEl.hidden = false;
            crmCharts.interest = new Chart(intEl, {
                type: 'doughnut',
                data: {
                    labels: items.map(i => i.label),
                    datasets: [{
                        data: items.map(i => i.value),
                        backgroundColor: items.map(i => i.color),
                        borderColor: CHART_INK.surface,
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    cutout: '62%',
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: chartTooltipStyle() }
                }
            });
            renderHtmlLegend('legendInterest', items.map(i => ({ ...i, cls: `swatch-interest-${i.key}` })).filter(i => i.value > 0));
        }
    }

    // ── 4. Line: message activity, last 7 days ──
    const actEl = document.getElementById('chartActivity');
    if (actEl) {
        const days = a.messagesByDay || [];
        const labels = days.map(d => {
            const dt = new Date(d.day + 'T00:00:00');
            return isNaN(dt) ? d.day : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        });
        const lineCommon = {
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderColor: CHART_INK.surface,
            pointHoverBorderWidth: 2,
            tension: 0.35,
            fill: false
        };
        crmCharts.activity = new Chart(actEl, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Incoming', data: days.map(d => d.incoming), borderColor: ACTIVITY_COLORS.incoming, pointHoverBackgroundColor: ACTIVITY_COLORS.incoming, ...lineCommon },
                    { label: 'Outgoing', data: days.map(d => d.outgoing), borderColor: ACTIVITY_COLORS.outgoing, pointHoverBackgroundColor: ACTIVITY_COLORS.outgoing, ...lineCommon }
                ]
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'end',
                        labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, color: CHART_INK.text }
                    },
                    tooltip: chartTooltipStyle()
                },
                scales: {
                    x: { grid: { display: false }, border: { color: CHART_INK.grid } },
                    y: {
                        beginAtZero: true,
                        grid: { color: CHART_INK.grid },
                        border: { display: false },
                        ticks: { precision: 0, maxTicksLimit: 6 }
                    }
                }
            }
        });
    }
}

let isCrmOverdueActive = false;

function getSlaBadge(deal) {
    if (!deal) return '';
    // If first response was recorded:
    if (deal.first_response_at) {
        if (deal.sla_status === 'sla_breached') {
            return `<span class="lead-badge sla-badge sla-breached">${Icon('alert-triangle', 'icon-inline')}Responded Late</span>`;
        }
        return `<span class="lead-badge sla-badge sla-on-time">${Icon('check-circle', 'icon-inline')}Responded</span>`;
    }

    // Dynamic checks for unresponded deals
    const now = Date.now();
    const dueTime = deal.sla_response_due_at ? new Date(deal.sla_response_due_at).getTime() : null;
    const isOverdue = dueTime && now > dueTime && !['won', 'lost'].includes(deal.stage);

    if (deal.sla_status === 'escalated') {
        return `<span class="lead-badge sla-badge sla-escalated">${Icon('shield-alert', 'icon-inline')}Escalated</span>`;
    }
    if (deal.sla_status === 'sla_breached' || isOverdue) {
        return `<span class="lead-badge sla-badge sla-breached">${Icon('alert-triangle', 'icon-inline')}SLA Breached</span>`;
    }
    const isApproaching = dueTime && (dueTime - now <= 15 * 60 * 1000) && (dueTime > now);
    if (deal.sla_status === 'approaching_sla' || deal.sla_status === 'sla_approaching' || isApproaching) {
        return `<span class="lead-badge sla-badge sla-approaching">${Icon('alert-circle', 'icon-inline')}SLA Due Soon</span>`;
    }
    if (deal.sla_status === 'on_time' || deal.sla_status === 'sla_on_time') {
        return `<span class="lead-badge sla-badge sla-on-time">${Icon('clock', 'icon-inline')}SLA OK</span>`;
    }
    return '';
}

async function loadCrm() {
    clearErrorBanner('crmError');
    try {
        const temperature = document.getElementById('crmTemperatureFilter')?.value || '';
        const agentId = document.getElementById('crmAgentFilter')?.value || '';
        const slaStatus = document.getElementById('crmSlaFilter')?.value || '';

        let endpoint = '/api/crm/deals';
        if (isCrmOverdueActive) {
            endpoint = '/api/crm/deals/overdue';
        } else {
            const params = new URLSearchParams();
            if (temperature) params.set('temperature', temperature);
            if (agentId) params.set('agent_id', agentId);
            if (slaStatus) params.set('sla_status', slaStatus);
            const qs = params.toString();
            if (qs) endpoint += '?' + qs;
        }

        const [{ deals, stats, stages, currency }, analytics] = await Promise.all([
            api(endpoint),
            api('/api/crm/analytics').catch(() => null)
        ]);
        crmCurrency = currency || '₹';
        crmDealsCache = deals;

        // Populate agent filter if empty
        const agentFilterEl = document.getElementById('crmAgentFilter');
        if (agentFilterEl && agentFilterEl.options.length <= 1) {
            api('/api/crm/agents').then(agents => {
                (agents || []).forEach(a => {
                    const opt = document.createElement('option');
                    opt.value = a.id;
                    opt.textContent = `${a.name} (${a.role})`;
                    agentFilterEl.appendChild(opt);
                });
            }).catch(() => {});
        }

        document.getElementById('valCrmPipeline').textContent = fmtMoney(stats.pipelineValue);
        animateValue('valCrmOpen', stats.openDeals);
        animateValue('valCrmWon',  stats.wonDeals);
        animateValue('valCrmFollowups', stats.followupsDue);

        if (analytics) renderCrmCharts(analytics);
        else { const g = document.getElementById('crmChartsGrid'); if (g) g.hidden = true; }

        const board = document.getElementById('kanbanBoard');

        if (deals.length === 0) {
            board.innerHTML = `
                <div class="empty-state grid-col-all">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('trending-up')}</span>
                    <div class="empty-state-title">No deals found</div>
                    <p>${isCrmOverdueActive ? 'No overdue deals requiring escalation right now.' : 'Run a lead analysis (Lead Analysis tab) or add a deal manually — sales chats become deals automatically.'}</p>
                </div>`;
            return;
        }

        board.innerHTML = stages.map(stage => {
            const meta = STAGE_META[stage];
            const stageDeals = deals.filter(d => d.stage === stage);
            const stageValue = stageDeals.reduce((sum, d) => sum + (parseFloat(d.deal_value) || 0), 0);
            return `
                <div class="kanban-column" data-stage="${stage}">
                    <div class="kanban-column-header kanban-header-${stage}">
                        <span class="kanban-column-title">${meta.label()}</span>
                        <span class="kanban-column-meta">${stageDeals.length}${stageValue ? ` · ${fmtMoney(stageValue)}` : ''}</span>
                    </div>
                    <div class="kanban-cards">
                        ${stageDeals.map(renderDealCard).join('') || '<div class="kanban-empty">—</div>'}
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        showErrorBanner('crmError', 'Failed to load CRM pipeline.', loadCrm);
        document.getElementById('kanbanBoard').innerHTML = '';
    }
}

function renderDealCard(deal) {
    const followupDue = deal.next_followup_at && new Date(deal.next_followup_at + 'Z') <= new Date()
        && !['won', 'lost'].includes(deal.stage);
    const priorityBadge = deal.priority
        ? `<span class="lead-badge ${(PRIORITY_META[deal.priority] || PRIORITY_META.low).cls}">${(PRIORITY_META[deal.priority] || PRIORITY_META.low).label()}</span>`
        : '';
    const agentBadge = deal.assigned_agent_name
        ? `<span class="lead-badge agent-badge">${Icon('user', 'icon-inline')}${escapeHtml(deal.assigned_agent_name)}</span>`
        : `<span class="lead-badge agent-badge-unassigned">Unassigned</span>`;
    const slaBadge = getSlaBadge(deal);

    return `
        <button class="deal-card" type="button" data-open-deal="${escapeHtml(deal.phone)}">
            <div class="deal-card-top">
                <strong>${escapeHtml(deal.contact_name || deal.phone)}</strong>
                ${deal.deal_value ? `<span class="deal-value">${fmtMoney(deal.deal_value)}</span>` : ''}
            </div>
            ${deal.product_interest ? `<div class="deal-product">${Icon('package', 'icon-inline')}${escapeHtml(deal.product_interest)}</div>` : ''}
            <div class="deal-card-badges">
                ${agentBadge}
                ${slaBadge}
                ${priorityBadge}
                ${deal.lead_temp ? `<span class="lead-badge lead-temp-${escapeHtml(deal.lead_temp.toLowerCase())}">${escapeHtml(deal.lead_temp)}</span>` : ''}
                ${deal.interest_score ? `<span class="lead-badge lead-badge-score">${deal.interest_score}/100</span>` : ''}
                ${followupDue ? `<span class="lead-badge lead-priority-high">${Icon('clock')} Follow up!</span>` : ''}
            </div>
        </button>`;
}

// ─── Deal detail modal ──────────────────────────────────────
let currentDealPhone = null;

async function openDealModal(phone) {
    currentDealPhone = phone;
    const backdrop = document.getElementById('dealModalBackdrop');
    const body = document.getElementById('dealModalBody');
    const title = document.getElementById('dealModalTitle');

    if (backdrop) {
        backdrop.hidden = false;
    }
    body.innerHTML = '<div class="empty-state">Loading deal…</div>';

    try {
        const [{ deal, analysis, activities }, projects, agentsList] = await Promise.all([
            api(`/api/crm/deals/phone/${encodeURIComponent(phone)}`),
            api('/api/inventory/projects'),
            api('/api/crm/agents').catch(() => [])
        ]);
        const assignmentsRes = await api(`/api/crm/deals/${deal.id}/assignments`).catch(() => []);
        const assignments = Array.isArray(assignmentsRes) ? assignmentsRes : (assignmentsRes?.history || assignmentsRes?.data || []);
        title.textContent = deal.contact_name || deal.phone;

        const followupVal = deal.next_followup_at ? deal.next_followup_at.replace(' ', 'T').slice(0, 16) : '';
        const isWhatsAppId = typeof deal.phone === 'string' && (deal.phone.length >= 14 || deal.phone.includes('@lid'));

        // Calculate SLA overdue relative time if breached or escalated
        let overdueText = '';
        if (['sla_breached', 'escalated'].includes(deal.sla_status) && deal.sla_response_due_at && !deal.first_response_at) {
            const dueTime = new Date(deal.sla_response_due_at + (deal.sla_response_due_at.includes('Z') || deal.sla_response_due_at.includes('+') ? '' : 'Z')).getTime();
            const diffMins = Math.max(1, Math.round((Date.now() - dueTime) / 60000));
            const hrs = Math.floor(diffMins / 60);
            const mins = diffMins % 60;
            const diffStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            overdueText = ` <span class="text-danger font-bold">(overdue by ${diffStr})</span>`;
        }

        const humanizeHistoryReason = (code) => {
            if (!code) return 'Manual update';
            const map = {
                sla_escalation: 'SLA escalation',
                auto_inbound: 'Auto-assigned (new inbound)',
                manual: 'Manual reassignment',
                manual_reassign: 'Manual reassignment',
                manual_reassignment: 'Manual reassignment',
                manual_at_creation: 'Assigned at creation',
                workload_rebalance: 'Workload rebalance'
            };
            return map[code] || code.replace(/_/g, ' ');
        };

        body.innerHTML = `
            <div class="deal-detail-grid">
                <div class="form-group">
                    <label>Stage</label>
                    <select id="modalDealStage">
                        ${Object.keys(STAGE_META).map(s =>
                            `<option value="${s}" ${deal.stage === s ? 'selected' : ''}>${STAGE_META[s].text}</option>`).join('')}
                    </select>
                    ${deal.ai_suggested_stage && deal.ai_suggested_stage !== deal.stage
                        ? `<p class="form-text">${Icon('brain', 'icon-inline')}AI suggests: <strong>${escapeHtml(deal.ai_suggested_stage)}</strong></p>` : ''}
                </div>
                <div class="form-group">
                    <label>Deal Value (${escapeHtml(crmCurrency)})</label>
                    <input type="number" id="modalDealValue" value="${parseFloat(deal.deal_value) || 0}" min="0" step="any">
                    ${deal.ai_estimated_value && !parseFloat(deal.deal_value)
                        ? `<p class="form-text">${Icon('brain', 'icon-inline')}AI estimate: ${fmtMoney(deal.ai_estimated_value)}</p>` : ''}
                </div>
                <div class="form-group">
                    <label>Product / Service</label>
                    <input type="text" id="modalDealProduct" value="${escapeHtml(deal.product_interest || '')}">
                </div>
                <div class="form-group">
                    <label>Next Follow-up</label>
                    <input type="datetime-local" id="modalDealFollowup" value="${followupVal}">
                </div>
            </div>

            <div class="form-group">
                <label>Deal Notes</label>
                <textarea id="modalDealNotes" rows="2">${escapeHtml(deal.notes || '')}</textarea>
            </div>

            <div class="modal-section">
                <h3>${Icon('target', 'icon-inline')}Qualification</h3>
                <div class="deal-detail-grid">
                    <div class="form-group"><label for="modalLeadType">Intent</label><select id="modalLeadType"><option value="">Not set</option>${['buy','rent','invest'].map(v => `<option value="${v}" ${deal.lead_type === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
                    <div class="form-group"><label for="modalPreferredBhk">BHK / type</label><input id="modalPreferredBhk" value="${escapeHtml(deal.preferred_bhk || '')}"></div>
                    <div class="form-group"><label for="modalBudgetMin">Minimum budget</label><input id="modalBudgetMin" type="number" min="0" value="${escapeHtml(deal.budget_min ?? '')}"></div>
                    <div class="form-group"><label for="modalBudgetMax">Maximum budget</label><input id="modalBudgetMax" type="number" min="0" value="${escapeHtml(deal.budget_max ?? '')}"></div>
                    <div class="form-group"><label for="modalLocality">Preferred locality</label><input id="modalLocality" value="${escapeHtml(deal.preferred_locality || '')}"></div>
                    <div class="form-group"><label for="modalTimeline">Timeline</label><input id="modalTimeline" value="${escapeHtml(deal.timeline || '')}"></div>
                    <div class="form-group"><label for="modalFinancing">Financing needed</label><select id="modalFinancing"><option value="">Not set</option>${['yes','no','unknown'].map(v => `<option value="${v}" ${deal.financing_needed === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
                    <div class="form-group"><label for="modalVisitPref">Site-visit preference</label><input id="modalVisitPref" value="${escapeHtml(deal.site_visit_pref || '')}"></div>
                    <div class="form-group"><label for="modalProject">Interested project</label><select id="modalProject"><option value="">Not set</option>${projects.map(p => `<option value="${p.id}" ${Number(deal.interested_project_id) === Number(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
                    <div class="form-group">
                        <label>Temperature</label>
                        <div class="deal-assignment-header-item mt-4">
                            <span class="lead-badge lead-temp-${escapeHtml((deal.lead_temp || 'COLD').toLowerCase())}">${escapeHtml(deal.lead_temp || 'COLD')}</span>
                            <span class="text-secondary-sm" title="${escapeHtml(deal.lead_temp_reason || '')}">
                                ${escapeHtml(deal.lead_temp_reason || 'Set by deterministic analysis rules')}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="modal-section">
                <h3>${Icon('users', 'icon-inline')}Lead Assignment &amp; Response SLA</h3>
                <div class="deal-assignment-box">
                    <div class="deal-assignment-row">
                        <div class="deal-assignment-header-item">
                            <span class="deal-assignment-label">Assigned Agent:</span>
                            ${deal.assigned_agent_name
                                ? `<span class="lead-badge agent-badge">${Icon('user', 'icon-inline')}${escapeHtml(deal.assigned_agent_name)} (${escapeHtml(deal.assigned_agent_role || 'agent')})</span>`
                                : '<span class="lead-badge agent-badge-unassigned">Unassigned</span>'}
                        </div>
                        <div class="deal-assignment-header-item">
                            <span class="deal-assignment-label">SLA Status:</span>
                            ${getSlaBadge(deal)}
                        </div>
                    </div>
                    <div class="deal-assignment-row mt-8">
                        <div>
                            <small class="text-secondary">Due: ${deal.sla_response_due_at ? formatDate(deal.sla_response_due_at) : 'None'}${overdueText}</small>
                        </div>
                        <div>
                            <small class="text-secondary">First Replied: ${deal.first_response_at ? formatDate(deal.first_response_at) : 'Pending'}</small>
                        </div>
                    </div>
                    <div class="reassign-form">
                        <select id="modalReassignAgent" aria-label="Reassign to Agent">
                            <option value="">-- Reassign to Agent --</option>
                            ${(agentsList || []).map(a => `<option value="${a.id}" ${deal.assigned_agent_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.role)} - ${escapeHtml(a.routing_status)})</option>`).join('')}
                        </select>
                        <input type="text" id="modalReassignReason" placeholder="Reason (optional)" aria-label="Reassignment reason">
                        <button class="btn btn-secondary btn-sm" id="modalReassignBtn" data-deal-action="reassign" type="button" data-deal-id="${deal.id}">${Icon('shuffle', 'icon-inline')}Reassign</button>
                    </div>
                </div>
                ${assignments && assignments.length ? `
                <div class="assignment-history">
                    <div class="assignment-history-title">Assignment History:</div>
                    ${assignments.map(h => {
                        if (h.reason === 'sla_escalation') {
                            return `
                                <div class="assignment-history-item">
                                    <div>
                                        <span>Escalated to <strong>${escapeHtml(h.to_agent_name || 'Escalation Manager')}</strong> (notified)</span>
                                        ${h.notes ? ` · <span class="text-secondary">${escapeHtml(h.notes)}</span>` : ''}
                                    </div>
                                    <span class="assignment-history-time">${formatDate(h.created_at)}</span>
                                </div>
                            `;
                        }
                        return `
                            <div class="assignment-history-item">
                                <div>
                                    <span>${h.from_agent_name ? escapeHtml(h.from_agent_name) : 'System/New'} → <strong>${escapeHtml(h.to_agent_name || 'Unassigned')}</strong></span>
                                    <span class="text-secondary"> · ${escapeHtml(humanizeHistoryReason(h.reason))}</span>
                                    ${h.notes ? ` · <em>${escapeHtml(h.notes)}</em>` : ''}
                                </div>
                                <span class="assignment-history-time">${formatDate(h.created_at)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>` : ''}
            </div>

            <div class="deal-identifier-bar">
                <span class="deal-assignment-label">${isWhatsAppId ? 'WhatsApp ID:' : 'Phone:'}</span>
                <span class="font-mono font-bold">${escapeHtml(deal.phone)}</span>
                <span class="badge badge-attachment">Source: ${escapeHtml(deal.source || 'whatsapp')}</span>
                ${deal.is_ai_paused ? '<span class="badge badge-warning">AI Paused (Human Takeover)</span>' : ''}
            </div>

            <div class="modal-actions-container">
                <div class="modal-actions-primary">
                    <button class="btn btn-primary btn-sm btn-deal-action" data-deal-action="save" data-deal-id="${deal.id}" type="button">${Icon('save', 'icon-inline')}Save Changes</button>
                    <button class="btn ${deal.is_ai_paused ? 'btn-success' : 'btn-warning'} btn-sm btn-deal-action" data-deal-action="toggle-ai" data-deal-id="${deal.id}" data-deal-paused="${deal.is_ai_paused ? 'true' : 'false'}" type="button">
                        ${deal.is_ai_paused ? Icon('play', 'icon-inline') + ' Resume AI' : Icon('pause', 'icon-inline') + ' Human Takeover (Pause AI)'}
                    </button>
                </div>
                <button class="btn btn-danger btn-sm btn-deal-action" data-deal-action="delete" data-deal-id="${deal.id}" type="button">${Icon('trash-2', 'icon-inline')}Delete Deal</button>
            </div>

            ${analysis ? `
                <div class="modal-section">
                    <h3>${Icon('target', 'icon-inline')}AI Conversation Insight</h3>
                    <div class="lead-summary">${escapeHtml(analysis.summary || '')}</div>
                    ${analysis.next_action ? `<div class="lead-next-action"><strong>${Icon('corner-down-right', 'icon-inline')}Next action:</strong> ${escapeHtml(analysis.next_action)}</div>` : ''}
                </div>` : `
                <div class="modal-section">
                    <h3>${Icon('target', 'icon-inline')}AI Conversation Insight</h3>
                    <p class="text-secondary-sm">Not analyzed yet — run it from the Lead Analysis tab.</p>
                </div>`}

            <div class="modal-section">
                <h3>${Icon('sticky-note', 'icon-inline')}Activity & Notes</h3>
                <div class="note-form">
                    <input type="text" id="modalNewNote" placeholder="Add a note… (e.g. called them, sent quote)">
                    <button class="btn btn-secondary btn-sm" data-deal-action="note" type="button">Add</button>
                </div>
                <div class="activity-timeline" id="modalActivities">
                    ${activities.length ? activities.map(renderActivity).join('') : '<p class="text-secondary-sm">No activity yet.</p>'}
                </div>
            </div>`;
    } catch (err) {
        body.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load deal</div><p>${escapeHtml(err.message)}</p></div>`;
    }
}

function humanizeActivityText(text) {
    if (!text || typeof text !== 'string') return '';
    const map = {
        sla_escalation: 'SLA escalation',
        auto_inbound: 'auto-inbound',
        manual_reassign: 'manual reassignment',
        manual_reassignment: 'manual reassignment',
        manual_at_creation: 'assigned at creation',
        workload_rebalance: 'workload rebalance',
        first_touch: 'first touch',
        response_due: 'response due',
        auto_rule: 'rule-based',
        round_robin: 'round robin'
    };
    return text.replace(/\b(sla_escalation|auto_inbound|manual_reassign(?:ment)?|manual_at_creation|workload_rebalance|first_touch|response_due|auto_rule|round_robin)\b/g, m => map[m] || m.replace(/_/g, ' '));
}

function renderActivity(act) {
    const icons = { note: 'sticky-note', ai: 'brain', stage: 'shuffle', system: 'settings' };
    return `
        <div class="activity-entry">
            <span class="activity-entry-icon">${Icon(icons[act.type] || 'sticky-note')}</span>
            <div class="activity-entry-body">
                <div>${escapeHtml(humanizeActivityText(act.content))}</div>
                <small>${formatDate(act.created_at)}</small>
            </div>
        </div>`;
}

function closeDealModal() {
    const backdrop = document.getElementById('dealModalBackdrop');
    if (backdrop) {
        backdrop.hidden = true;
    }
    currentDealPhone = null;
}

async function saveDealFromModal(dealId) {
    const btn = document.querySelector('[data-deal-action="save"]');
    if (btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Saving…';
    }

    try {
        await api(`/api/crm/deals/${dealId}`, {
            method: 'PUT',
            body: JSON.stringify({
                stage:            document.getElementById('modalDealStage').value,
                deal_value:       document.getElementById('modalDealValue').value,
                product_interest: document.getElementById('modalDealProduct').value,
                next_followup_at: document.getElementById('modalDealFollowup').value
                                    ? document.getElementById('modalDealFollowup').value.replace('T', ' ') : null,
                notes:            document.getElementById('modalDealNotes').value
                ,lead_type:       document.getElementById('modalLeadType').value || null
                ,budget_min:      document.getElementById('modalBudgetMin').value || null
                ,budget_max:      document.getElementById('modalBudgetMax').value || null
                ,preferred_bhk:   document.getElementById('modalPreferredBhk').value
                ,preferred_locality: document.getElementById('modalLocality').value
                ,timeline:        document.getElementById('modalTimeline').value
                ,financing_needed: document.getElementById('modalFinancing').value || null
                ,site_visit_pref: document.getElementById('modalVisitPref').value
                ,interested_project_id: document.getElementById('modalProject').value || null
            })
        });
        showToast('Deal updated', 'success');
        closeDealModal();
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Failed to update deal', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `${Icon('save', 'icon-inline')}Save Changes`;
        }
    }
}

async function deleteDealFromModal(dealId) {
    if (!confirm('Are you sure you want to delete this deal? The conversation history and contact details are kept, but CRM stage tracking will be removed.')) return;
    const btn = document.querySelector('[data-deal-action="delete"]');
    if (btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
    }
    try {
        await api(`/api/crm/deals/${dealId}`, { method: 'DELETE' });
        showToast('Deal deleted', 'success');
        closeDealModal();
        loadCrm();
    } catch (err) {
        showToast('Failed to delete deal', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `${Icon('trash-2', 'icon-inline')}Delete Deal`;
        }
    }
}

async function addNoteFromModal() {
    const input = document.getElementById('modalNewNote');
    const content = input.value.trim();
    if (!content || !currentDealPhone) return;
    try {
        await api(`/api/crm/deals/phone/${encodeURIComponent(currentDealPhone)}/notes`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        input.value = '';
        // Refresh just the modal content
        openDealModal(currentDealPhone);
    } catch (err) {
        showToast('Failed to add note', 'error');
    }
}

async function reassignDealFromModal(dealId) {
    const targetAgentId = document.getElementById('modalReassignAgent')?.value;
    const reason = document.getElementById('modalReassignReason')?.value?.trim();
    if (!targetAgentId) {
        showToast('Please select an agent to reassign to', 'error');
        return;
    }

    const btn = document.getElementById('modalReassignBtn');
    if (btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Reassigning…';
    }

    try {
        await api(`/api/crm/deals/${dealId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ agent_id: targetAgentId, reason })
        });
        showToast('Deal reassigned successfully', 'success');
        if (currentDealPhone) openDealModal(currentDealPhone);
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Reassignment failed', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `${Icon('shuffle', 'icon-inline')}Reassign`;
        }
    }
}

async function toggleAiPauseFromModal(dealId, currentlyPaused) {
    try {
        await api(`/api/crm/deals/${dealId}/pause-ai`, {
            method: 'POST',
            body: JSON.stringify({ paused: !currentlyPaused })
        });
        showToast(!currentlyPaused ? 'AI replies paused (Human Takeover active)' : 'AI replies resumed', 'success');
        if (currentDealPhone) openDealModal(currentDealPhone);
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Failed to toggle AI pause', 'error');
    }
}

// ─── Agent Workload & Management ────────────────────────────
let agentsCache = [];

async function loadAgentWorkload() {
    const listEl = document.getElementById('agentWorkloadList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="empty-state">Loading agents…</div>';
    try {
        const agents = await api('/api/crm/agents/workload');
        agentsCache = agents || [];
        if (!agents || agents.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state grid-col-all">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('users')}</span>
                    <div class="empty-state-title">No agents configured</div>
                    <p>Add agents to enable round-robin and workload-based lead distribution.</p>
                </div>`;
            return;
        }

        listEl.innerHTML = agents.map(a => {
            const pct = Math.min(100, Math.round(a.capacity_used_pct || 0));
            const barClass = pct >= 90 ? 'agent-load-full' : (pct >= 70 ? 'agent-load-high' : '');
            const isAvail = a.routing_status === 'available';

            return `
                <div class="agent-card" data-agent-id="${a.id}">
                    <div class="agent-card-header">
                        <div>
                            <div class="agent-name">${escapeHtml(a.name)}</div>
                            <div class="agent-contact-line">${escapeHtml(a.email)}${a.phone ? ` · ${escapeHtml(a.phone)}` : ''}</div>
                        </div>
                        <span class="agent-role-pill agent-role-${escapeHtml(a.role)}">${escapeHtml(a.role)}</span>
                    </div>
                    <div class="agent-contact-line">
                        Status: <strong class="${isAvail ? 'mode-live' : 'text-secondary'}">${escapeHtml(a.routing_status)}</strong>
                        · Weight: ${a.weight || 1}
                    </div>
                    <div class="agent-load-meter">
                        <div class="agent-load-labels">
                            <span>Active Leads</span>
                            <strong>${a.active_leads_count || 0} / ${a.max_concurrent_leads || 25} (${pct}%)</strong>
                        </div>
                        <div class="agent-load-bar-wrap">
                            <div class="agent-load-bar-fill ${barClass}" data-pct="${pct}"></div>
                        </div>
                    </div>
                    <div class="agent-actions">
                        <button class="btn btn-secondary btn-sm" type="button" data-agent-action="toggle-status" data-agent-id="${a.id}" data-current-status="${a.routing_status}">
                            ${isAvail ? 'Set Busy' : 'Set Available'}
                        </button>
                        <button class="btn btn-secondary btn-sm" type="button" data-agent-action="edit" data-agent-id="${a.id}">
                            ${Icon('edit-2', 'icon-inline')}Edit
                        </button>
                    </div>
                </div>`;
        }).join('');

        listEl.querySelectorAll('.agent-load-bar-fill').forEach(fill => {
            fill.style.width = (fill.dataset.pct || 0) + '%';
        });
    } catch (err) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-state-title">Error loading agents</div><p>${escapeHtml(err.message)}</p></div>`;
    }
}

function openAgentModal(agent = null) {
    const backdrop = document.getElementById('agentModalBackdrop');
    if (!backdrop) return;
    const form = document.getElementById('agentForm');
    if (!form) return;
    form.reset();

    const title = document.getElementById('agentModalTitle');
    const deleteBtn = document.getElementById('deleteAgentBtn');

    if (agent) {
        title.textContent = 'Edit Agent';
        document.getElementById('agentFormId').value = agent.id;
        document.getElementById('agentFormName').value = agent.name || '';
        document.getElementById('agentFormEmail').value = agent.email || '';
        document.getElementById('agentFormPhone').value = agent.phone || '';
        document.getElementById('agentFormRole').value = agent.role || 'agent';
        document.getElementById('agentFormRoutingStatus').value = agent.routing_status || 'available';
        document.getElementById('agentFormStatus').value = agent.status || 'active';
        document.getElementById('agentFormWeight').value = agent.weight || 1;
        document.getElementById('agentFormMaxLeads').value = agent.max_concurrent_leads || 25;
        if (deleteBtn) deleteBtn.hidden = false;
    } else {
        title.textContent = 'Add Agent';
        document.getElementById('agentFormId').value = '';
        document.getElementById('agentFormWeight').value = 1;
        document.getElementById('agentFormMaxLeads').value = 25;
        if (deleteBtn) deleteBtn.hidden = true;
    }

    backdrop.hidden = false;
    backdrop.style.display = 'flex';
}

function closeAgentModal() {
    const backdrop = document.getElementById('agentModalBackdrop');
    if (backdrop) {
        backdrop.hidden = true;
        backdrop.style.display = 'none';
    }
}

async function saveAgentFromForm(e) {
    e.preventDefault();
    const id = document.getElementById('agentFormId').value;
    const data = {
        name: document.getElementById('agentFormName').value.trim(),
        email: document.getElementById('agentFormEmail').value.trim(),
        phone: document.getElementById('agentFormPhone').value.trim() || null,
        role: document.getElementById('agentFormRole').value,
        routing_status: document.getElementById('agentFormRoutingStatus').value,
        status: document.getElementById('agentFormStatus').value,
        weight: parseInt(document.getElementById('agentFormWeight').value, 10) || 1,
        max_concurrent_leads: parseInt(document.getElementById('agentFormMaxLeads').value, 10) || 25
    };

    if (!data.name || !data.email) {
        showToast('Name and email are required', 'error');
        return;
    }

    try {
        if (id) {
            await api(`/api/crm/agents/${id}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
            showToast('Agent updated successfully', 'success');
        } else {
            await api('/api/crm/agents', {
                method: 'POST',
                body: JSON.stringify(data)
            });
            showToast('Agent created successfully', 'success');
        }
        closeAgentModal();
        loadAgentWorkload();
        const filterEl = document.getElementById('crmAgentFilter');
        if (filterEl) filterEl.innerHTML = '<option value="">All agents</option>';
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Failed to save agent', 'error');
    }
}

async function deleteAgentFromForm() {
    const id = document.getElementById('agentFormId').value;
    if (!id || !confirm('Are you sure you want to delete this agent?')) return;
    try {
        await api(`/api/crm/agents/${id}`, { method: 'DELETE' });
        showToast('Agent deleted', 'success');
        closeAgentModal();
        loadAgentWorkload();
        const filterEl = document.getElementById('crmAgentFilter');
        if (filterEl) filterEl.innerHTML = '<option value="">All agents</option>';
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Failed to delete agent', 'error');
    }
}

async function toggleAgentStatus(agentId, currentStatus, btn = null) {
    const nextStatus = currentStatus === 'available' ? 'busy' : 'available';
    if (btn) btn.disabled = true;
    try {
        await api(`/api/crm/agents/${agentId}`, {
            method: 'PUT',
            body: JSON.stringify({ routing_status: nextStatus })
        });
        showToast(`Agent status updated to ${nextStatus}`, 'success');
        await loadAgentWorkload();
    } catch (err) {
        showToast(err.message || 'Failed to update agent status', 'error');
        if (btn) btn.disabled = false;
    }
}

// ═══════════════════════════════════════════════════════════
//  BUSINESS SETUP
// ═══════════════════════════════════════════════════════════
async function loadBusiness() {
    try {
        const biz = await api('/api/business');

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };
        set('bizWebsite',     biz.website);
        set('bizIndustry',    biz.industry);
        set('bizDescription', biz.description);
        set('bizTarget',      biz.targetCustomers);
        set('bizCurrency',    biz.currency);
        set('bizOffers',      biz.offers);

        renderProductList(biz.products || []);
        if (biz.aiProfile) renderBusinessProfile(biz.aiProfile);
    } catch (err) {
        showToast('Failed to load business info', 'error');
    }
}

function renderProductList(products) {
    const container = document.getElementById('productList');
    if (!container) return;

    if (products.length === 0) {
        container.innerHTML = '<p class="text-secondary-sm">No products yet — add your catalog above so the AI can quote it to customers.</p>';
        return;
    }

    container.innerHTML = products.map(p => `
        <div class="product-row ${p.is_active ? '' : 'disabled'}">
            <div class="product-row-info">
                <strong>${escapeHtml(p.name)}</strong>
                ${p.price ? `<span class="lead-badge lead-badge-score">${escapeHtml(p.price)}</span>` : ''}
                ${p.category ? `<span class="lead-badge lead-badge-category">${escapeHtml(p.category)}</span>` : ''}
                ${p.description ? `<div class="product-row-desc">${escapeHtml(p.description)}</div>` : ''}
                ${p.url ? `<div class="product-row-desc"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a></div>` : ''}
            </div>
            <div class="rule-actions">
                <button class="btn btn-sm btn-secondary" data-action="toggle-product" data-id="${p.id}" data-value="${p.is_active ? 0 : 1}" title="${p.is_active ? 'Hide from AI' : 'Show to AI'}" type="button">${Icon(p.is_active ? 'pause' : 'play')}</button>
                <button class="btn btn-sm btn-danger" data-action="delete-product" data-id="${p.id}" title="Delete" type="button">${Icon('trash-2')}</button>
            </div>
        </div>
    `).join('');
}

async function toggleProduct(id, newState) {
    try {
        await api(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: newState }) });
        loadBusiness();
    } catch (err) {
        showToast('Failed to update product', 'error');
    }
}

async function deleteProductRow(id) {
    if (!confirm('Remove this product from the catalog?')) return;
    try {
        await api(`/api/products/${id}`, { method: 'DELETE' });
        showToast('Product removed', 'success');
        loadBusiness();
    } catch (err) {
        showToast('Failed to remove product', 'error');
    }
}

function renderBusinessProfile(profile) {
    const container = document.getElementById('businessProfileResult');
    if (!container) return;

    const list = (arr) => (arr || []).map(i => `<li>${escapeHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('');

    container.innerHTML = `
        <div class="biz-profile">
            <div class="biz-profile-block">
                <h4>${Icon('map-pin', 'icon-inline')}Positioning</h4>
                <p>${escapeHtml(profile.profile_summary || '')}</p>
            </div>
            ${profile.selling_points?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('sparkles', 'icon-inline')}Selling Points</h4>
                    <ul>${list(profile.selling_points)}</ul>
                </div>` : ''}
            ${profile.ideal_customer ? `
                <div class="biz-profile-block">
                    <h4>${Icon('target', 'icon-inline')}Ideal Customer</h4>
                    <p>${escapeHtml(profile.ideal_customer)}</p>
                </div>` : ''}
            ${profile.sales_pitch ? `
                <div class="biz-profile-block">
                    <h4>${Icon('message-circle', 'icon-inline')}Ready-to-send Pitch</h4>
                    <p class="biz-pitch">${escapeHtml(profile.sales_pitch)}</p>
                </div>` : ''}
            ${profile.objection_handling?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('shield', 'icon-inline')}Objection Handling</h4>
                    <ul>${profile.objection_handling.map(o => `<li><strong>${escapeHtml(o.objection || '')}</strong> — ${escapeHtml(o.response || '')}</li>`).join('')}</ul>
                </div>` : ''}
            ${profile.faq?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('help-circle', 'icon-inline')}Suggested FAQ</h4>
                    <ul>${profile.faq.map(f => `<li><strong>${escapeHtml(f.q || '')}</strong> — ${escapeHtml(f.a || '')}</li>`).join('')}</ul>
                </div>` : ''}
            ${profile.improvement_tips?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('trending-up', 'icon-inline')}Tips to Convert More</h4>
                    <ul>${list(profile.improvement_tips)}</ul>
                </div>` : ''}
            ${profile.analyzed_at ? `<small class="text-secondary">Analyzed ${timeAgo(profile.analyzed_at)}</small>` : ''}
        </div>`;
}

async function analyzeBusiness() {
    const btn = document.getElementById('analyzeBusinessBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('hourglass')}</span> Analyzing your business…`;
    try {
        const profile = await api('/api/business/analyze', { method: 'POST' });
        renderBusinessProfile(profile);
        showToast('Business analysis complete! The AI will now use this in replies and lead scoring.', 'success');
    } catch (err) {
        showToast(err.message || 'Business analysis failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('brain')}</span> Analyze My Business`;
    }
}

// ═══════════════════════════════════════════════════════════
//  CHATBOT RULES
// ═══════════════════════════════════════════════════════════
async function loadChatbotRules() {
    clearErrorBanner('chatbotError');
    showSkeleton('rulesSkeleton');
    try {
        const rules = await api('/api/chatbot/rules');
        hideSkeleton('rulesSkeleton');
        const container = document.getElementById('rulesList');

        if (rules.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('bot')}</span>
                    <div class="empty-state-title">No chatbot rules yet</div>
                    <p>Add your first rule above to get started!</p>
                </div>`;
            return;
        }

        container.innerHTML = rules.map(rule => `
            <div class="rule-item ${rule.is_active ? '' : 'disabled'}" data-id="${rule.id}">
                <div class="rule-info">
                    <div class="rule-trigger">
                        <span class="rule-keyword">"${escapeHtml(rule.trigger_keyword)}"</span>
                        <span class="rule-match-type">${escapeHtml(rule.match_type)}</span>
                        ${!rule.is_active ? '<span class="badge badge-cancelled">Disabled</span>' : ''}
                    </div>
                    <div class="rule-response">${escapeHtml(rule.response_text)}</div>
                    <div class="rule-meta">
                        <span>Priority: ${rule.priority}</span>
                        <span aria-hidden="true">•</span>
                        <span>Hits: ${rule.hit_count}</span>
                    </div>
                </div>
                <div class="rule-actions">
                    <button
                        class="btn btn-sm btn-secondary"
                        data-action="toggle-rule" data-id="${rule.id}" data-value="${rule.is_active ? 0 : 1}"
                        title="${rule.is_active ? 'Disable rule' : 'Enable rule'}"
                        aria-label="${rule.is_active ? 'Disable' : 'Enable'} rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        ${Icon(rule.is_active ? 'pause' : 'play')}
                    </button>
                    <button
                        class="btn btn-sm btn-danger"
                        data-action="delete-rule" data-id="${rule.id}"
                        title="Delete rule"
                        aria-label="Delete rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        ${Icon('trash-2')}
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load chatbot rules:', err);
        hideSkeleton('rulesSkeleton');
        showErrorBanner('chatbotError', 'Failed to load chatbot rules.', loadChatbotRules);
        document.getElementById('rulesList').innerHTML = '';
    }
}

async function toggleRule(id, newState) {
    try {
        await api(`/api/chatbot/rules/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: newState })
        });
        showToast(`Rule ${newState ? 'enabled' : 'disabled'}`, 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to update rule', 'error');
    }
}

async function deleteRule(id) {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    try {
        await api(`/api/chatbot/rules/${id}`, { method: 'DELETE' });
        showToast('Rule deleted', 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to delete rule', 'error');
    }
}

async function testChatbot() {
    const input    = document.getElementById('testMessage');
    const resultEl = document.getElementById('testResult');
    const text     = input.value.trim();

    if (!text) { input.focus(); return; }

    const btn = document.getElementById('testChatbotBtn');
    btn.disabled = true;
    btn.textContent = 'Testing…';

    try {
        const result = await api('/api/chatbot/test', {
            method: 'POST',
            body: JSON.stringify({ message: text })
        });

        resultEl.style.display = 'block';

        if (result.matched) {
            resultEl.className = 'test-result matched';
            resultEl.innerHTML = `
                <strong>${Icon('check-circle', 'icon-inline')}Rule #${result.ruleId} matched!</strong><br>
                <strong>Keyword:</strong> "${escapeHtml(result.keyword)}" (${escapeHtml(result.matchType)})<br>
                <strong>Response:</strong> ${escapeHtml(result.response)}
            `;
        } else {
            resultEl.className = 'test-result no-match';
            resultEl.innerHTML = result.willSendDefault
                ? `<strong>${Icon('triangle-alert', 'icon-inline')}No rule matched.</strong> Default reply will be sent:<br>"${escapeHtml(result.defaultReply)}"`
                : `<strong>${Icon('triangle-alert', 'icon-inline')}No rule matched</strong> and no default reply configured.`;
        }
    } catch (err) {
        showToast('Test failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
    }
}

// ═══════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════
// Contacts currently checked for bulk outreach — cleared on every reload
// (a checked contact that scrolls out of a new search/filter shouldn't
// silently stay "selected" for a send the user can no longer see).
let SELECTED_CONTACTS = new Map(); // id -> { id, phone, name }
let LAST_LOADED_CONTACTS = [];
let contactsCurrentOffset = 0;
let contactsCurrentPageSize = 50;
let contactsCurrentTotal = 0;

async function loadContactLabels() {
    const select = document.getElementById('contactLabelFilter');
    if (!select) return;
    try {
        const labels = await api('/api/contacts/labels');
        const list = Array.isArray(labels) ? labels : (labels?.data || []);
        const currentVal = select.value;
        select.innerHTML = '<option value="">All Labels</option>' + list.map(l =>
            `<option value="${escapeHtml(l)}"${l === currentVal ? ' selected' : ''}>${escapeHtml(l)}</option>`
        ).join('');
    } catch (err) {
        console.error('Failed to load contact labels:', err);
    }
}

async function loadContacts(offset = contactsCurrentOffset) {
    clearErrorBanner('contactsError');
    try {
        contactsCurrentOffset = offset;
        const search = document.getElementById('contactSearch')?.value?.trim() || '';
        const label = document.getElementById('contactLabelFilter')?.value?.trim() || '';
        const pageSizeEl = document.getElementById('contactsPageSize');
        if (pageSizeEl) {
            contactsCurrentPageSize = parseInt(pageSizeEl.value, 10) || 50;
        }

        const queryParams = new URLSearchParams({
            limit: String(contactsCurrentPageSize),
            offset: String(contactsCurrentOffset)
        });
        if (search) queryParams.set('search', search);
        if (label) queryParams.set('label', label);

        const res = await apiWithMeta(`/api/contacts?${queryParams.toString()}`);
        const contacts = res.data || [];
        const meta = res.meta || { total: contacts.length, limit: contactsCurrentPageSize, offset: contactsCurrentOffset };
        contactsCurrentTotal = meta.total || 0;

        LAST_LOADED_CONTACTS = contacts;
        SELECTED_CONTACTS.clear();
        updateSelectionBar();
        const tbody = document.getElementById('contactsBody');
        const selectAll = document.getElementById('contactsSelectAll');
        if (selectAll) selectAll.checked = false;

        renderContactsPagination(contactsCurrentTotal, contactsCurrentOffset, contactsCurrentPageSize);

        if (contacts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('users')}</span>
                            <div class="empty-state-title">No contacts found</div>
                            <p>${search || label ? 'Try adjusting your search or label filter.' : 'Add your first contact above, or import a CSV!'}</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = contacts.map(c => `
            <tr>
                <td><input type="checkbox" class="contact-row-check" data-id="${c.id}" data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name || '')}" data-reached="${c.last_outreach_at ? '1' : '0'}" data-opted="${c.is_opted_out ? '1' : '0'}" ${c.is_opted_out ? 'disabled title="Opted-out contacts cannot be selected for outreach"' : ''} aria-label="Select ${escapeHtml(c.name || c.phone)}"></td>
                <td><strong>${escapeHtml(c.name) || '—'}</strong></td>
                <td class="text-secondary">${escapeHtml(c.phone)}</td>
                <td>${c.is_opted_out
                    ? `<span class="badge badge-danger" title="Opted out${c.opt_out_reason ? ': ' + escapeHtml(c.opt_out_reason) : ''}">Opted Out</span>`
                    : `<span class="badge badge-success">Active</span>`}</td>
                <td>${c.label ? `<span class="badge badge-incoming">${escapeHtml(c.label)}</span>` : '—'}</td>
                <td>${c.last_outreach_at
                    ? `<span class="reached-pill" title="${formatDate(c.last_outreach_at)}">${Icon('check-circle')} ${formatDate(c.last_outreach_at)}</span>`
                    : `<span class="not-reached-label">Not yet</span>`}</td>
                <td class="text-secondary-nowrap">${formatDate(c.created_at)}</td>
                <td>
                    <button
                        class="btn btn-sm btn-secondary"
                        data-action="edit-contact" data-id="${c.id}"
                        title="Edit contact"
                        aria-label="Edit contact ${escapeHtml(c.name || c.phone)}"
                        type="button">${Icon('pencil')}</button>
                    <button
                        class="btn btn-sm ${c.is_opted_out ? 'btn-secondary' : 'btn-warning'}"
                        data-action="toggle-optout" data-id="${c.id}" data-opted="${c.is_opted_out ? '1' : '0'}"
                        title="${c.is_opted_out ? 'Opt contact back in' : 'Opt contact out'}"
                        aria-label="Toggle opt out for ${escapeHtml(c.name || c.phone)}"
                        type="button">${Icon(c.is_opted_out ? 'user-check' : 'user-x')}</button>
                    <button
                        class="btn btn-sm btn-danger"
                        data-action="delete-contact" data-id="${c.id}"
                        title="Delete contact"
                        aria-label="Delete contact ${escapeHtml(c.name || c.phone)}"
                        type="button">${Icon('trash-2')}</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.contact-row-check').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = Number(cb.dataset.id);
                if (cb.checked) {
                    if (cb.dataset.opted === '1') {
                        cb.checked = false;
                        SELECTED_CONTACTS.delete(id);
                        updateSelectionBar();
                        return;
                    }
                    SELECTED_CONTACTS.set(id, { id, phone: cb.dataset.phone, name: cb.dataset.name, reached: cb.dataset.reached === '1' });
                } else {
                    SELECTED_CONTACTS.delete(id);
                }
                updateSelectionBar();
            });
        });
    } catch (err) {
        showErrorBanner('contactsError', 'Failed to load contacts.', () => loadContacts(offset));
    }
}

function renderContactsPagination(total, offset, limit) {
    const paginationEl = document.getElementById('contactsPagination');
    const infoEl = document.getElementById('contactsPaginationInfo');
    const prevBtn = document.getElementById('contactsPrevBtn');
    const nextBtn = document.getElementById('contactsNextBtn');

    if (!paginationEl) return;

    if (total === 0) {
        paginationEl.hidden = true;
        return;
    }

    paginationEl.hidden = false;
    const start = offset + 1;
    const end = Math.min(offset + limit, total);
    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (infoEl) {
        infoEl.textContent = `Showing ${start}–${end} of ${total} (Page ${currentPage} of ${totalPages})`;
    }

    if (prevBtn) {
        prevBtn.disabled = offset <= 0;
    }
    if (nextBtn) {
        nextBtn.disabled = offset + limit >= total;
    }
}

function contactsPrevPage() {
    const newOffset = Math.max(0, contactsCurrentOffset - contactsCurrentPageSize);
    loadContacts(newOffset);
}

function contactsNextPage() {
    const newOffset = contactsCurrentOffset + contactsCurrentPageSize;
    loadContacts(newOffset);
}

async function openEditContactModal(contactId) {
    const modal = document.getElementById('editContactModalBackdrop');
    if (!modal) return;
    try {
        const contact = await api(`/api/contacts/${contactId}`);
        if (!contact) throw new Error('Contact details unavailable');

        document.getElementById('editContactId').value = contact.id;
        document.getElementById('editContactName').value = contact.name || '';
        document.getElementById('editContactPhone').value = contact.phone || '';
        document.getElementById('editContactLabel').value = contact.label || '';
        document.getElementById('editContactNotes').value = contact.notes || '';

        const subTitleEl = document.getElementById('editContactSubTitle');
        if (subTitleEl) subTitleEl.textContent = `ID #${contact.id} • Registered ${formatDate(contact.created_at)}`;

        const safetyBox = document.getElementById('editContactSafetyInfo');
        if (safetyBox) {
            const badges = [];
            if (contact.is_opted_out) {
                badges.push(`<span class="badge badge-danger">Opted Out${contact.opt_out_reason ? ': ' + escapeHtml(contact.opt_out_reason) : ''}</span>`);
            } else {
                badges.push(`<span class="badge badge-success">Active Outreach</span>`);
            }
            if (contact.is_ai_paused) {
                badges.push(`<span class="badge badge-warning">AI Paused</span>`);
            }
            safetyBox.innerHTML = badges.length ? `<div class="flex-center-gap-8 mt-2"><strong>Safety Status:</strong> ${badges.join(' ')}</div>` : '';
        }

        modal.hidden = false;
        document.getElementById('editContactName')?.focus();
    } catch (err) {
        showToast(err.message || 'Failed to fetch contact details', 'error');
    }
}

function closeEditContactModal() {
    const modal = document.getElementById('editContactModalBackdrop');
    if (modal) modal.hidden = true;
    const form = document.getElementById('editContactForm');
    if (form) form.reset();
}

async function saveContactFromForm(e) {
    e.preventDefault();
    const id = document.getElementById('editContactId')?.value;
    if (!id) return;

    const saveBtn = document.getElementById('editContactSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
    }

    try {
        const name = document.getElementById('editContactName')?.value?.trim() || '';
        const label = document.getElementById('editContactLabel')?.value?.trim() || '';
        const notes = document.getElementById('editContactNotes')?.value?.trim() || '';

        await api(`/api/contacts/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ name, label, notes })
        });

        showToast('Contact updated successfully', 'success');
        closeEditContactModal();
        loadContactLabels();
        loadContacts(contactsCurrentOffset);
    } catch (err) {
        showToast(err.message || 'Failed to update contact', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
        }
    }
}

function updateSelectionBar() {
    const bar = document.getElementById('contactsSelectionBar');
    const count = document.getElementById('contactsSelectionCount');
    if (!bar || !count) return;
    const n = SELECTED_CONTACTS.size;
    bar.hidden = n === 0;
    bar.style.display = n > 0 ? 'flex' : 'none';
    count.textContent = `${n} contact${n === 1 ? '' : 's'} selected`;
    if (typeof hydrateIcons === 'function') hydrateIcons(bar);
}

/**
 * Replaces the current selection with the next `n` contacts due for
 * outreach — "due" meaning never sent one before, unless the
 * "include already-reached" box is checked. Pulls from whatever's
 * currently loaded (respects the active search filter) in the order the
 * table shows them, so clicking this repeatedly after each send batch
 * naturally works through the list without hand-picking rows.
 */
function quickSelectNext(n) {
    const includeReached = document.getElementById('quickSelectIncludeReached').checked;
    const pool = LAST_LOADED_CONTACTS.filter(c => !c.is_opted_out && (includeReached || !c.last_outreach_at));
    const picked = pool.slice(0, n);

    SELECTED_CONTACTS.clear();
    picked.forEach(c => SELECTED_CONTACTS.set(c.id, { id: c.id, phone: c.phone, name: c.name, reached: !!c.last_outreach_at }));

    document.querySelectorAll('.contact-row-check').forEach(cb => {
        cb.checked = SELECTED_CONTACTS.has(Number(cb.dataset.id));
    });
    const eligibleCount = LAST_LOADED_CONTACTS.filter(c => !c.is_opted_out).length;
    document.getElementById('contactsSelectAll').checked = eligibleCount > 0 && picked.length === eligibleCount;
    updateSelectionBar();

    if (picked.length === 0) {
        showToast(includeReached ? 'No eligible contacts to select' : 'All eligible contacts have already been reached — check "include already-reached" to pick anyway', 'info');
    } else if (picked.length < n) {
        showToast(`Only ${picked.length} eligible contact${picked.length === 1 ? '' : 's'} available — selected all of them`, 'info');
    } else {
        showToast(`Selected ${picked.length} contacts`, 'success');
    }
}

async function toggleContactOptOut(id, currentlyOptedOut) {
    try {
        await api(`/api/contacts/${id}/opt-out`, {
            method: 'POST',
            body: JSON.stringify({ opted_out: !currentlyOptedOut })
        });
        showToast(!currentlyOptedOut ? 'Contact opted out' : 'Contact opted back in', 'success');
        loadContacts(contactsCurrentOffset);
    } catch (err) {
        showToast(err.message || 'Failed to toggle opt-out', 'error');
    }
}

async function deleteContact(id) {
    if (!confirm('Delete this contact?')) return;
    try {
        await api(`/api/contacts/${id}`, { method: 'DELETE' });
        showToast('Contact deleted', 'success');
        loadContactLabels();
        loadContacts(contactsCurrentOffset);
    } catch (err) {
        showToast('Failed to delete contact', 'error');
    }
}

// Incoming files are intentionally logged as metadata only: WhatsApp media is
// not downloaded or persisted locally. This view therefore opens the existing
// tenant-scoped message log rather than pretending a retained file is available.
function viewContactMedia(phone) {
    const search = document.getElementById('messageSearch');
    const direction = document.getElementById('messageFilter');
    if (search) search.value = phone;
    if (direction) direction.value = 'incoming';
    navigateTo('messages');
    loadMessages();
}

// ─── CSV import ─────────────────────────────────────────────
function downloadCsvTemplate() {
    const csv = 'phone,name,label,notes\n919876543210,Jane Doe,Customer,Met at the trade show\n919812345678,John Smith,Lead,';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'contacts_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function handleCsvFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('csvFileName').textContent = file.name;

    // 1MB matches the server's JSON body limit — catch an oversized file
    // client-side with a clear reason instead of a generic request-failed error.
    if (file.size > 1024 * 1024) {
        showToast('That file is too large (over 1MB) — split it into smaller files and import each separately', 'error');
        e.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
        const resultBox = document.getElementById('csvImportResult');
        resultBox.style.display = 'block';
        resultBox.innerHTML = `<p class="text-secondary">Importing…</p>`;
        try {
            const result = await api('/api/contacts/import', {
                method: 'POST',
                body: JSON.stringify({ csv: reader.result })
            });
            const parts = [];
            if (result.imported) parts.push(`${result.imported} added`);
            if (result.updated)  parts.push(`${result.updated} updated`);
            if (result.skipped)  parts.push(`${result.skipped} skipped`);
            resultBox.innerHTML = `
                <p class="text-success-bold">
                    ${Icon('check-circle')} Import complete — ${parts.join(', ') || 'nothing to do'} (of ${result.total} rows).
                </p>
                ${result.errors.length ? `
                    <details class="mt-8">
                        <summary class="cursor-pointer-secondary">${result.errors.length} row${result.errors.length === 1 ? '' : 's'} skipped — why</summary>
                        <ul class="text-secondary mt-6 text-sm">
                            ${result.errors.slice(0, 50).map(e => `<li>Row ${e.row}: ${escapeHtml(e.reason)}</li>`).join('')}
                            ${result.errors.length > 50 ? `<li>…and ${result.errors.length - 50} more</li>` : ''}
                        </ul>
                    </details>` : ''}
            `;
            showToast('CSV import complete', 'success');
            loadContactLabels();
            loadContacts(0);
        } catch (err) {
            resultBox.innerHTML = `<p class="text-error">${Icon('x-circle')} ${escapeHtml(err.message || 'Import failed')}</p>`;
        } finally {
            e.target.value = '';
        }
    };
    reader.onerror = () => showToast('Could not read that file', 'error');
    reader.readAsText(file);
}

// ─── Bulk outreach ──────────────────────────────────────────
let OUTREACH_POLL_TIMER = null;
let OUTREACH_POLL_ERRORS = 0;
let outreachAvailableAssets = [];

function formatAssetDisplayName(name) {
    if (!name || typeof name !== 'string') return '';
    const m = name.trim().match(/^(\d+)_(\d{10,15})_(.+)$/);
    return m ? m[3] : name.trim();
}

async function populateOutreachMediaSelect() {
    const select = document.getElementById('outreachMediaSelect');
    const clearBtn = document.getElementById('outreachClearMediaBtn');
    const previewCard = document.getElementById('outreachMediaPreviewCard');
    if (!select) return;

    select.innerHTML = '<option value="">Loading property media…</option>';
    if (clearBtn) clearBtn.hidden = true;
    if (previewCard) previewCard.hidden = true;

    try {
        const assets = await api('/api/inventory/assets');
        outreachAvailableAssets = Array.isArray(assets) ? assets : [];

        if (outreachAvailableAssets.length === 0) {
            select.innerHTML = '<option value="">No media assets found (Text only)</option>';
            return;
        }

        let optionsHtml = '<option value="">No attachment (Text only)</option>';
        for (const a of outreachAvailableAssets) {
            const projectLabel = a.project_name ? `[${a.project_name}] ` : '';
            const typeLabel = (a.asset_type || 'file').toUpperCase();
            const sizeMb = a.size_bytes ? ` (${(a.size_bytes / (1024 * 1024)).toFixed(1)} MB)` : '';
            const displayName = formatAssetDisplayName(a.display_name || a.file_name);
            optionsHtml += `<option value="${a.id}">${escapeHtml(projectLabel + typeLabel + ': ' + displayName + sizeMb)}</option>`;
        }
        select.innerHTML = optionsHtml;
    } catch (err) {
        select.innerHTML = '<option value="">No attachment (Failed to load media)</option>';
    }
}

function onOutreachMediaChange() {
    const select = document.getElementById('outreachMediaSelect');
    const clearBtn = document.getElementById('outreachClearMediaBtn');
    const previewCard = document.getElementById('outreachMediaPreviewCard');
    const previewTitle = document.getElementById('outreachMediaPreviewTitle');
    const previewMeta = document.getElementById('outreachMediaPreviewMeta');
    const previewLink = document.getElementById('outreachMediaPreviewLink');
    const emptyState = document.getElementById('outreachMediaEmptyState');

    const selectedId = Number(select?.value);
    if (!selectedId) {
        if (clearBtn) clearBtn.hidden = true;
        if (previewCard) previewCard.hidden = true;
        if (emptyState) emptyState.hidden = false;
        updateOutreachModalSelectionState();
        return;
    }

    const asset = outreachAvailableAssets.find(a => Number(a.id) === selectedId);
    if (!asset) {
        if (clearBtn) clearBtn.hidden = true;
        if (previewCard) previewCard.hidden = true;
        if (emptyState) emptyState.hidden = false;
        updateOutreachModalSelectionState();
        return;
    }

    if (emptyState) emptyState.hidden = true;
    if (clearBtn) clearBtn.hidden = false;
    if (previewCard) {
        previewCard.hidden = false;
        if (previewTitle) previewTitle.textContent = formatAssetDisplayName(asset.display_name || asset.file_name);
        if (previewMeta) {
            const sizeStr = asset.size_bytes ? `${(asset.size_bytes / (1024 * 1024)).toFixed(1)} MB` : '';
            const projectStr = asset.project_name ? `Project: ${asset.project_name}` : '';
            const typeStr = asset.asset_type ? `Type: ${asset.asset_type}` : '';
            previewMeta.textContent = [projectStr, typeStr, sizeStr].filter(Boolean).join(' • ');
        }
        if (previewLink) {
            previewLink.href = `/api/inventory/assets/${asset.id}/file`;
        }
    }
    updateOutreachModalSelectionState();
}

function clearOutreachMedia() {
    const select = document.getElementById('outreachMediaSelect');
    if (select) select.value = '';
    onOutreachMediaChange();
}

let OUTREACH_PICKER_CONTACTS = [];
let COMPOSER_CSV_TEXT = '';
let COMPOSER_CSV_ROWS = [];
let COMPOSER_CSV_VALID_PHONES = new Set();

async function loadOutreachPickerContacts(search = '', label = '') {
    const list = document.getElementById('outreachContactPickerList');
    if (list) {
        list.innerHTML = '<div class="p-xs text-secondary-sm text-center">Loading contacts…</div>';
    }
    try {
        const queryParams = new URLSearchParams({ limit: '100', offset: '0' });
        if (search) queryParams.set('search', search);
        if (label) queryParams.set('label', label);
        const res = await apiWithMeta(`/api/contacts?${queryParams.toString()}`);
        
        // Deduplicate contacts by phone number to prevent duplicates in picker
        const seenPhones = new Set();
        const deduped = [];
        for (const c of (res.data || [])) {
            const p = String(c.phone || '').trim();
            if (!p || seenPhones.has(p)) continue;
            seenPhones.add(p);
            deduped.push(c);
        }
        OUTREACH_PICKER_CONTACTS = deduped;
        renderOutreachPickerList();
    } catch (err) {
        if (list) {
            list.innerHTML = '<div class="p-xs text-danger text-center">Failed to load contacts</div>';
        }
    }
}

async function loadOutreachPickerLabels() {
    try {
        const labels = await api('/api/contacts/labels');
        const filter = document.getElementById('outreachContactLabelFilter');
        if (filter && Array.isArray(labels)) {
            const currentVal = filter.value;
            filter.innerHTML = '<option value="">All Labels</option>' + 
                labels.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
            filter.value = currentVal;
        }
    } catch (_) {}
}

function renderOutreachPickerList() {
    const list = document.getElementById('outreachContactPickerList');
    if (!list) return;

    if (!OUTREACH_PICKER_CONTACTS || OUTREACH_PICKER_CONTACTS.length === 0) {
        list.innerHTML = '<div class="p-xs text-secondary-sm text-center">No contacts found</div>';
        return;
    }

    list.innerHTML = OUTREACH_PICKER_CONTACTS.map(c => {
        const isSelected = SELECTED_CONTACTS.has(c.id);
        const isOptedOut = !!c.is_opted_out;
        const reachedBadge = c.last_outreach_at ? '<span class="badge badge-incoming text-xs">Reached</span>' : '';
        const optedBadge = isOptedOut ? '<span class="badge badge-danger text-xs">Opted Out</span>' : '';
        const labelBadge = c.label ? `<span class="badge badge-subtle text-xs">${escapeHtml(c.label)}</span>` : '';

        return `
            <label class="recipient-row ${isSelected ? 'recipient-row-selected' : ''} ${isOptedOut ? 'recipient-row-opted' : 'cursor-pointer'}">
                <input type="checkbox" class="recipient-checkbox outreach-picker-check" data-id="${c.id}" data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name || '')}" data-reached="${c.last_outreach_at ? '1' : '0'}" ${isSelected ? 'checked' : ''} ${isOptedOut ? 'disabled' : ''}>
                <div class="recipient-identity">
                    <div class="recipient-name">${escapeHtml(c.name || c.phone)}</div>
                    <div class="recipient-phone">${escapeHtml(c.phone)}</div>
                </div>
                <div class="recipient-badges">
                    ${labelBadge}
                    ${reachedBadge}
                    ${optedBadge}
                </div>
            </label>
        `;
    }).join('');

    list.querySelectorAll('.outreach-picker-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = Number(cb.dataset.id);
            if (cb.checked) {
                if (SELECTED_CONTACTS.size >= 25) {
                    cb.checked = false;
                    showToast('Outreach is capped at 25 recipients per campaign', 'warning');
                    return;
                }
                SELECTED_CONTACTS.set(id, { id, phone: cb.dataset.phone, name: cb.dataset.name, reached: cb.dataset.reached === '1' });
            } else {
                SELECTED_CONTACTS.delete(id);
            }
            renderOutreachPickerList();
            updateOutreachModalSelectionState();
            updateSelectionBar();
        });
    });
}

function quickSelectOutreachPicker(n) {
    SELECTED_CONTACTS.clear();
    const eligible = OUTREACH_PICKER_CONTACTS.filter(c => !c.is_opted_out);
    eligible.sort((a, b) => (a.last_outreach_at ? 1 : 0) - (b.last_outreach_at ? 1 : 0));
    const toPick = eligible.slice(0, Math.min(n, 25));
    toPick.forEach(c => {
        SELECTED_CONTACTS.set(c.id, { id: c.id, phone: c.phone, name: c.name, reached: !!c.last_outreach_at });
    });
    renderOutreachPickerList();
    updateOutreachModalSelectionState();
    updateSelectionBar();
}

function selectEligibleOutreachPicker() {
    const eligible = OUTREACH_PICKER_CONTACTS.filter(c => !c.is_opted_out);
    if (eligible.length === 0) {
        showToast('No eligible contacts to select', 'info');
        return;
    }
    const allSelected = eligible.every(c => SELECTED_CONTACTS.has(c.id));
    if (allSelected) {
        eligible.forEach(c => SELECTED_CONTACTS.delete(c.id));
    } else {
        for (const c of eligible) {
            if (SELECTED_CONTACTS.size >= 25) {
                showToast('Campaign is capped at 25 recipients maximum', 'info');
                break;
            }
            SELECTED_CONTACTS.set(c.id, { id: c.id, phone: c.phone, name: c.name, reached: !!c.last_outreach_at });
        }
    }
    renderOutreachPickerList();
    updateOutreachModalSelectionState();
    updateSelectionBar();
}

function clearOutreachPickerSelection() {
    SELECTED_CONTACTS.clear();
    renderOutreachPickerList();
    updateOutreachModalSelectionState();
    updateSelectionBar();
}

function updateOutreachModalSelectionState() {
    const total = SELECTED_CONTACTS.size;
    const countEl = document.getElementById('outreachRecipientCount');
    if (countEl) {
        countEl.textContent = `${total} contact${total === 1 ? '' : 's'} selected (max 25)`;
    }

    const pillEl = document.getElementById('outreachRecipientPill');
    if (pillEl) {
        pillEl.textContent = `${total} / 25 selected`;
        if (total >= 25) {
            pillEl.classList.add('limit-reached');
        } else {
            pillEl.classList.remove('limit-reached');
        }
    }

    const mediaSelect = document.getElementById('outreachMediaSelect');
    const selectedMediaOpt = mediaSelect && mediaSelect.selectedIndex > 0 ? mediaSelect.options[mediaSelect.selectedIndex].text : '';
    const summaryTextEl = document.getElementById('outreachSummaryText');
    if (summaryTextEl) {
        const mediaPart = selectedMediaOpt ? `Media: ${selectedMediaOpt}` : 'Text only';
        summaryTextEl.textContent = `${total} recipient${total === 1 ? '' : 's'} selected • ${mediaPart}`;
    }

    const alreadyReached = Array.from(SELECTED_CONTACTS.values()).filter(c => c.reached).length;
    const warningEl = document.getElementById('outreachReachedWarning');
    if (warningEl) {
        if (alreadyReached > 0) {
            warningEl.hidden = false;
            warningEl.textContent = `${alreadyReached} of these contacts have already received outreach previously.`;
        } else {
            warningEl.hidden = true;
        }
    }
    updateOutreachSendBtnState();
}

function updateOutreachMessageStats() {
    const msg = (document.getElementById('outreachMessage')?.value || '');
    const charCountEl = document.getElementById('outreachCharCount');
    if (charCountEl) {
        charCountEl.textContent = `${msg.length} char${msg.length === 1 ? '' : 's'}`;
    }
    updateOutreachSendBtnState();
}

function insertNameTokenToMessage() {
    const textarea = document.getElementById('outreachMessage');
    if (!textarea) return;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + '{{name}}' + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 8;
    textarea.focus();
    updateOutreachMessageStats();
}

function switchComposerTab(tabName) {
    const tabExisting = document.getElementById('tabSelectExisting');
    const tabCsv = document.getElementById('tabImportCsv');
    const paneExisting = document.getElementById('paneSelectExisting');
    const paneCsv = document.getElementById('paneImportCsv');

    if (tabName === 'csv') {
        if (tabExisting) { tabExisting.classList.remove('active'); tabExisting.setAttribute('aria-selected', 'false'); }
        if (tabCsv) { tabCsv.classList.add('active'); tabCsv.setAttribute('aria-selected', 'true'); }
        if (paneExisting) { paneExisting.hidden = true; }
        if (paneCsv) { paneCsv.hidden = false; }
    } else {
        if (tabCsv) { tabCsv.classList.remove('active'); tabCsv.setAttribute('aria-selected', 'false'); }
        if (tabExisting) { tabExisting.classList.add('active'); tabExisting.setAttribute('aria-selected', 'true'); }
        if (paneCsv) { paneCsv.hidden = true; }
        if (paneExisting) { paneExisting.hidden = false; }
    }
    const modal = document.getElementById('outreachModal');
    if (modal && typeof hydrateIcons === 'function') hydrateIcons(modal);
}

function handleComposerCsvSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const fileNameEl = document.getElementById('outreachCsvFileName');
    if (fileNameEl) fileNameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

    const previewArea = document.getElementById('outreachCsvPreviewArea');
    const resultBox = document.getElementById('outreachCsvResult');
    if (resultBox) resultBox.hidden = true;

    if (!file.name.toLowerCase().endsWith('.csv') && file.type && !file.type.includes('csv')) {
        showToast('Please select a valid CSV file (.csv)', 'error');
        e.target.value = '';
        if (fileNameEl) fileNameEl.textContent = 'Invalid file type';
        return;
    }

    if (file.size > 1024 * 1024) {
        showToast('File too large (over 1MB). Please split into smaller files.', 'error');
        e.target.value = '';
        if (fileNameEl) fileNameEl.textContent = 'File too large (>1MB)';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const text = reader.result;
        if (!text || !text.trim()) {
            showToast('The selected CSV file is empty', 'error');
            if (previewArea) previewArea.hidden = true;
            return;
        }

        parseAndPreviewComposerCsv(text);
    };
    reader.onerror = () => showToast('Could not read the selected CSV file', 'error');
    reader.readAsText(file);
}

function parseAndPreviewComposerCsv(rawText) {
    COMPOSER_CSV_TEXT = rawText;
    COMPOSER_CSV_ROWS = [];
    COMPOSER_CSV_VALID_PHONES.clear();

    const previewArea = document.getElementById('outreachCsvPreviewArea');
    const summaryEl = document.getElementById('outreachCsvValidationSummary');
    const tbody = document.getElementById('outreachCsvPreviewTbody');
    const confirmBtn = document.getElementById('outreachConfirmImportBtn');

    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
        showToast('CSV must have a header row and at least one contact row', 'error');
        if (previewArea) previewArea.hidden = true;
        if (confirmBtn) confirmBtn.disabled = true;
        return;
    }

    const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
    const phoneIdx = headers.findIndex(h => /^(phone|mobile|tel|whatsapp|contact_number|cell)/i.test(h));
    const nameIdx = headers.findIndex(h => /^(name|full_name|contact_name|first_name)/i.test(h));
    const labelIdx = headers.findIndex(h => /^(label|tag|category|stage)/i.test(h));

    if (phoneIdx === -1) {
        showToast("Required column 'phone' was not found in CSV header", 'error');
        if (summaryEl) {
            summaryEl.innerHTML = '<span class="text-danger">Missing required column "phone" in CSV header.</span>';
        }
        if (previewArea) previewArea.hidden = false;
        if (confirmBtn) confirmBtn.disabled = true;
        return;
    }

    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;
    const seenInFile = new Set();
    const rowsParsed = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^["']|["']$/g, '').trim());
        const rawPhone = cols[phoneIdx] || '';
        const name = nameIdx !== -1 ? cols[nameIdx] || '' : '';
        const label = labelIdx !== -1 ? cols[labelIdx] || '' : '';
        const cleanPhone = rawPhone.replace(/\D/g, '');

        let status = 'valid';
        let statusLabel = '<span class="badge badge-outgoing text-xs">Valid</span>';

        if (!cleanPhone || cleanPhone.length < 7) {
            status = 'invalid';
            statusLabel = '<span class="badge badge-danger text-xs">Invalid phone</span>';
            invalidCount++;
        } else if (seenInFile.has(cleanPhone)) {
            status = 'duplicate';
            statusLabel = '<span class="badge badge-pending text-xs">Duplicate in file</span>';
            duplicateCount++;
        } else {
            seenInFile.add(cleanPhone);
            COMPOSER_CSV_VALID_PHONES.add(cleanPhone);
            validCount++;
        }

        rowsParsed.push({
            rowNum: i,
            phone: rawPhone,
            cleanPhone,
            name,
            label,
            status,
            statusLabel
        });
    }

    COMPOSER_CSV_ROWS = rowsParsed;

    if (previewArea) previewArea.hidden = false;
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="flex-center-gap-8 flex-wrap">
                <span class="badge badge-outgoing font-bold">${validCount} Valid</span>
                ${invalidCount > 0 ? `<span class="badge badge-danger">${invalidCount} Invalid</span>` : ''}
                ${duplicateCount > 0 ? `<span class="badge badge-pending">${duplicateCount} Duplicate in file</span>` : ''}
            </div>
        `;
    }

    if (tbody) {
        tbody.innerHTML = rowsParsed.slice(0, 10).map(r => `
            <tr>
                <td>${r.rowNum}</td>
                <td><code>${escapeHtml(r.phone)}</code></td>
                <td>${escapeHtml(r.name || '—')}</td>
                <td>${escapeHtml(r.label || '—')}</td>
                <td>${r.statusLabel}</td>
            </tr>
        `).join('');
    }

    if (confirmBtn) {
        confirmBtn.disabled = validCount === 0;
    }
}

function clearComposerCsvFile() {
    const input = document.getElementById('outreachCsvFileInput');
    if (input) input.value = '';
    const fileNameEl = document.getElementById('outreachCsvFileName');
    if (fileNameEl) fileNameEl.textContent = 'No file selected';
    const previewArea = document.getElementById('outreachCsvPreviewArea');
    if (previewArea) previewArea.hidden = true;
    const confirmBtn = document.getElementById('outreachConfirmImportBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    const resultBox = document.getElementById('outreachCsvResult');
    if (resultBox) resultBox.hidden = true;
    COMPOSER_CSV_TEXT = '';
    COMPOSER_CSV_ROWS = [];
    COMPOSER_CSV_VALID_PHONES.clear();
}

async function confirmComposerCsvImport() {
    if (!COMPOSER_CSV_TEXT) {
        showToast('Please select a CSV file first', 'error');
        return;
    }

    const confirmBtn = document.getElementById('outreachConfirmImportBtn');
    const resultBox = document.getElementById('outreachCsvResult');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Importing contacts…';
    }

    try {
        const result = await api('/api/contacts/import', {
            method: 'POST',
            body: JSON.stringify({ csv: COMPOSER_CSV_TEXT })
        });

        await loadOutreachPickerContacts('', '');
        await loadOutreachPickerLabels();

        const eligibleFromCsv = OUTREACH_PICKER_CONTACTS.filter(c => 
            !c.is_opted_out && COMPOSER_CSV_VALID_PHONES.has(String(c.phone).replace(/\D/g, ''))
        );

        const toSelect = eligibleFromCsv.slice(0, 25);
        SELECTED_CONTACTS.clear();
        toSelect.forEach(c => {
            SELECTED_CONTACTS.set(c.id, { id: c.id, phone: c.phone, name: c.name, reached: !!c.last_outreach_at });
        });

        renderOutreachPickerList();
        updateOutreachModalSelectionState();
        updateSelectionBar();

        let batchNotice = '';
        if (eligibleFromCsv.length > 25) {
            batchNotice = `
                <div class="composer-alert-warning mt-xs">
                    <strong>Batch limit notice:</strong> WorkPilot limits each campaign batch to 25 recipients. The first 25 contacts have been selected. You can launch subsequent campaigns for the remaining contacts.
                </div>
            `;
            showToast(`Imported ${eligibleFromCsv.length} contacts. First 25 selected for this campaign batch.`, 'info');
        } else {
            showToast(`Imported and selected ${toSelect.length} contacts for this campaign.`, 'success');
        }

        if (resultBox) {
            resultBox.hidden = false;
            resultBox.innerHTML = `
                <div class="p-xs border-rounded bg-subtle">
                    <p class="text-success-bold">
                        ${Icon('check-circle')} Import complete: ${result.imported || 0} added, ${result.updated || 0} updated, ${result.skipped || 0} skipped (of ${result.total || 0} rows).
                    </p>
                    ${batchNotice}
                </div>
            `;
        }

        setTimeout(() => {
            switchComposerTab('existing');
        }, 1200);

        loadContacts(0);

    } catch (err) {
        showToast(err.message || 'CSV Import failed', 'error');
        if (resultBox) {
            resultBox.hidden = false;
            resultBox.innerHTML = `<p class="text-danger">${Icon('x-circle')} ${escapeHtml(err.message || 'Import failed')}</p>`;
        }
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<span data-icon="check" aria-hidden="true"></span> Import &amp; Add to Campaign';
            if (typeof hydrateIcons === 'function') hydrateIcons(confirmBtn);
        }
    }
}

function updateOutreachEstimate() {
    const estimateEl = document.getElementById('outreachEstimateText');
    if (!estimateEl) return;
    const count = SELECTED_CONTACTS.size;
    const bufferSelect = document.getElementById('outreachBufferMinutes');
    const bufferMins = bufferSelect ? parseInt(bufferSelect.value, 10) || 0 : 0;

    if (count === 0) {
        estimateEl.textContent = 'Select contacts to see sending estimate';
        return;
    }

    if (bufferMins === 0) {
        estimateEl.textContent = `${count} recipient${count > 1 ? 's' : ''} · default pacing (3–9s apart) · finishes in ~${Math.max(1, Math.round(count * 6 / 60))} min`;
    } else {
        const totalMinutes = (count - 1) * bufferMins;
        const finishDate = new Date(Date.now() + totalMinutes * 60 * 1000);
        const timeStr = finishDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins} min`;
        let text = `${count} recipient${count > 1 ? 's' : ''} · ~${bufferMins} min apart · finishes around ${timeStr} (~${durationStr})`;
        if (totalMinutes > 360) {
            text += ' ⚠️ Note: Long-running campaign';
        }
        estimateEl.textContent = text;
    }
}

function updateOutreachSendBtnState() {
    const btn = document.getElementById('outreachSendBtn');
    const msg = (document.getElementById('outreachMessage')?.value || '').trim();
    if (btn) {
        btn.disabled = SELECTED_CONTACTS.size === 0 || !msg;
    }
    updateOutreachEstimate();
}

async function openOutreachModal(opts = {}) {
    const isFromCampaigns = !!opts.fromCampaigns;
    const modalTitle = document.getElementById('outreachModalTitle');
    if (modalTitle) {
        modalTitle.textContent = isFromCampaigns ? 'Create Campaign' : 'Send Outreach';
    }

    const composeView = document.getElementById('outreachComposeView');
    const progressView = document.getElementById('outreachProgressView');
    if (composeView) {
        composeView.hidden = false;
        composeView.style.display = '';
    }
    if (progressView) {
        progressView.hidden = true;
        progressView.style.display = 'none';
    }

    const modal = document.getElementById('outreachModalBackdrop');
    if (modal) {
        modal.hidden = false;
        modal.style.display = 'flex';
        if (typeof hydrateIcons === 'function') hydrateIcons(modal);
    }

    switchComposerTab('existing');
    clearComposerCsvFile();

    populateOutreachMediaSelect();
    loadOutreachPickerLabels();

    const searchInput = document.getElementById('outreachContactSearch');
    if (searchInput) searchInput.value = '';
    const labelFilter = document.getElementById('outreachContactLabelFilter');
    if (labelFilter) labelFilter.value = '';

    await loadOutreachPickerContacts('', '');
    updateOutreachModalSelectionState();
    updateOutreachMessageStats();
    updateOutreachEstimate();

    const msgEl = document.getElementById('outreachMessage');
    if (msgEl) {
        msgEl.focus();
    }
}

function closeOutreachModal() {
    if (OUTREACH_POLL_TIMER) { clearTimeout(OUTREACH_POLL_TIMER); OUTREACH_POLL_TIMER = null; }
    OUTREACH_POLL_ERRORS = 0;
    const modal = document.getElementById('outreachModalBackdrop');
    if (modal) {
        modal.hidden = true;
        modal.style.display = 'none';
    }
    clearComposerCsvFile();
    if (currentSection === 'campaigns') {
        loadCampaigns(0);
    }
}

async function submitOutreach() {
    const message = document.getElementById('outreachMessage').value.trim();
    if (!message) { showToast('Write a message first', 'error'); return; }

    const mediaSelect = document.getElementById('outreachMediaSelect');
    const mediaAssetId = mediaSelect && mediaSelect.value ? parseInt(mediaSelect.value, 10) : null;
    const bufferSelect = document.getElementById('outreachBufferMinutes');
    const bufferMinutes = bufferSelect ? parseInt(bufferSelect.value, 10) || 0 : 0;

    const btn = document.getElementById('outreachSendBtn');
    btn.disabled = true;

    try {
        const contactIds = Array.from(SELECTED_CONTACTS.keys());
        const { jobId, total } = await api('/api/contacts/outreach', {
            method: 'POST',
            body: JSON.stringify({ contactIds, message, mediaAssetId, bufferMinutes })
        });

        const composeView = document.getElementById('outreachComposeView');
        const progressView = document.getElementById('outreachProgressView');
        const doneBtn = document.getElementById('outreachDoneBtn');
        const cancelBtn = document.getElementById('outreachProgressCancelBtn');

        if (composeView) {
            composeView.hidden = true;
            composeView.style.display = 'none';
        }
        if (progressView) {
            progressView.hidden = false;
            progressView.style.display = 'block';
        }
        if (doneBtn) {
            doneBtn.hidden = true;
            doneBtn.style.display = 'none';
        }
        if (cancelBtn) {
            cancelBtn.hidden = false;
            cancelBtn.style.display = '';
            cancelBtn.onclick = () => cancelCampaign(jobId);
        }
        document.getElementById('outreachProgressList').innerHTML = '';
        const pacingDesc = bufferMinutes > 0 ? `~${bufferMinutes} min buffer between messages` : 'default pacing';
        document.getElementById('outreachProgressSummary').textContent = `Starting campaign for ${total} contacts (${pacingDesc}). You can close this window; the campaign keeps running.`;

        if (currentSection === 'campaigns') {
            loadCampaigns(0);
        }

        OUTREACH_POLL_ERRORS = 0;
        pollOutreachJob(jobId);
    } catch (err) {
        showToast(err.message || 'Could not start outreach', 'error');
        btn.disabled = false;
    }
}

async function pollOutreachJob(jobId) {
    try {
        const job = await api(`/api/contacts/outreach/${jobId}`);
        OUTREACH_POLL_ERRORS = 0;
        const list = document.getElementById('outreachProgressList');
        if (list && Array.isArray(job.results)) {
            const statusConfig = {
                pending: { cls: 'pending', badge: '<span class="pill pill-pending">Pending</span>' },
                sending: { cls: 'sending', badge: '<span class="pill pill-running">Sending…</span>' },
                sent: { cls: 'ok', badge: '<span class="pill pill-active">✓ Sent</span>' },
                failed: { cls: 'fail', badge: `<span class="pill pill-error" title="${escapeHtml(job.error || 'Failed')}">Failed: ${escapeHtml(job.error || 'Failed')}</span>` },
                skipped: { cls: 'skipped', badge: '<span class="pill pill-neutral">Skipped</span>' },
                cancelled: { cls: 'cancelled', badge: '<span class="pill pill-neutral">Cancelled</span>' }
            };

            list.innerHTML = job.results.map(r => {
                const cfg = (r.status === 'failed')
                    ? { cls: 'fail', badge: `<span class="pill pill-error" title="${escapeHtml(r.reason || 'Failed')}">Failed: ${escapeHtml(r.reason || 'Failed')}</span>` }
                    : (statusConfig[r.status] || { cls: 'pending', badge: `<span class="pill pill-pending">${escapeHtml(r.status || 'Pending')}</span>` });
                return `
                    <div class="outreach-progress-row ${cfg.cls}">
                        <span>${escapeHtml(r.name || r.phone)}</span>
                        <span>${cfg.badge}</span>
                    </div>
                `;
            }).join('');
        }

        const countdownBadge = document.getElementById('outreachCountdownBadge');
        if (countdownBadge) {
            if (job.next_send_at && !['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted', 'done'].includes(job.status)) {
                const remainingSecs = Math.max(0, Math.round((new Date(job.next_send_at).getTime() - Date.now()) / 1000));
                if (remainingSecs > 0) {
                    const m = Math.floor(remainingSecs / 60);
                    const s = remainingSecs % 60;
                    countdownBadge.textContent = `Next message in ${m}m ${s < 10 ? '0' : ''}${s}s`;
                    countdownBadge.hidden = false;
                } else {
                    countdownBadge.textContent = 'Sending next message…';
                    countdownBadge.hidden = false;
                }
            } else {
                countdownBadge.hidden = true;
            }
        }

        const terminalStatuses = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted', 'done'];
        const isTerminal = terminalStatuses.includes(job.status);

        if (isTerminal) {
            if (OUTREACH_POLL_TIMER) {
                clearTimeout(OUTREACH_POLL_TIMER);
                OUTREACH_POLL_TIMER = null;
            }

            const statusLabels = {
                completed: 'Finished',
                completed_with_errors: 'Finished with some errors',
                failed: 'Campaign Failed',
                cancelled: 'Cancelled',
                interrupted: 'Interrupted',
                done: 'Finished'
            };
            const label = statusLabels[job.status] || 'Finished';
            const sent = job.sent || 0;
            const failed = job.failed || 0;
            const skipped = job.skipped || 0;

            let summaryText = `${label} — ${sent} sent, ${failed} failed, ${skipped} skipped.`;
            if (job.error) {
                summaryText += ` (${escapeHtml(job.error)})`;
            }
            document.getElementById('outreachProgressSummary').textContent = summaryText;

            const doneBtn = document.getElementById('outreachDoneBtn');
            if (doneBtn) {
                doneBtn.hidden = false;
                doneBtn.style.display = '';
            }
            const cancelBtn = document.getElementById('outreachProgressCancelBtn');
            if (cancelBtn) {
                cancelBtn.hidden = true;
                cancelBtn.style.display = 'none';
            }

            if (job.status === 'cancelled') {
                showToast(`Outreach cancelled — ${sent} sent`, 'info');
            } else if (job.status === 'interrupted') {
                showToast(`Outreach interrupted — ${sent} sent`, 'error');
            } else if (job.status === 'failed') {
                showToast(`Outreach failed: ${job.error || 'Check details'}`, 'error');
            } else {
                showToast(`Outreach finished — ${sent} sent`, failed > 0 ? 'warning' : 'success');
            }

            // Clear selection and refresh list if outreach completed or actually sent
            if (sent > 0 || job.status === 'completed' || job.status === 'completed_with_errors') {
                SELECTED_CONTACTS.clear();
                updateSelectionBar();
                loadContacts();
            }

            if (currentSection === 'campaigns') {
                loadCampaigns(campaignsCurrentOffset);
            }
        } else {
            const doneCount = (job.sent || 0) + (job.failed || 0) + (job.skipped || 0);
            const total = job.total || (job.results ? job.results.length : 0);
            const statusLabel = job.status === 'cancel_requested' ? 'Cancelling…' : 'Sending…';
            document.getElementById('outreachProgressSummary').textContent =
                `${statusLabel} ${doneCount}/${total} processed so far. You can close this window; the campaign keeps running.`;

            OUTREACH_POLL_TIMER = setTimeout(() => pollOutreachJob(jobId), 2000);
        }
    } catch (err) {
        OUTREACH_POLL_ERRORS++;
        if (OUTREACH_POLL_ERRORS < 3) {
            OUTREACH_POLL_TIMER = setTimeout(() => pollOutreachJob(jobId), 3000);
        } else {
            if (OUTREACH_POLL_TIMER) {
                clearTimeout(OUTREACH_POLL_TIMER);
                OUTREACH_POLL_TIMER = null;
            }
            document.getElementById('outreachDoneBtn').style.display = '';
            document.getElementById('outreachProgressSummary').textContent =
                `Lost track of this job (${err.message || 'connection error'}) — it may still be sending in the background. You can close this window.`;
            showToast('Unable to check outreach progress', 'error');
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  CAMPAIGNS (OUTREACH HISTORY & MANAGEMENT)
// ═══════════════════════════════════════════════════════════
let campaignsCurrentOffset = 0;
const CAMPAIGNS_PER_PAGE = 20;
let currentViewedCampaignId = null;

function startNewCampaignFromCampaigns() {
    openOutreachModal({ fromCampaigns: true });
}

async function loadCampaigns(offset = 0) {
    clearErrorBanner('campaignsError');
    const tbody = document.getElementById('campaignsBody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Loading campaigns…</td></tr>`;
    }

    try {
        const statusFilterEl = document.getElementById('campaignStatusFilter');
        const status = statusFilterEl ? statusFilterEl.value.trim() : '';
        const queryParams = new URLSearchParams({
            limit: String(CAMPAIGNS_PER_PAGE),
            offset: String(offset)
        });
        if (status) queryParams.set('status', status);

        const res = await apiWithMeta(`/api/contacts/outreach?${queryParams.toString()}`);
        const jobs = res.data || [];
        const meta = res.meta || { total: jobs.length, limit: CAMPAIGNS_PER_PAGE, offset };

        campaignsCurrentOffset = offset;
        renderCampaignsTable(jobs);
        renderCampaignsPagination(meta.total, offset, meta.limit);
    } catch (err) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="10" class="empty-state text-danger">Failed to load campaigns.</td></tr>`;
        }
        showErrorBanner('campaignsError', err.message || 'Failed to load campaigns', () => loadCampaigns(offset));
    }
}

function renderCampaignsTable(jobs) {
    const tbody = document.getElementById('campaignsBody');
    if (!tbody) return;

    if (!jobs || jobs.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10">
                    <div class="empty-state">
                        <span class="empty-state-icon" aria-hidden="true">${Icon('send')}</span>
                        <div class="empty-state-title">No campaigns found</div>
                        <p>Launch an outreach campaign from Contacts to see campaign history and delivery tracking here.</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = jobs.map(job => {
        const statusBadgeMap = {
            running: '<span class="pill pill-running">Running</span>',
            cancel_requested: '<span class="pill badge-cancel-requested">Cancelling…</span>',
            completed: '<span class="pill pill-active">Completed</span>',
            completed_with_errors: '<span class="pill pill-pending">Partial Failures</span>',
            failed: '<span class="pill pill-error">Failed</span>',
            cancelled: '<span class="pill pill-neutral">Cancelled</span>',
            interrupted: '<span class="pill badge-interrupted">Interrupted</span>'
        };
        const statusHtml = statusBadgeMap[job.status] || `<span class="pill pill-neutral">${escapeHtml(job.status || 'unknown')}</span>`;
        const shortId = escapeHtml(String(job.id).slice(0, 8));
        const fullId = escapeHtml(String(job.id));
        const messagePreview = escapeHtml(job.message_template || '—');
        const startedText = job.started_at ? formatDate(job.started_at) : '—';
        const pendingCount = job.pending_count ?? job.pending ?? 0;

        const isCancellable = job.cancellable || ['running', 'cancel_requested'].includes(job.status);
        const cancelBtnHtml = isCancellable
            ? `<button type="button" class="btn btn-secondary btn-xs text-danger" data-cancel-campaign="${fullId}" title="Cancel this campaign">Cancel</button>`
            : '';

        const displayedFileName = job.asset_display_name || job.asset_file_name;
        const attachmentBadgeHtml = displayedFileName
            ? `<span class="badge-attachment" title="${escapeHtml(job.asset_mime_type || '')}">📎 ${escapeHtml(displayedFileName)}</span>`
            : '';

        return `
            <tr>
                <td class="font-mono text-secondary-sm" title="${fullId}">${shortId}…</td>
                <td class="truncate-cell" title="${messagePreview}">${attachmentBadgeHtml}${messagePreview}</td>
                <td>${statusHtml}</td>
                <td class="font-bold">${job.total || 0}</td>
                <td class="${pendingCount > 0 ? 'text-warning font-bold' : 'text-secondary'}">${pendingCount}</td>
                <td class="text-success font-bold">${job.sent || 0}</td>
                <td class="${job.failed > 0 ? 'text-danger font-bold' : 'text-secondary'}">${job.failed || 0}</td>
                <td class="${job.skipped > 0 ? 'text-warning font-bold' : 'text-secondary'}">${job.skipped || 0}</td>
                <td class="text-secondary-nowrap">${startedText}</td>
                <td class="text-right">
                    <div class="flex-center-gap-8 justify-end">
                        <button type="button" class="btn btn-secondary btn-xs" data-view-campaign="${fullId}">View</button>
                        ${cancelBtnHtml}
                    </div>
                </td>
            </tr>`;
    }).join('');

    if (typeof hydrateIcons === 'function') {
        hydrateIcons(tbody);
    }
}

function renderCampaignsPagination(total, offset, limit) {
    const paginationEl = document.getElementById('campaignsPagination');
    const infoEl = document.getElementById('campaignsPaginationInfo');
    const prevBtn = document.getElementById('campaignsPrevBtn');
    const nextBtn = document.getElementById('campaignsNextBtn');

    if (!paginationEl) return;

    if (total <= limit && offset === 0) {
        paginationEl.hidden = true;
        return;
    }

    paginationEl.hidden = false;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + limit, total);
    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (infoEl) {
        infoEl.textContent = `Showing ${start}–${end} of ${total} (Page ${currentPage} of ${totalPages})`;
    }

    if (prevBtn) {
        prevBtn.disabled = offset <= 0;
    }
    if (nextBtn) {
        nextBtn.disabled = offset + limit >= total;
    }
}

function campaignsPrevPage() {
    const newOffset = Math.max(0, campaignsCurrentOffset - CAMPAIGNS_PER_PAGE);
    loadCampaigns(newOffset);
}

function campaignsNextPage() {
    const newOffset = campaignsCurrentOffset + CAMPAIGNS_PER_PAGE;
    loadCampaigns(newOffset);
}

async function viewCampaignDetails(jobId) {
    currentViewedCampaignId = jobId;
    const modal = document.getElementById('campaignDetailModalBackdrop');
    if (!modal) return;

    modal.hidden = false;
    modal.style.display = 'flex';

    const subTitle = document.getElementById('campaignDetailSubTitle');
    if (subTitle) subTitle.textContent = `Campaign ID: ${jobId}`;

    const statsContainer = document.getElementById('campaignDetailSummaryStats');
    if (statsContainer) {
        statsContainer.innerHTML = '<div class="empty-state-sm">Loading summary…</div>';
    }

    const messagePreview = document.getElementById('campaignDetailMessagePreview');
    if (messagePreview) messagePreview.textContent = 'Loading…';

    const errorBox = document.getElementById('campaignDetailErrorBox');
    const errorText = document.getElementById('campaignDetailErrorText');
    if (errorBox) errorBox.hidden = true;

    const tbody = document.getElementById('campaignDetailRecipientsBody');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading recipients…</td></tr>';
    }

    const cancelBtn = document.getElementById('campaignDetailCancelBtn');
    if (cancelBtn) {
        cancelBtn.hidden = true;
        cancelBtn.dataset.jobId = jobId;
    }

    try {
        const job = await api(`/api/contacts/outreach/${encodeURIComponent(jobId)}`);

        // Update cancel & retry buttons visibility
        const isCancellable = job.cancellable || ['running', 'cancel_requested'].includes(job.status);
        if (cancelBtn) {
            cancelBtn.hidden = !isCancellable;
            cancelBtn.dataset.jobId = job.id;
        }

        const retryBtn = document.getElementById('campaignDetailRetryBtn');
        const canRetry = (job.failed > 0) && !isCancellable;
        if (retryBtn) {
            retryBtn.hidden = !canRetry;
            retryBtn.dataset.jobId = job.id;
        }

        // Summary chips
        const statusBadgeMap = {
            running: '<span class="pill pill-running">Running</span>',
            cancel_requested: '<span class="pill badge-cancel-requested">Cancelling…</span>',
            completed: '<span class="pill pill-active">Completed</span>',
            completed_with_errors: '<span class="pill pill-pending">Partial Failures</span>',
            failed: '<span class="pill pill-error">Failed</span>',
            cancelled: '<span class="pill pill-neutral">Cancelled</span>',
            interrupted: '<span class="pill badge-interrupted">Interrupted</span>'
        };
        const statusHtml = statusBadgeMap[job.status] || `<span class="pill pill-neutral">${escapeHtml(job.status || 'unknown')}</span>`;
        const bufferText = job.buffer_minutes > 0 ? `${job.buffer_minutes} min` : 'Default pacing';

        if (statsContainer) {
            statsContainer.innerHTML = `
                <div class="stat-chip">
                    <span class="stat-chip-label">Status</span>
                    <span class="stat-chip-val stat-chip-val-status">${statusHtml}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Total</span>
                    <span class="stat-chip-val">${job.total || (job.results ? job.results.length : 0)}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Pending</span>
                    <span class="stat-chip-val ${job.pending > 0 ? 'text-warning font-bold' : ''}">${job.pending || 0}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Sent</span>
                    <span class="stat-chip-val text-success font-bold">${job.sent || 0}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Failed</span>
                    <span class="stat-chip-val ${job.failed > 0 ? 'text-danger font-bold' : ''}">${job.failed || 0}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Skipped</span>
                    <span class="stat-chip-val ${job.skipped > 0 ? 'text-warning font-bold' : ''}">${job.skipped || 0}</span>
                </div>
                <div class="stat-chip">
                    <span class="stat-chip-label">Spacing</span>
                    <span class="stat-chip-val font-mono">${bufferText}</span>
                </div>
            `;
        }

        if (messagePreview) {
            messagePreview.textContent = job.message_template || '—';
        }

        const attachmentBox = document.getElementById('campaignDetailAttachmentBox');
        const attachmentName = document.getElementById('campaignDetailAttachmentName');
        const attachmentMeta = document.getElementById('campaignDetailAttachmentMeta');
        const attachmentLink = document.getElementById('campaignDetailAttachmentLink');

        const activeAssetName = job.asset_display_name || job.asset_file_name;
        if (activeAssetName && attachmentBox) {
            attachmentBox.hidden = false;
            if (attachmentName) attachmentName.textContent = activeAssetName;
            if (attachmentMeta) {
                const projStr = job.project_name ? `Project: ${job.project_name}` : '';
                const typeStr = job.asset_type ? `Type: ${job.asset_type}` : '';
                const mimeStr = job.asset_mime_type || '';
                attachmentMeta.textContent = [projStr, typeStr, mimeStr].filter(Boolean).join(' • ');
            }
            if (attachmentLink && job.media_asset_id) {
                attachmentLink.href = `/api/inventory/assets/${job.media_asset_id}/file`;
                attachmentLink.hidden = false;
            } else if (attachmentLink) {
                attachmentLink.hidden = true;
            }
        } else if (attachmentBox) {
            attachmentBox.hidden = true;
        }

        if (job.error && errorBox && errorText) {
            errorText.textContent = job.error;
            errorBox.hidden = false;
        }

        // Recipients list
        if (tbody) {
            const results = job.results || [];
            if (results.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No recipients found for this campaign.</td></tr>';
            } else {
                tbody.innerHTML = results.map(r => {
                    let statusPill = '<span class="pill pill-pending">Pending</span>';
                    if (r.status === 'sending') {
                        statusPill = '<span class="pill pill-running">Sending…</span>';
                    } else if (r.status === 'sent') {
                        statusPill = '<span class="pill pill-active">✓ Sent</span>';
                    } else if (r.status === 'failed') {
                        statusPill = '<span class="pill pill-error">Failed</span>';
                    } else if (r.status === 'skipped') {
                        statusPill = '<span class="pill pill-neutral">Skipped</span>';
                    } else if (r.status === 'cancelled') {
                        statusPill = '<span class="pill pill-neutral">Cancelled</span>';
                    }

                    const contactName = r.name ? escapeHtml(r.name) : '<span class="text-secondary">—</span>';
                    const phone = r.phone ? escapeHtml(r.phone) : '—';
                    const reason = r.reason ? escapeHtml(r.reason) : '<span class="text-secondary">—</span>';
                    let sentAt = '<span class="text-secondary">—</span>';
                    if (r.sent_at) {
                        sentAt = formatDate(r.sent_at);
                    } else if (r.status === 'pending' && r.next_send_at) {
                        sentAt = `<span class="text-secondary-sm">Est. ${formatDate(r.next_send_at)}</span>`;
                    }

                    return `
                        <tr>
                            <td>${contactName}</td>
                            <td class="font-mono text-secondary-sm">${phone}</td>
                            <td>${statusPill}</td>
                            <td class="text-secondary-sm">${reason}</td>
                            <td class="text-secondary-nowrap">${sentAt}</td>
                        </tr>`;
                }).join('');
            }
        }
    } catch (err) {
        showToast(err.message || 'Failed to load campaign details', 'error');
        closeCampaignDetailModal();
    }
}

function closeCampaignDetailModal() {
    currentViewedCampaignId = null;
    const modal = document.getElementById('campaignDetailModalBackdrop');
    if (modal) {
        modal.hidden = true;
        modal.style.display = 'none';
    }
}

async function cancelCampaign(jobId) {
    if (!jobId) return;
    if (!confirm('Are you sure you want to cancel this campaign? Any pending messages will be halted.')) {
        return;
    }

    try {
        await api(`/api/contacts/outreach/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
        showToast('Campaign cancellation requested', 'info');

        // If detail modal is open for this campaign, refresh its details
        if (currentViewedCampaignId === jobId) {
            await viewCampaignDetails(jobId);
        }

        // Refresh campaign list
        if (currentSection === 'campaigns') {
            await loadCampaigns(campaignsCurrentOffset);
        }
    } catch (err) {
        showToast(err.message || 'Failed to cancel campaign', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  SCHEDULED MESSAGES
// ═══════════════════════════════════════════════════════════
async function loadScheduled() {
    clearErrorBanner('scheduledError');
    try {
        const messages = await api('/api/scheduled');
        const tbody    = document.getElementById('scheduledBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">⏰</span>
                            <div class="empty-state-title">No scheduled messages</div>
                            <p>Schedule your first message above!</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td class="text-secondary">${escapeHtml(msg.phone)}</td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td class="text-secondary-nowrap">${formatDate(msg.scheduled_at)}</td>
                <td>
                    <span class="pill pill-${msg.status === 'pending' ? 'pending' : msg.status === 'sent' ? 'active' : 'error'}">
                        ${escapeHtml(msg.status)}
                    </span>
                </td>
                <td>
                    ${msg.status === 'pending'
                        ? `<button class="btn btn-sm btn-danger" data-action="cancel-scheduled" data-id="${msg.id}" aria-label="Cancel scheduled message" type="button">Cancel</button>`
                        : '—'}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('scheduledError', 'Failed to load scheduled messages.', loadScheduled);
    }
}

async function cancelScheduled(id) {
    if (!confirm('Cancel this scheduled message?')) return;
    try {
        await api(`/api/scheduled/${id}`, { method: 'DELETE' });
        showToast('Scheduled message cancelled', 'success');
        loadScheduled();
    } catch (err) {
        showToast('Failed to cancel', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  APPOINTMENTS
// ═══════════════════════════════════════════════════════════
function renderCompactReminders(reminders) {
    if (!reminders || !reminders.length) {
        return '<span class="text-secondary-sm">None</span>';
    }
    const r24 = reminders.find(r => (r.reminder_type === '24h' || r.type === '24h'));
    const r2 = reminders.find(r => (r.reminder_type === '2h' || r.type === '2h'));

    const formatChip = (r, label) => {
        if (!r) return `${label} —`;
        // Strictly tick ONLY after a confirmed send with a message ID
        if (r.status === 'sent' && r.wa_message_id) {
            return `<span class="text-success font-bold" title="${label} sent (confirmed dispatched with message ID: ${escapeHtml(r.wa_message_id)}; sent, not read receipt)">✓ ${label}</span>`;
        }
        if (r.status === 'sent') {
            return `<span class="text-warning font-bold" title="${label} dispatched (awaiting server message ID)">… ${label}</span>`;
        }
        if (r.status === 'pending' || r.status === 'scheduled') return `<span class="text-primary font-bold" title="${label} scheduled">⏱ ${label}</span>`;
        if (r.status === 'sending') return `<span class="text-warning font-bold" title="${label} sending">… ${label}</span>`;
        if (r.status === 'failed') return `<span class="text-danger font-bold" title="${label} failed: ${escapeHtml(r.error_message || '')}">⚠ ${label}</span>`;
        if (r.status === 'skipped_past') return `<span class="text-secondary" title="${label} skipped: time already passed">⊘ ${label} (past)</span>`;
        if (r.status === 'skipped_unreachable') return `<span class="text-secondary" title="${label} skipped: unreachable identifier (${escapeHtml(r.error_message || '')})">⊘ ${label} (unreachable)</span>`;
        if (r.status === 'skipped') return `<span class="text-secondary" title="${label} skipped: ${escapeHtml(r.error_message || 'Notice period')}">⊘ ${label}</span>`;
        if (r.status === 'cancelled') return `<span class="text-secondary" title="${label} cancelled: ${escapeHtml(r.error_message || 'Cancelled')}">✕ ${label}</span>`;
        return `<span class="text-secondary">${label} —</span>`;
    };

    return `<span class="reminder-compact-indicator font-mono">${formatChip(r24, '24h')} · ${formatChip(r2, '2h')}</span>`;
}

async function loadAppointments() {
    clearErrorBanner('appointmentsError');
    try {
        const { appointments } = await api('/api/appointments');
        const tbody = document.getElementById('appointmentsBody');

        if (appointments.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('calendar-clock')}</span>
                            <div class="empty-state-title">No appointments yet</div>
                            <p>Bookings made by your chatbot or added manually below will show up here.</p>
                        </div>
                    </td>
                </tr>`;
        } else {
            tbody.innerHTML = appointments.map(a => `
                <tr>
                    <td>
                        <strong class="cursor-pointer text-primary" data-open-appointment="${a.id}">${escapeHtml(a.contact_name || a.phone)}</strong>
                        ${a.contact_name ? `<br><small class="text-secondary">${escapeHtml(a.phone)}</small>` : ''}
                    </td>
                    <td class="text-secondary-nowrap">${formatDate(a.start_at)}</td>
                    <td>${a.source === 'chatbot' ? Icon('bot', 'icon-inline') + ' Chatbot' : Icon('user', 'icon-inline') + ' Manual'}</td>
                    <td>
                        <span class="pill pill-${a.status === 'confirmed' ? 'active' : 'error'}">${escapeHtml(a.status)}</span>
                    </td>
                    <td>
                        ${renderCompactReminders(a.reminders)}
                    </td>
                    <td>
                        <div class="flex-center-gap-8">
                            <button class="btn btn-sm btn-secondary" data-action="view-appointment" data-id="${a.id}" type="button">View</button>
                            ${a.status === 'confirmed'
                                ? `<button class="btn btn-sm btn-danger" data-action="cancel-appointment" data-id="${a.id}" aria-label="Cancel appointment" type="button">Cancel</button>`
                                : ''}
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        document.getElementById('apptBookingDisabledNotice').style.display = 'none';
    } catch (err) {
        showErrorBanner('appointmentsError', 'Failed to load appointments.', loadAppointments);
    }

    loadApptSlotOptions();
}

async function openAppointmentDetailModal(appointmentId) {
    const modal = document.getElementById('appointmentDetailModalBackdrop');
    if (!modal) return;
    modal.hidden = false;
    modal.style.display = 'flex';

    const titleEl = document.getElementById('appointmentDetailModalTitle');
    const subTitleEl = document.getElementById('appointmentDetailSubTitle');
    const bodyEl = document.getElementById('appointmentDetailModalBody');

    if (bodyEl) bodyEl.innerHTML = '<div class="empty-state">Loading appointment details…</div>';

    try {
        const appt = await api(`/api/appointments/${appointmentId}`);
        if (titleEl) titleEl.textContent = `Appointment with ${appt.contact_name || appt.phone}`;
        if (subTitleEl) subTitleEl.textContent = `ID: ${appt.id} • ${formatDate(appt.start_at)}`;

        const reminders = appt.reminders || [];
        const r24 = reminders.find(r => (r.reminder_type === '24h' || r.type === '24h'));
        const r2 = reminders.find(r => (r.reminder_type === '2h' || r.type === '2h'));

        const renderReminderCard = (label, r) => {
            if (!r) {
                return `
                    <div class="reminder-card">
                        <div class="reminder-card-header">
                            <span class="reminder-card-title">${label}</span>
                            <span class="reminder-chip reminder-chip-skipped">Not Scheduled</span>
                        </div>
                        <div class="reminder-card-time text-secondary-sm">No reminder record found for this time</div>
                    </div>`;
            }

            const statusClassMap = {
                pending: 'reminder-chip-scheduled',
                scheduled: 'reminder-chip-scheduled',
                sending: 'reminder-chip-sending',
                sent: 'reminder-chip-sent',
                failed: 'reminder-chip-failed',
                skipped: 'reminder-chip-skipped',
                skipped_past: 'reminder-chip-skipped',
                skipped_unreachable: 'reminder-chip-skipped',
                cancelled: 'reminder-chip-cancelled'
            };
            const cls = statusClassMap[r.status] || 'reminder-chip-skipped';
            let statusBadge = `<span class="reminder-chip ${cls}">${r.status.toUpperCase()}</span>`;

            if (r.status === 'sent' && r.wa_message_id) {
                statusBadge = `<span class="reminder-chip reminder-chip-sent">${Icon('check-circle', 'icon-inline')}✓ Sent · ${formatDate(r.sent_at)}</span>`;
            } else if (r.status === 'sent') {
                statusBadge = `<span class="reminder-chip reminder-chip-sending">${Icon('loader', 'icon-inline')}Dispatched (Awaiting ID)</span>`;
            } else if (r.status === 'pending' || r.status === 'scheduled') {
                const targetTime = new Date(r.scheduled_at + (r.scheduled_at.includes('Z') || r.scheduled_at.includes('+') ? '' : 'Z')).getTime();
                const dueInMins = Math.round((targetTime - Date.now()) / 60000);
                const hrs = Math.floor(dueInMins / 60);
                const mins = dueInMins % 60;
                const dueStr = dueInMins > 0 ? ` (in ${hrs > 0 ? hrs + 'h ' : ''}${mins}m)` : '';
                statusBadge = `<span class="reminder-chip reminder-chip-scheduled">${Icon('clock', 'icon-inline')}Scheduled${dueStr}</span>`;
            } else if (r.status === 'sending') {
                statusBadge = `<span class="reminder-chip reminder-chip-sending">${Icon('loader', 'icon-inline')}Sending…</span>`;
            } else if (r.status === 'failed') {
                statusBadge = `<span class="reminder-chip reminder-chip-failed">${Icon('alert-triangle', 'icon-inline')}Failed</span>`;
            } else if (r.status === 'skipped_past') {
                statusBadge = `<span class="reminder-chip reminder-chip-skipped">${Icon('slash', 'icon-inline')}Skipped: time already passed</span>`;
            } else if (r.status === 'skipped_unreachable') {
                statusBadge = `<span class="reminder-chip reminder-chip-skipped">${Icon('slash', 'icon-inline')}Skipped: unreachable</span>`;
            } else if (r.status === 'skipped') {
                statusBadge = `<span class="reminder-chip reminder-chip-skipped">${Icon('slash', 'icon-inline')}Skipped</span>`;
            } else if (r.status === 'cancelled') {
                statusBadge = `<span class="reminder-chip reminder-chip-cancelled">${Icon('x', 'icon-inline')}Cancelled</span>`;
            }

            return `
                <div class="reminder-card">
                    <div class="reminder-card-header">
                        <span class="reminder-card-title">${label}</span>
                        ${statusBadge}
                    </div>
                    <div class="reminder-card-time">
                        ${r.status === 'skipped_past' ? 'Trigger time was: ' : 'Scheduled for: '}<strong>${formatDate(r.scheduled_at)}</strong> (IST)
                    </div>
                    ${r.wa_message_id ? `<div class="text-secondary-sm font-mono mt-4">WA Message ID: ${escapeHtml(r.wa_message_id)}</div>` : ''}
                    ${r.error_message ? `<div class="reminder-card-reason">${escapeHtml(r.error_message)}</div>` : ''}
                </div>`;
        };

        if (bodyEl) {
            bodyEl.innerHTML = `
                <div class="deal-detail-grid">
                    <div class="form-group">
                        <label>Contact Name</label>
                        <div class="font-bold">${escapeHtml(appt.contact_name || '—')}</div>
                    </div>
                    <div class="form-group">
                        <label>Phone / Identifier</label>
                        <div class="font-mono">${escapeHtml(appt.phone)}</div>
                    </div>
                    <div class="form-group">
                        <label>Date & Time</label>
                        <div>${formatDate(appt.start_at)} (IST)</div>
                    </div>
                    <div class="form-group">
                        <label>Booking Status</label>
                        <div><span class="pill pill-${appt.status === 'confirmed' ? 'active' : 'error'}">${escapeHtml(appt.status)}</span></div>
                    </div>
                </div>

                ${appt.notes ? `
                    <div class="form-group mt-12">
                        <label>Notes</label>
                        <p class="text-secondary-sm">${escapeHtml(appt.notes)}</p>
                    </div>` : ''}

                <div class="modal-section mt-16">
                    <h3>${Icon('bell', 'icon-inline')}Appointment Reminders (24h & 2h)</h3>
                    <p class="text-secondary-sm">Automated WhatsApp reminders scheduled to ensure client attendance. <strong>✓ Sent</strong> indicates confirmed dispatch to WhatsApp with a valid message ID by the server (sent, not read receipt).</p>
                    <div class="reminder-cards-grid">
                        ${renderReminderCard('24 Hours Before Reminder', r24)}
                        ${renderReminderCard('2 Hours Before Reminder', r2)}
                    </div>
                </div>
            `;
        }

        // Live refresh of the tick while modal is actively open
        if (window._appointmentDetailPollTimer) clearInterval(window._appointmentDetailPollTimer);
        window._appointmentDetailPollTimer = setInterval(async () => {
            const modalEl = document.getElementById('appointmentDetailModalBackdrop');
            if (!modalEl || modalEl.hidden || modalEl.style.display === 'none') {
                clearInterval(window._appointmentDetailPollTimer);
                window._appointmentDetailPollTimer = null;
                return;
            }
            try {
                const freshAppt = await api(`/api/appointments/${appointmentId}`);
                const freshReminders = freshAppt.reminders || [];
                const fr24 = freshReminders.find(r => (r.reminder_type === '24h' || r.type === '24h'));
                const fr2 = freshReminders.find(r => (r.reminder_type === '2h' || r.type === '2h'));
                const grid = document.querySelector('#appointmentDetailModalBody .reminder-cards-grid');
                if (grid) {
                    grid.innerHTML = `
                        ${renderReminderCard('24 Hours Before Reminder', fr24)}
                        ${renderReminderCard('2 Hours Before Reminder', fr2)}
                    `;
                }
            } catch (_) {}
        }, 3500);
    } catch (err) {
        if (bodyEl) {
            bodyEl.innerHTML = `<div class="empty-state text-danger">Failed to load appointment details: ${escapeHtml(err.message)}</div>`;
        }
    }
}

function closeAppointmentDetailModal() {
    if (window._appointmentDetailPollTimer) {
        clearInterval(window._appointmentDetailPollTimer);
        window._appointmentDetailPollTimer = null;
    }
    const modal = document.getElementById('appointmentDetailModalBackdrop');
    if (modal) {
        modal.hidden = true;
        modal.style.display = 'none';
    }
}

async function cancelAppointment(id, btn) {
    if (!confirm('Cancel this appointment?')) return;
    if (btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Cancelling…';
    }
    try {
        const res = await api(`/api/appointments/${id}`, { method: 'DELETE' });
        if (res && res.alreadyCancelled) {
            showToast('Appointment is already cancelled', 'info');
        } else {
            showToast('Appointment cancelled', 'success');
        }
        await loadAppointments();
        const subTitleEl = document.getElementById('appointmentDetailSubTitle');
        if (subTitleEl && subTitleEl.textContent.includes(`ID: ${id}`)) {
            await openAppointmentDetailModal(id);
        }
    } catch (err) {
        showToast(err.message || 'Failed to cancel appointment', 'error');
        await loadAppointments();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalText || 'Cancel';
        }
    }
}

async function loadApptSlotOptions() {
    const select = document.getElementById('apptSlotSelect');
    if (!select) return;
    select.innerHTML = '<option value="">Loading available slots…</option>';
    try {
        const { slots, settings } = await api('/api/appointments/slots?daysAhead=14&maxResults=30');
        if (!settings.bookingEnabled) {
            const notice = document.getElementById('apptBookingDisabledNotice');
            if (notice) notice.style.display = '';
        }
        if (slots.length === 0) {
            select.innerHTML = '<option value="">No open slots in the next 14 days</option>';
            return;
        }
        select.innerHTML = slots.map(s => `<option value="${escapeHtml(s.startIso)}">${escapeHtml(s.label)}</option>`).join('');
    } catch (err) {
        select.innerHTML = '<option value="">Could not load slots</option>';
    }
}

// ═══════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════
async function loadSettings() {
    try {
        const settings = await api('/api/settings');

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = val === 'true';
            else el.value = val || '';
        };

        set('settBusinessName',   settings.business_name);
        set('settChatbotEnabled', settings.chatbot_enabled);
        set('settDefaultReply',   settings.default_reply);
        set('settAwayMode',       settings.away_mode);
        set('settAwayMessage',    settings.away_message);
        set('settWelcomeMessage', settings.welcome_message);
        set('settAiEnabled',      settings.ai_enabled);
        set('settOwnerName',      settings.owner_name);
        set('settAiMode',         settings.ai_mode || 'ai_first');
        set('settAiSystemPrompt', settings.ai_system_prompt);
        const keyInput = document.getElementById('settGeminiApiKey');
        const statusBadge = document.getElementById('settGeminiApiKeyStatus');
        const removeBtn = document.getElementById('removeGeminiApiKeyBtn');
        const helpText = document.getElementById('settGeminiApiKeyHelp');

        if (keyInput) {
            keyInput.value = '';
            if (settings.gemini_api_key_set) {
                keyInput.placeholder = '•••••••••••••••• (Key saved — leave blank to keep)';
                if (statusBadge) {
                    statusBadge.style.display = 'inline-block';
                    statusBadge.style.backgroundColor = 'rgba(34, 197, 94, 0.15)';
                    statusBadge.style.color = '#22c55e';
                    statusBadge.textContent = 'Active ✓';
                }
                if (removeBtn) removeBtn.style.display = 'inline-block';
                if (helpText) helpText.innerHTML = 'Key is securely configured. Leave blank to keep current key, or enter a new key to update. Get a key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.';
            } else {
                keyInput.placeholder = 'Enter your Gemini API Key';
                if (statusBadge) {
                    statusBadge.style.display = 'inline-block';
                    statusBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                    statusBadge.style.color = '#ef4444';
                    statusBadge.textContent = 'Not Set';
                }
                if (removeBtn) removeBtn.style.display = 'none';
                if (helpText) helpText.innerHTML = 'Get a free key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.';
            }
        }

        const savedModel = settings.gemini_model || 'auto';
        const modelSelect = document.getElementById('settGeminiModel');
        const customWrapper = document.getElementById('customModelWrapper');
        const customInput = document.getElementById('settGeminiCustomModel');

        if (modelSelect) {
            const knownOptions = Array.from(modelSelect.options).map(o => o.value);
            if (knownOptions.includes(savedModel)) {
                modelSelect.value = savedModel;
                if (customWrapper) customWrapper.style.display = 'none';
            } else {
                modelSelect.value = 'custom';
                if (customWrapper) {
                    customWrapper.style.display = 'block';
                    if (customInput) customInput.value = savedModel;
                }
            }
        }

        // Lead Routing & SLA settings
        set('settLeadAssignmentEnabled', settings.lead_assignment_enabled);
        set('settLeadAssignmentStrategy', settings.lead_assignment_strategy || 'round_robin');
        set('settLeadSlaMinutes', settings.lead_sla_minutes || '15');
        set('settLeadSlaWarningMinutes', settings.lead_sla_warning_minutes || '10');
        set('settLeadEscalationEnabled', settings.lead_escalation_enabled);

        const mgrSelect = document.getElementById('settLeadEscalationManager');
        if (mgrSelect) {
            api('/api/crm/agents').then(agents => {
                const mgrs = (agents || []).filter(a => ['manager', 'admin'].includes(a.role));
                mgrSelect.innerHTML = '<option value="">Auto (First active manager/admin)</option>' +
                    mgrs.map(m => `<option value="${m.id}" ${settings.lead_escalation_manager_agent_id === String(m.id) ? 'selected' : ''}>${escapeHtml(m.name)} (${escapeHtml(m.role)})</option>`).join('');
            }).catch(() => {});
        }

        // Business Setup tab data
        loadBusiness();
    } catch (err) {
        showToast('Failed to load settings', 'error');
    }

    loadCalendarStatus();
    loadBookingSettings();
    initRoutingSettings();
}

function initRoutingSettings() {
    const form = document.getElementById('routingSettingsForm');
    if (!form || form.dataset.initialized) return;
    form.dataset.initialized = 'true';
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    lead_assignment_enabled: String(document.getElementById('settLeadAssignmentEnabled').checked),
                    lead_assignment_strategy: document.getElementById('settLeadAssignmentStrategy').value,
                    lead_sla_minutes: document.getElementById('settLeadSlaMinutes').value,
                    lead_sla_warning_minutes: document.getElementById('settLeadSlaWarningMinutes').value,
                    lead_escalation_enabled: String(document.getElementById('settLeadEscalationEnabled').checked),
                    lead_escalation_manager_agent_id: document.getElementById('settLeadEscalationManager').value || ''
                })
            });
            showToast('Routing & SLA settings saved', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to save routing settings', 'error');
        }
    });
}

// ─── Appointment Booking ─────────────────────────────────────
async function loadBookingSettings() {
    try {
        const s = await api('/api/appointments/settings');
        document.getElementById('bookingEnabled').checked = !!s.bookingEnabled;
        document.querySelectorAll('.bookingDay').forEach(cb => {
            cb.checked = s.workingDays.includes(Number(cb.value));
        });
        document.getElementById('bookingStartTime').value = s.startTime;
        document.getElementById('bookingEndTime').value = s.endTime;
        document.getElementById('bookingSlotDuration').value = String(s.slotDurationMinutes);
        document.getElementById('bookingBufferMinutes').value = String(s.bufferMinutes);

        const tzSelect = document.getElementById('bookingTimezone');
        // The dropdown only lists common zones — if the saved value isn't
        // one of them (set via an older version, or a zone we don't list),
        // add it so the picker doesn't silently fall back to whatever the
        // first <option> happens to be and then overwrite a real setting
        // the next time the form is saved.
        if (tzSelect && ![...tzSelect.options].some(o => o.value === s.timezone)) {
            const opt = document.createElement('option');
            opt.value = s.timezone;
            opt.textContent = s.timezone;
            tzSelect.appendChild(opt);
        }
        if (tzSelect) tzSelect.value = s.timezone;
    } catch (err) {
        showToast('Failed to load booking settings', 'error');
    }
}

function initBookingSettings() {
    const form = document.getElementById('bookingSettingsForm');
    if (!form) return; // booking tab not on this page

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const workingDays = Array.from(document.querySelectorAll('.bookingDay:checked')).map(cb => Number(cb.value));
        if (workingDays.length === 0) {
            showToast('Pick at least one working day', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        try {
            await api('/api/appointments/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    workingDays,
                    startTime: document.getElementById('bookingStartTime').value,
                    endTime: document.getElementById('bookingEndTime').value,
                    slotDurationMinutes: Number(document.getElementById('bookingSlotDuration').value),
                    bufferMinutes: Number(document.getElementById('bookingBufferMinutes').value),
                    timezone: document.getElementById('bookingTimezone').value,
                    bookingEnabled: document.getElementById('bookingEnabled').checked
                })
            });
            showToast('Booking settings saved!', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to save booking settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Booking Settings';
        }
    });

    // The enable toggle lives outside the form (it reads like a feature
    // switch, not a form field) but should save immediately like the
    // calendar's own availability toggle does.
    document.getElementById('bookingEnabled')?.addEventListener('change', async (e) => {
        try {
            const s = await api('/api/appointments/settings');
            await api('/api/appointments/settings', {
                method: 'PUT',
                body: JSON.stringify({ ...s, bookingEnabled: e.target.checked })
            });
            showToast(e.target.checked ? 'Chatbot booking enabled' : 'Chatbot booking disabled', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to update', 'error');
            e.target.checked = !e.target.checked;
        }
    });
}

// ─── Google Calendar ────────────────────────────────────────
async function loadCalendarStatus() {
    const statusEl = document.getElementById('calendarStatus');
    const notConfiguredEl = document.getElementById('calendarNotConfigured');
    const connectBtn = document.getElementById('calendarConnectBtn');
    const syncBtn = document.getElementById('calendarSyncBtn');
    const disconnectBtn = document.getElementById('calendarDisconnectBtn');
    const availabilityRow = document.getElementById('calendarAvailabilityRow');
    if (!statusEl) return; // calendar tab not on this page

    try {
        const data = await api('/api/calendar/status');
        if (!data.configured) {
            notConfiguredEl.style.display = '';
            statusEl.innerHTML = '';
            connectBtn.style.display = 'none';
            syncBtn.style.display = 'none';
            disconnectBtn.style.display = 'none';
            availabilityRow.style.display = 'none';
            return;
        }
        notConfiguredEl.style.display = 'none';

        if (data.connected) {
            statusEl.innerHTML = `<p class="connected-text">${Icon('check-circle', 'icon-inline')}Connected${data.lastSyncAt ? ` — last synced ${new Date(data.lastSyncAt).toLocaleString()}` : ''}</p>`;
            connectBtn.style.display = 'none';
            syncBtn.style.display = '';
            disconnectBtn.style.display = '';
            availabilityRow.style.display = '';
            const cb = document.getElementById('settCalendarCheckAvailability');
            if (cb) cb.checked = !!data.checkAvailability;
        } else {
            statusEl.innerHTML = `<p class="text-secondary">${Icon('x-circle', 'icon-inline')}Not connected</p>`;
            connectBtn.style.display = '';
            syncBtn.style.display = 'none';
            disconnectBtn.style.display = 'none';
            availabilityRow.style.display = 'none';
        }
    } catch (err) {
        statusEl.innerHTML = '<p class="text-error">Could not load calendar status</p>';
    }
}

function initCalendarSettings() {
    const connectBtn = document.getElementById('calendarConnectBtn');
    const syncBtn = document.getElementById('calendarSyncBtn');
    const disconnectBtn = document.getElementById('calendarDisconnectBtn');
    const availabilityToggle = document.getElementById('settCalendarCheckAvailability');
    if (!connectBtn) return; // calendar tab not on this page

    connectBtn.addEventListener('click', async () => {
        try {
            const data = await api('/api/calendar/connect');
            // A popup keeps the dashboard tab alive so status can refresh via
            // postMessage the moment the OAuth flow finishes.
            window.open(data.url, 'google-calendar-connect', 'width=520,height=680');
        } catch (err) {
            showToast(err.message || 'Could not start Google Calendar connection', 'error');
        }
    });

    syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        try {
            const data = await api('/api/calendar/sync', { method: 'POST' });
            showToast(data.imported > 0 ? `Imported ${data.imported} event(s)` : 'No new calendar events to import', 'success');
            loadCalendarStatus();
        } catch (err) {
            showToast(err.message || 'Sync failed', 'error');
        } finally {
            syncBtn.disabled = false;
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        if (!confirm('Disconnect Google Calendar? Outreach will stop being logged and calendar events will no longer be imported.')) return;
        try {
            await api('/api/calendar/disconnect', { method: 'POST' });
            showToast('Google Calendar disconnected', 'success');
            loadCalendarStatus();
        } catch (err) {
            showToast(err.message || 'Could not disconnect', 'error');
        }
    });

    if (availabilityToggle) {
        availabilityToggle.addEventListener('change', async () => {
            try {
                await api('/api/calendar/settings', {
                    method: 'PUT',
                    body: JSON.stringify({ checkAvailability: availabilityToggle.checked })
                });
                showToast('Saved', 'success');
            } catch (err) {
                showToast(err.message || 'Could not save', 'error');
                availabilityToggle.checked = !availabilityToggle.checked;
            }
        });
    }

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data && event.data.type === 'google-calendar-connected') {
            if (event.data.ok) showToast('Google Calendar connected', 'success');
            else showToast(event.data.message || 'Could not connect Google Calendar', 'error');
            loadCalendarStatus();
        }
    });
}

// ─── QR / SSE ────────────────────────────────────────────────
// Primary: real-time updates via Server-Sent Events.
// Fallback: if no actionable SSE event arrives within 10s (cloud load
// balancers / proxies sometimes buffer or drop EventSource connections),
// a REST poll to /api/status every 5s ensures the QR code still reaches
// the browser.
let _sseReceivedActionable = false;
let _statusPollTimer = null;
let _qrEventSource = null;

function initSSE() {
    if (!CURRENT_USER) return;
    if (_qrEventSource && _qrEventSource.readyState !== EventSource.CLOSED) return;
    if (_qrEventSource) {
        try { _qrEventSource.close(); } catch (_) {}
        _qrEventSource = null;
    }
    _sseReceivedActionable = false;
    const eventSource = _qrEventSource = new EventSource('/api/qr-stream');

    eventSource.onmessage = function (event) {
        try {
            const data        = JSON.parse(event.data);
            // Any event other than the initial 'loading' means SSE is working
            if (data.type !== 'loading') _sseReceivedActionable = true;
            applyConnectionState(data);
        } catch (e) {
            console.error('SSE parse error:', e);
        }
    };

    eventSource.onerror = function () {
        console.warn('SSE connection lost — browser will auto-reconnect.');
    };

    // ── REST fallback: kick in if SSE hasn't delivered after 10s ──
    setTimeout(() => {
        if (!_sseReceivedActionable) {
            console.warn('SSE has not delivered a QR/ready event — starting REST polling fallback.');
            startStatusPolling();
        }
    }, 10000);
}

function stopSSE() {
    if (_qrEventSource) {
        try { _qrEventSource.close(); } catch (_) {}
    }
    _qrEventSource = null;
    stopStatusPolling();
}

let _loadingTimeout = null;

function startStatusPolling() {
    if (_statusPollTimer) return; // already polling
    _statusPollTimer = setInterval(async () => {
        try {
            const res = await api('/api/status');
            const s = res.data || res;
            if (s.connected) {
                applyConnectionState({ type: 'ready', phone: s.phone });
                stopStatusPolling();
            } else if (s.qr) {
                applyConnectionState({ type: 'qr', data: s.qr });
            } else if (s.error) {
                applyConnectionState({ type: 'error', data: s.error });
            } else if (s.state === 'reconnecting') {
                applyConnectionState({ type: 'reconnecting', error: s.error });
            } else if (s.state === 'logged_out') {
                applyConnectionState({ type: 'logged_out', error: s.error });
            } else if (s.state === 'disconnected' || s.disconnected || !s.started) {
                applyConnectionState({ type: 'disconnected' });
            } else if (s.initializing || s.state === 'connecting') {
                applyConnectionState({ type: 'loading' });
            }
        } catch (e) {
            // API unreachable — keep polling silently
        }
    }, 4000);
}

function stopStatusPolling() {
    if (_statusPollTimer) { clearInterval(_statusPollTimer); _statusPollTimer = null; }
}

function applyConnectionState(data) {
    const qrLoading   = document.getElementById('qrLoading');
    const qrImage     = document.getElementById('qrImage');
    const qrSuccess   = document.getElementById('qrSuccess');
    const qrContainer = document.getElementById('qrContainer');
    const statusDot   = document.querySelector('#connectionStatus .status-dot');
    const statusText  = document.querySelector('#connectionStatus .status-text');
    const connInfo    = document.getElementById('connectionInfo');

    const show = (el) => { if (el) { el.hidden = false; el.removeAttribute('style'); } };
    const hide = (el) => { if (el) { el.hidden = true; el.removeAttribute('style'); } };

    // Clear any pending loading watchdog if we've transitioned out of loading/connecting
    if (data.type !== 'loading' && data.type !== 'connecting' && _loadingTimeout) {
        clearTimeout(_loadingTimeout);
        _loadingTimeout = null;
    }

    // Remove any previous reconnect button if present
    const oldReconnect = document.getElementById('qrReconnectBtnContainer');
    if (oldReconnect) oldReconnect.remove();

    function renderReconnectBtn(message, btnText = 'Connect & Show QR Code') {
        if (!qrContainer || document.getElementById('qrReconnectBtnContainer')) return;
        const reconnectDiv = document.createElement('div');
        reconnectDiv.id = 'qrReconnectBtnContainer';
        reconnectDiv.className = 'text-center p-24';

        const waAllowed = CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.wa_enabled);
        if (waAllowed) {
            reconnectDiv.innerHTML = `
                <p class="error-heading">${Icon('x-circle', 'icon-inline')} ${escapeHtml(message)}</p>
                <button class="btn btn-primary btn-sm inline-flex-center-gap-6 mt-8" id="reconnectWaBtn" type="button">
                    ${Icon('refresh-cw', 'icon-inline')} ${escapeHtml(btnText)}
                </button>
            `;
            qrContainer.appendChild(reconnectDiv);
            document.getElementById('reconnectWaBtn')?.addEventListener('click', async () => {
                reconnectDiv.innerHTML = `<div class="qr-loading">${Icon('loader', 'icon-inline')} Starting WhatsApp Client…</div>`;
                try {
                    await api('/api/whatsapp/connect', { method: 'POST' });
                    applyConnectionState({ type: 'loading' });
                } catch (e) {
                    showToast(e.message || 'Failed to start connection', 'error');
                    applyConnectionState({ type: 'error', data: e.message });
                }
            });
        } else {
            reconnectDiv.innerHTML = `
                <p class="error-heading">${Icon('x-circle', 'icon-inline')} ${escapeHtml(message)}</p>
                <p class="qr-error-subtext mt-8">
                    ${Icon('lock', 'icon-inline')} WhatsApp access has not been enabled for your account. Please contact your administrator.
                </p>
            `;
            qrContainer.appendChild(reconnectDiv);
        }
    }

    if (data.type === 'qr') {
        hide(qrLoading);
        hide(qrSuccess);
        if (qrImage) {
            qrImage.src = data.data;
            show(qrImage);
        }
        if (statusDot)  statusDot.className  = 'status-dot warning';
        if (statusText) statusText.textContent = 'QR Ready';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-warning">${Icon('triangle-alert', 'icon-inline')}Scan QR Code to connect. Go to Settings → WhatsApp QR.</p>`;

    } else if (data.type === 'ready') {
        hide(qrLoading); hide(qrImage); show(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot connected';
        if (statusText) statusText.textContent = 'Connected';
        if (connInfo)   connInfo.innerHTML   = `
            <p class="connected-text">${Icon('check-circle', 'icon-inline')}Connected to WhatsApp</p>
            <p>Phone: ${escapeHtml(data.phone || '')}</p>`;

    } else if (data.type === 'reconnecting') {
        hide(qrImage); hide(qrSuccess); show(qrLoading);
        if (qrLoading) qrLoading.textContent = 'Reconnecting to WhatsApp… Please wait.';
        if (statusDot)  statusDot.className  = 'status-dot demo';
        if (statusText) statusText.textContent = 'Reconnecting…';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-warning">${Icon('refresh-cw', 'icon-inline')} Reconnecting WhatsApp session…</p>`;

    } else if (data.type === 'authenticated') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot warning';
        if (statusText) statusText.textContent = 'Authenticated';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-warning">${Icon('check-circle', 'icon-inline')} WhatsApp authenticated! Finalizing sync with phone…</p>`;

    } else if (data.type === 'loading_screen') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot warning';
        const pct = data.percent !== undefined ? data.percent : 0;
        if (statusText) statusText.textContent = `Syncing (${pct}%)`;
        if (connInfo) {
            connInfo.innerHTML = `<p class="text-muted">${Icon('loader', 'icon-inline')} Linking / syncing WhatsApp data: ${pct}% (${escapeHtml(data.message || 'syncing')})</p>`;
        }

    } else if (data.type === 'logged_out') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot error';
        if (statusText) statusText.textContent = 'Logged Out';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-error">${Icon('x-circle', 'icon-inline')}WhatsApp was logged out from the mobile app.</p>`;
        renderReconnectBtn('WhatsApp was logged out from the phone.');

    } else if (data.type === 'error') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot error';
        if (statusText) statusText.textContent = 'Connection Error';
        const errMsg = data.data || data.error || 'Connection error';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-error">${Icon('alert-circle', 'icon-inline')}${escapeHtml(errMsg)}</p>`;
        renderReconnectBtn(errMsg);

    } else if (data.type === 'disconnected') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot error';
        if (statusText) statusText.textContent = 'Disconnected';
        if (connInfo)   connInfo.innerHTML   = `<p class="text-error">${Icon('x-circle', 'icon-inline')}Not connected</p>`;
        renderReconnectBtn('WhatsApp is Disconnected');

    } else if (data.type === 'loading' || data.type === 'connecting') {
        show(qrLoading); hide(qrImage); hide(qrSuccess);
        if (qrLoading) qrLoading.textContent = 'Waiting for QR Code… (This may take up to 30 seconds)';
        if (statusDot)  statusDot.className  = 'status-dot demo';
        if (statusText) statusText.textContent = 'Connecting…';
        if (connInfo)   connInfo.innerHTML   = `<p>${Icon('loader', 'icon-inline')} Loading WhatsApp Client…</p>`;

        if (!_loadingTimeout) {
            _loadingTimeout = setTimeout(() => {
                _loadingTimeout = null;
                // If still loading after 35s, give user actionable retry
                if (statusText && statusText.textContent === 'Connecting…') {
                    if (qrLoading) {
                        qrLoading.innerHTML = `
                            <div>Starting the client is taking longer than usual.</div>
                            <button class="btn btn-secondary btn-sm mt-12 inline-flex-center-gap-6" id="retryLoadingWaBtn" type="button">
                                ${Icon('refresh-cw', 'icon-inline')} Retry Connection
                            </button>
                        `;
                        document.getElementById('retryLoadingWaBtn')?.addEventListener('click', async () => {
                            try {
                                await api('/api/whatsapp/connect', { method: 'POST' });
                                applyConnectionState({ type: 'loading' });
                            } catch (e) {
                                showToast(e.message || 'Retry failed', 'error');
                            }
                        });
                    }
                }
            }, 35000);
        }
    }
}


// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '';
    const diffMins = Math.floor((Date.now() - d) / 60000);
    if (diffMins < 1)  return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24)  return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {

    // ── Icons ────────────────────────────────────────────────
    // Hydrates every static [data-icon] element written in index.html into
    // an inline SVG (see js/icons.js). Dynamic content rendered by this file
    // calls Icon() directly inside its template strings instead.
    if (typeof hydrateIcons === 'function') hydrateIcons();

    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const id = Number(button.dataset.id);
        switch (button.dataset.action) {
            case 'analyze-lead': analyzeLead(button.dataset.phone); break;
            case 'toggle-product': toggleProduct(id, Number(button.dataset.value)); break;
            case 'delete-product': deleteProductRow(id); break;
            case 'toggle-rule': toggleRule(id, Number(button.dataset.value)); break;
            case 'delete-rule': deleteRule(id); break;
            case 'toggle-optout': toggleContactOptOut(id, button.dataset.opted === '1'); break;
            case 'edit-contact': openEditContactModal(id); break;
            case 'delete-contact': deleteContact(id); break;
            case 'cancel-scheduled': cancelScheduled(id); break;
            case 'cancel-appointment': cancelAppointment(id, button); break;
        }
    });

    // ── Auth gate ────────────────────────────────────────────
    // Redirects to /login if there's no valid session — nothing else on
    // this page should run for a logged-out visitor.
    const authed = await checkAuth();
    if (!authed) return;

    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    window.addEventListener('beforeunload', () => stopSSE());

    // ── Settings tabs ──────────────────────────────────────
    initSettingsTabs();
    initCalendarSettings();
    initBookingSettings();

    // ── Navigation ─────────────────────────────────────────
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // Not every sidebar link is a section of this single-page app.
            // The Admin panel is its own page (href="/admin") and carries no
            // data-section — swallowing its click here is what made it
            // highlight the item, blank the content area, and never leave
            // /app. No data-section means "let the browser follow the href".
            if (!item.dataset.section) return;
            e.preventDefault();
            navigateTo(item.dataset.section);
        });
    });

    // ── Mobile menu ─────────────────────────────────────────
    const menuToggle = document.getElementById('menuToggle');
    const sidebar    = document.getElementById('sidebar');
    const overlay    = document.getElementById('overlay');

    menuToggle.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('open');
        overlay.classList.toggle('active', isOpen);
        menuToggle.setAttribute('aria-expanded', String(isOpen));
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
    });

    // ── Topbar refresh ──────────────────────────────────────
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        loadSectionData(currentSection);
        showToast('Refreshed', 'info');
    });

    // ── Dashboard stat tiles → navigate ─────────────────────
    document.querySelectorAll('.stat-clickable[data-goto]').forEach(tile => {
        tile.addEventListener('click', () => navigateTo(tile.dataset.goto));
        tile.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(tile.dataset.goto); }
        });
        tile.setAttribute('tabindex', '0');
    });

    // ── Quick send form ─────────────────────────────────────
    document.getElementById('quickSendForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone   = document.getElementById('qsPhone').value.trim();
        const message = document.getElementById('qsMessage').value.trim();
        if (!phone || !message) return;

        const btn = document.getElementById('quickSendBtn');
        btn.disabled = true;
        btn.textContent = 'Sending…';

        try {
            await api('/api/messages/send', {
                method: 'POST',
                body: JSON.stringify({ phone, body: message })
            });
            showToast(`Message sent to ${phone}`, 'success');
            document.getElementById('qsPhone').value    = '';
            document.getElementById('qsMessage').value  = '';
            loadMessages();
        } catch (err) {
            showToast(err.message || 'Failed to send message', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('send')}</span> Send Message`;
        }
    });

    // ── Add chatbot rule ────────────────────────────────────
    document.getElementById('addRuleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const trigger_keyword = document.getElementById('ruleTrigger').value.trim();
        const match_type      = document.getElementById('ruleMatchType').value;
        const response_text   = document.getElementById('ruleResponse').value.trim();
        const priority        = parseInt(document.getElementById('rulePriority').value) || 0;

        if (!trigger_keyword || !response_text) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/chatbot/rules', {
                method: 'POST',
                body: JSON.stringify({ trigger_keyword, match_type, response_text, priority })
            });
            showToast('Rule added successfully!', 'success');
            document.getElementById('addRuleForm').reset();
            document.getElementById('rulePriority').value = '5';
            loadChatbotRules();
        } catch (err) {
            showToast('Failed to add rule', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Rule';
        }
    });

    // ── Test chatbot ────────────────────────────────────────
    document.getElementById('testChatbotBtn').addEventListener('click', testChatbot);
    document.getElementById('testMessage').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); testChatbot(); }
    });

    // ── Add contact form ────────────────────────────────────
    document.getElementById('addContactForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('contactPhone').value.trim();
        const name  = document.getElementById('contactName').value.trim();
        const label = document.getElementById('contactLabel').value.trim();

        if (!phone) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/contacts', {
                method: 'POST',
                body: JSON.stringify({ phone, name, label })
            });
            showToast('Contact added!', 'success');
            document.getElementById('addContactForm').reset();
            loadContactLabels();
            loadContacts(0);
        } catch (err) {
            showToast('Failed to add contact', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Contact';
        }
    });

    // ── Contact search, label filter & pagination ───────────
    let contactSearchTimeout;
    document.getElementById('contactSearch')?.addEventListener('input', () => {
        clearTimeout(contactSearchTimeout);
        contactSearchTimeout = setTimeout(() => {
            contactsCurrentOffset = 0;
            loadContacts(0);
        }, 300);
    });
    document.getElementById('contactLabelFilter')?.addEventListener('change', () => {
        contactsCurrentOffset = 0;
        loadContacts(0);
    });
    document.getElementById('contactsPageSize')?.addEventListener('change', () => {
        contactsCurrentOffset = 0;
        loadContacts(0);
    });
    document.getElementById('contactsPrevBtn')?.addEventListener('click', contactsPrevPage);
    document.getElementById('contactsNextBtn')?.addEventListener('click', contactsNextPage);

    // ── Edit contact modal listeners ────────────────────────
    document.getElementById('editContactModalClose')?.addEventListener('click', closeEditContactModal);
    document.getElementById('editContactCancelBtn')?.addEventListener('click', closeEditContactModal);
    document.getElementById('editContactModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'editContactModalBackdrop') closeEditContactModal();
    });
    document.getElementById('editContactForm')?.addEventListener('submit', saveContactFromForm);

    // ── CSV import ───────────────────────────────────────────
    document.getElementById('csvFileInput').addEventListener('change', handleCsvFileSelected);
    document.getElementById('downloadCsvTemplate').addEventListener('click', (e) => {
        e.preventDefault();
        downloadCsvTemplate();
    });

    // ── Contacts selection (select-all / clear) ─────────────
    document.getElementById('contactsSelectAll').addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.contact-row-check').forEach(cb => {
            if (cb.disabled || cb.dataset.opted === '1') {
                cb.checked = false;
                return;
            }
            cb.checked = checked;
            cb.dispatchEvent(new Event('change'));
        });
    });
    document.getElementById('clearSelectionBtn').addEventListener('click', () => {
        SELECTED_CONTACTS.clear();
        document.querySelectorAll('.contact-row-check').forEach(cb => { cb.checked = false; });
        document.getElementById('contactsSelectAll').checked = false;
        updateSelectionBar();
    });

    // ── Quick-select N for outreach ──────────────────────────
    document.querySelectorAll('.quick-select-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('quickSelectCount').value = btn.dataset.n;
            quickSelectNext(Number(btn.dataset.n));
        });
    });
    document.getElementById('quickSelectBtn').addEventListener('click', () => {
        const n = Math.max(1, parseInt(document.getElementById('quickSelectCount').value, 10) || 0);
        quickSelectNext(n);
    });

    // ── Outreach modal & Campaign Composer ───────────────────
    document.getElementById('openOutreachBtn')?.addEventListener('click', openOutreachModal);
    document.getElementById('outreachModalClose')?.addEventListener('click', closeOutreachModal);
    document.getElementById('outreachCancelBtn')?.addEventListener('click', closeOutreachModal);
    document.getElementById('outreachModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'outreachModalBackdrop') closeOutreachModal();
    });
    document.getElementById('outreachSendBtn')?.addEventListener('click', submitOutreach);
    document.getElementById('outreachDoneBtn')?.addEventListener('click', closeOutreachModal);
    document.getElementById('outreachMediaSelect')?.addEventListener('change', onOutreachMediaChange);
    document.getElementById('outreachClearMediaBtn')?.addEventListener('click', clearOutreachMedia);

    // Composer tabs
    document.getElementById('tabSelectExisting')?.addEventListener('click', () => switchComposerTab('existing'));
    document.getElementById('tabImportCsv')?.addEventListener('click', () => switchComposerTab('csv'));

    // Message personalization and char counter
    document.getElementById('outreachInsertNameTag')?.addEventListener('click', insertNameTokenToMessage);
    document.getElementById('outreachMessage')?.addEventListener('input', updateOutreachMessageStats);

    // Buffer spacing controls
    document.getElementById('outreachBufferMinutes')?.addEventListener('change', updateOutreachEstimate);
    document.getElementById('outreachBufferChips')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-buffer-min]');
        if (btn) {
            const select = document.getElementById('outreachBufferMinutes');
            if (select) {
                select.value = btn.dataset.bufferMin;
                updateOutreachEstimate();
            }
        }
    });

    // CSV import controls inside composer
    document.getElementById('outreachDownloadCsvTemplate')?.addEventListener('click', (e) => {
        e.preventDefault();
        downloadCsvTemplate();
    });
    document.getElementById('outreachCsvFileInput')?.addEventListener('change', handleComposerCsvSelected);
    document.getElementById('outreachConfirmImportBtn')?.addEventListener('click', confirmComposerCsvImport);
    document.getElementById('outreachCancelCsvBtn')?.addEventListener('click', clearComposerCsvFile);

    let outreachSearchTimeout;
    document.getElementById('outreachContactSearch')?.addEventListener('input', (e) => {
        clearTimeout(outreachSearchTimeout);
        outreachSearchTimeout = setTimeout(() => {
            const label = document.getElementById('outreachContactLabelFilter')?.value || '';
            loadOutreachPickerContacts(e.target.value.trim(), label);
        }, 250);
    });
    document.getElementById('outreachContactLabelFilter')?.addEventListener('change', (e) => {
        const search = document.getElementById('outreachContactSearch')?.value.trim() || '';
        loadOutreachPickerContacts(search, e.target.value);
    });
    document.getElementById('outreachPreset10')?.addEventListener('click', () => quickSelectOutreachPicker(10));
    document.getElementById('outreachPreset20')?.addEventListener('click', () => quickSelectOutreachPicker(20));
    document.getElementById('outreachPreset25')?.addEventListener('click', () => quickSelectOutreachPicker(25));
    document.getElementById('outreachSelectAllBtn')?.addEventListener('click', selectEligibleOutreachPicker);
    document.getElementById('outreachClearRecipientsBtn')?.addEventListener('click', clearOutreachPickerSelection);

    // ── Campaigns section & modal ─────────────────────────────
    document.getElementById('newCampaignBtn')?.addEventListener('click', startNewCampaignFromCampaigns);
    document.getElementById('refreshCampaignsBtn')?.addEventListener('click', () => loadCampaigns(0));
    document.getElementById('campaignStatusFilter')?.addEventListener('change', () => loadCampaigns(0));
    document.getElementById('campaignsPrevBtn')?.addEventListener('click', campaignsPrevPage);
    document.getElementById('campaignsNextBtn')?.addEventListener('click', campaignsNextPage);
    document.getElementById('campaignsBody')?.addEventListener('click', (e) => {
        const viewBtn = e.target.closest('[data-view-campaign]');
        if (viewBtn) {
            viewCampaignDetails(viewBtn.dataset.viewCampaign);
            return;
        }
        const cancelBtn = e.target.closest('[data-cancel-campaign]');
        if (cancelBtn) {
            cancelCampaign(cancelBtn.dataset.cancelCampaign);
            return;
        }
    });
    document.getElementById('campaignDetailModalClose')?.addEventListener('click', closeCampaignDetailModal);
    document.getElementById('campaignDetailDoneBtn')?.addEventListener('click', closeCampaignDetailModal);
    document.getElementById('campaignDetailCancelBtn')?.addEventListener('click', (e) => {
        const jobId = e.currentTarget.dataset.jobId;
        if (jobId) cancelCampaign(jobId);
    });
    document.getElementById('campaignDetailRetryBtn')?.addEventListener('click', async (e) => {
        const jobId = e.currentTarget.dataset.jobId;
        if (!jobId) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            const res = await api(`/api/contacts/outreach/${encodeURIComponent(jobId)}/retry-failed`, { method: 'POST' });
            showToast(`Retrying ${res.data?.retried || 'failed'} recipient(s)...`, 'info');
            await viewCampaignDetails(jobId);
            if (currentSection === 'campaigns') {
                await loadCampaigns(campaignsCurrentOffset);
            }
        } catch (err) {
            showToast(err.message || 'Failed to retry recipients', 'error');
        } finally {
            btn.disabled = false;
        }
    });
    document.getElementById('campaignDetailModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'campaignDetailModalBackdrop') closeCampaignDetailModal();
    });

    // ── Message search & filter ─────────────────────────────
    let messageSearchTimeout;
    document.getElementById('messageSearch').addEventListener('input', () => {
        clearTimeout(messageSearchTimeout);
        messageSearchTimeout = setTimeout(loadMessages, 300);
    });
    document.getElementById('messageFilter').addEventListener('change', loadMessages);
    document.getElementById('messagesBody').addEventListener('click', (event) => {
        const button = event.target.closest('[data-open-conversation]');
        if (button) openConversation(button.dataset.openConversation);
    });
    document.getElementById('conversationModalClose').addEventListener('click', closeConversationModal);
    document.getElementById('conversationModalBackdrop').addEventListener('click', (event) => {
        if (event.target.id === 'conversationModalBackdrop') closeConversationModal();
    });

    // ── Global (topbar) search — jumps to Contacts and filters there,
    // since that's the most common "find someone" lookup. Also mirrors
    // the term into Messages' own search box so it's ready if the user
    // clicks over there next.
    const globalSearchEl = document.getElementById('globalSearch');
    globalSearchEl?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const term = globalSearchEl.value.trim();
        if (!term) return;
        const contactSearchEl = document.getElementById('contactSearch');
        const messageSearchEl = document.getElementById('messageSearch');
        if (contactSearchEl) contactSearchEl.value = term;
        if (messageSearchEl) messageSearchEl.value = term;
        navigateTo('contacts');
        contactsCurrentOffset = 0;
        loadContacts(0);
    });

    // ── Lead analysis controls ──────────────────────────────
    document.getElementById('analyzeAllBtn')?.addEventListener('click', analyzeAllLeads);
    document.getElementById('leadInterestFilter')?.addEventListener('change', loadLeads);
    document.getElementById('leadPriorityFilter')?.addEventListener('change', loadLeads);
    document.getElementById('leadTemperatureFilter')?.addEventListener('change', loadLeads);

    // ── CRM controls ────────────────────────────────────────
    document.getElementById('addDealBtn')?.addEventListener('click', () => {
        const card = document.getElementById('addDealCard');
        if (!card) return;
        const willShow = card.hidden || card.style.display === 'none';
        card.hidden = !willShow;
        card.style.display = willShow ? '' : 'none';
    });
    document.getElementById('crmTemperatureFilter')?.addEventListener('change', loadCrm);
    document.getElementById('crmAgentFilter')?.addEventListener('change', loadCrm);
    document.getElementById('crmSlaFilter')?.addEventListener('change', loadCrm);

    const overdueBtn = document.getElementById('crmOverdueBtn');
    overdueBtn?.addEventListener('click', () => {
        isCrmOverdueActive = !isCrmOverdueActive;
        overdueBtn.classList.toggle('btn-primary', isCrmOverdueActive);
        overdueBtn.classList.toggle('btn-secondary', !isCrmOverdueActive);
        loadCrm();
    });

    const toggleWorkloadBtn = document.getElementById('toggleAgentWorkloadBtn');
    toggleWorkloadBtn?.addEventListener('click', () => {
        const card = document.getElementById('agentWorkloadCard');
        if (!card) return;
        const willShow = card.hidden || card.style.display === 'none';
        card.hidden = !willShow;
        card.style.display = willShow ? '' : 'none';
        if (willShow) loadAgentWorkload();
    });

    document.getElementById('addAgentBtn')?.addEventListener('click', () => openAgentModal(null));
    document.getElementById('agentModalClose')?.addEventListener('click', closeAgentModal);
    document.getElementById('agentModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeAgentModal();
    });
    document.getElementById('agentForm')?.addEventListener('submit', saveAgentFromForm);
    document.getElementById('deleteAgentBtn')?.addEventListener('click', deleteAgentFromForm);

    document.getElementById('agentWorkloadList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-agent-action]');
        if (!btn || btn.disabled) return;
        const agentId = Number(btn.dataset.agentId);
        if (btn.dataset.agentAction === 'toggle-status') {
            toggleAgentStatus(agentId, btn.dataset.currentStatus, btn);
        } else if (btn.dataset.agentAction === 'edit') {
            const agent = agentsCache.find(a => a.id === agentId);
            if (agent) openAgentModal(agent);
        }
    });

    document.getElementById('addDealForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('dealPhone').value.trim();
        if (!phone) return;
        try {
            await api('/api/crm/deals', {
                method: 'POST',
                body: JSON.stringify({
                    phone,
                    contact_name:     document.getElementById('dealName').value.trim(),
                    deal_value:       document.getElementById('dealValue').value,
                    stage:            document.getElementById('dealStage').value,
                    product_interest: document.getElementById('dealProduct').value.trim()
                })
            });
            showToast('Deal added!', 'success');
            document.getElementById('addDealForm').reset();
            const addCard = document.getElementById('addDealCard');
            if (addCard) {
                addCard.hidden = true;
                addCard.style.display = 'none';
            }
            loadCrm();
        } catch (err) {
            showToast(err.message || 'Failed to add deal', 'error');
        }
    });

    // Deal modal close handlers
    document.getElementById('dealModalClose')?.addEventListener('click', closeDealModal);
    document.getElementById('dealModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeDealModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDealModal();
            closeAgentModal();
            closeCampaignDetailModal();
            closeOutreachModal();
            closeAppointmentDetailModal();
        }
    });
    document.getElementById('agentModal')?.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (event) => {
        const dealCard = event.target.closest('[data-open-deal]');
        if (dealCard) return openDealModal(dealCard.dataset.openDeal);
        const action = event.target.closest('[data-deal-action]');
        if (!action) return;
        if (action.dataset.dealAction === 'save') return saveDealFromModal(action.dataset.dealId);
        if (action.dataset.dealAction === 'toggle-ai') return toggleAiPauseFromModal(action.dataset.dealId, action.dataset.dealPaused === 'true');
        if (action.dataset.dealAction === 'delete') return deleteDealFromModal(action.dataset.dealId);
        if (action.dataset.dealAction === 'note') return addNoteFromModal();
        if (action.dataset.dealAction === 'reassign') return reassignDealFromModal(action.dataset.dealId);
    });

    // ── Business Setup controls ─────────────────────────────
    document.getElementById('businessForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveBusinessBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_website:          document.getElementById('bizWebsite').value.trim(),
                    business_industry:         document.getElementById('bizIndustry').value.trim(),
                    business_description:      document.getElementById('bizDescription').value.trim(),
                    business_target_customers: document.getElementById('bizTarget').value.trim(),
                    business_currency:         document.getElementById('bizCurrency').value.trim() || '₹',
                    business_offers:           document.getElementById('bizOffers').value.trim()
                })
            });
            showToast('Business profile saved! The AI will use it right away.', 'success');
        } catch (err) {
            showToast('Failed to save business profile', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Business Profile';
        }
    });

    document.getElementById('addProductForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('prodName').value.trim();
        if (!name) return;
        try {
            await api('/api/products', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    price:       document.getElementById('prodPrice').value.trim(),
                    category:    document.getElementById('prodCategory').value.trim(),
                    description: document.getElementById('prodDesc').value.trim(),
                    url:         document.getElementById('prodUrl').value.trim()
                })
            });
            showToast('Added to catalog!', 'success');
            document.getElementById('addProductForm').reset();
            loadBusiness();
        } catch (err) {
            showToast('Failed to add product', 'error');
        }
    });

    document.getElementById('analyzeBusinessBtn')?.addEventListener('click', analyzeBusiness);

    // ── Schedule message form ───────────────────────────────
    // The <input type="datetime-local"> gives back a value like "2026-08-08T14:30" —
    // your LOCAL wall-clock time, with no timezone info and no seconds. The
    // server compares scheduled_at against SQLite's datetime('now'), which is
    // UTC in "YYYY-MM-DD HH:MM:SS" format. Sending the raw local value through
    // unconverted both (a) uses the wrong separator so the comparison never
    // matches — messages would sit "pending" indefinitely instead of sending
    // on time — and (b) ignores the local/UTC offset, so even once that's
    // fixed the message fires at the wrong wall-clock time for anyone not in
    // UTC. Converting through a real Date object fixes both at once.
    function toSqliteUtc(datetimeLocalValue) {
        const d = new Date(datetimeLocalValue);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
    }

    const schedDateInput = document.getElementById('schedDate');
    if (schedDateInput) {
        // Guide the native picker away from the past (not all browsers enforce
        // `min` on datetime-local, so this is a UX nudge, not the real guard).
        const pad = n => String(n).padStart(2, '0');
        const now = new Date();
        schedDateInput.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone          = document.getElementById('schedPhone').value.trim();
        const body           = document.getElementById('schedMessage').value.trim();
        const localValue     = document.getElementById('schedDate').value;

        if (!phone || !body || !localValue) return;

        const scheduled_at = toSqliteUtc(localValue);
        if (!scheduled_at) {
            showToast('That date/time doesn\'t look valid.', 'error');
            return;
        }
        if (new Date(localValue).getTime() < Date.now()) {
            showToast('Pick a time in the future — that one has already passed.', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Scheduling…';

        try {
            await api('/api/scheduled', {
                method: 'POST',
                body: JSON.stringify({ phone, body, scheduled_at })
            });
            showToast('Message scheduled!', 'success');
            document.getElementById('scheduleForm').reset();
            loadScheduled();
        } catch (err) {
            showToast(err.message || 'Failed to schedule message', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Schedule Message';
        }
    });

    // ── Manual appointment booking form ─────────────────────
    document.getElementById('apptRefreshSlotsBtn')?.addEventListener('click', loadApptSlotOptions);

    document.getElementById('apptBookForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('apptPhone').value.trim();
        const contactName = document.getElementById('apptContactName').value.trim();
        const notes = document.getElementById('apptNotes').value.trim();
        const startIso = document.getElementById('apptSlotSelect').value;

        if (!phone || !startIso) {
            showToast('Pick a phone number and an available slot', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Booking…';

        try {
            await api('/api/appointments', {
                method: 'POST',
                body: JSON.stringify({ phone, contactName, notes, startIso })
            });
            showToast('Appointment booked!', 'success');
            document.getElementById('apptBookForm').reset();
            loadAppointments();
        } catch (err) {
            showToast(err.message || 'Failed to book appointment', 'error');
            loadApptSlotOptions();
        } finally {
            btn.disabled = false;
            btn.textContent = 'Book Appointment';
        }
    });

    // ── Appointment list actions & detail modal ──────────────
    document.getElementById('appointmentsBody')?.addEventListener('click', (e) => {
        const viewBtn = e.target.closest('[data-action="view-appointment"]');
        if (viewBtn) return openAppointmentDetailModal(viewBtn.dataset.id);
        const contactLink = e.target.closest('[data-open-appointment]');
        if (contactLink) return openAppointmentDetailModal(contactLink.dataset.openAppointment);
        const cancelBtn = e.target.closest('[data-action="cancel-appointment"]');
        if (cancelBtn) {
            e.stopPropagation();
            return cancelAppointment(cancelBtn.dataset.id, cancelBtn);
        }
    });
    document.getElementById('appointmentDetailModalClose')?.addEventListener('click', closeAppointmentDetailModal);
    document.getElementById('appointmentDetailModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target.id === 'appointmentDetailModalBackdrop') closeAppointmentDetailModal();
    });

    // ── Settings (General) form ─────────────────────────────
    document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveSettingsBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_name:   document.getElementById('settBusinessName')?.value  || '',
                    chatbot_enabled: document.getElementById('settChatbotEnabled')?.checked ? 'true' : 'false',
                    default_reply:   document.getElementById('settDefaultReply')?.value  || '',
                    away_mode:       document.getElementById('settAwayMode')?.checked    ? 'true' : 'false',
                    away_message:    document.getElementById('settAwayMessage')?.value   || '',
                    welcome_message: document.getElementById('settWelcomeMessage')?.value || ''
                })
            });
            showToast('Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Settings';
        }
    });

    // ── Persona Preset buttons ──────────────────────────────
    const PRESETS = {
        casual:       `You are a real, friendly AI chatting on WhatsApp on behalf of your owner.\n- Talk naturally, casually, and warmly, just like a real person texting on WhatsApp.\n- Keep responses short (1-3 sentences), concise, and conversational.\n- Answer questions directly, chat with friends or clients, and be helpful.\n- If someone asks personal details you don't know, politely say you'll let the owner know.\n- Use occasional emojis naturally 😊.`,
        assistant:    `You are the personal AI assistant for your owner on WhatsApp.\n- Politely assist whoever is reaching out.\n- Help answer common questions, take down messages, or provide useful details.\n- If urgent, ask them to leave a clear note so the owner can follow up directly.\n- Maintain a polite, helpful, and organized tone.`,
        professional: `You are an AI replying on WhatsApp for professional and business communications.\n- Respond with clarity, courtesy, and efficiency.\n- Keep answers crisp, structured, and informative.\n- If asked for estimates, bookings, or confidential info, politely request their contact details/requirements so the owner can review.`,
        short:        `You are texting on WhatsApp on behalf of your owner.\n- Keep all replies extremely short (1 sentence or a few words max).\n- Direct, friendly, and concise. No fluff or extra explanations.`
    };

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.preset;
            if (PRESETS[key]) {
                const promptArea = document.getElementById('settAiSystemPrompt');
                if (promptArea) promptArea.value = PRESETS[key];
                showToast(`Applied ${btn.textContent.trim()} preset!`, 'success');
            }
        });
    });

    // ── AI Settings form ────────────────────────────────────
    document.getElementById('aiSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveAiBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const payload = {
                ai_enabled:       document.getElementById('settAiEnabled')?.checked   ? 'true' : 'false',
                owner_name:       document.getElementById('settOwnerName')?.value     || '',
                ai_mode:          document.getElementById('settAiMode')?.value        || 'ai_first',
                ai_system_prompt: document.getElementById('settAiSystemPrompt')?.value || ''
            };

            // If AI is enabled, ensure chatbot auto-replies are enabled
            if (payload.ai_enabled === 'true') {
                payload.chatbot_enabled = 'true';
                const cb = document.getElementById('settChatbotEnabled');
                if (cb) cb.checked = true;
            }

            const newKey = document.getElementById('settGeminiApiKey')?.value?.trim();
            // Only send gemini_api_key if user typed something new. Leaving blank keeps current key!
            if (newKey) {
                payload.gemini_api_key = newKey;
            }

            const modelSelect = document.getElementById('settGeminiModel');
            let chosenModel = modelSelect?.value || 'auto';
            if (chosenModel === 'custom') {
                chosenModel = document.getElementById('settGeminiCustomModel')?.value?.trim() || 'auto';
            }
            payload.gemini_model = chosenModel;

            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            showToast('AI Persona Settings saved!', 'success');
            loadSettings();
            loadDashboard();
        } catch (err) {
            showToast('Failed to save AI settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save AI Persona Settings';
        }
    });

    // ── Gemini Model Custom Toggle ───────────────────────────
    document.getElementById('settGeminiModel')?.addEventListener('change', (e) => {
        const customWrapper = document.getElementById('customModelWrapper');
        if (customWrapper) {
            customWrapper.style.display = e.target.value === 'custom' ? 'block' : 'none';
        }
    });

    // ── Test Gemini API Key ─────────────────────────────────
    document.getElementById('testGeminiApiKeyBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('testGeminiApiKeyBtn');
        const keyInput = document.getElementById('settGeminiApiKey');
        const keyVal = keyInput?.value?.trim();
        const modelSelect = document.getElementById('settGeminiModel');
        let preferredModel = modelSelect?.value || 'auto';
        if (preferredModel === 'custom') {
            preferredModel = document.getElementById('settGeminiCustomModel')?.value?.trim() || '';
        }

        btn.disabled = true;
        btn.textContent = 'Testing…';
        try {
            const data = await api('/api/settings/test-gemini', {
                method: 'POST',
                body: JSON.stringify({ key: keyVal || '', model: preferredModel || '' })
            });
            const modelName = data?.model || data?.data?.model || 'Gemini';
            showToast(`Gemini connected successfully! (Model: ${modelName})`, 'success');
            if (keyVal) {
                showToast('Key is valid! Click "Save AI Persona Settings" to save it.', 'info');
            }
        } catch (err) {
            showToast(err.message || 'Gemini test failed', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Test Key';
        }
    });

    // ── Remove Gemini API Key ───────────────────────────────
    document.getElementById('removeGeminiApiKeyBtn')?.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to remove your Gemini API key? AI auto-replies will stop working until a new key is provided.')) return;
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ gemini_api_key: '' })
            });
            showToast('Gemini API key removed', 'success');
            loadSettings();
            loadDashboard();
        } catch (err) {
            showToast('Failed to remove API key', 'error');
        }
    });

    // ── Danger Zone buttons ─────────────────────────────────
    document.getElementById('pauseChatbotBtn')?.addEventListener('click', async () => {
        if (!confirm('Pause the chatbot? Auto-replies will stop until you re-enable it in General settings.')) return;
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ chatbot_enabled: 'false' })
            });
            // Reflect in General tab
            const el = document.getElementById('settChatbotEnabled');
            if (el) el.checked = false;
            showToast('Chatbot paused', 'success');
        } catch (err) {
            showToast('Failed to pause chatbot', 'error');
        }
    });

    document.getElementById('clearMessagesBtn')?.addEventListener('click', async () => {
        if (!confirm('Permanently delete ALL stored messages? This cannot be undone.')) return;
        try {
            await api('/api/messages', { method: 'DELETE' });
            showToast('Message history cleared', 'success');
            if (currentSection === 'messages') loadMessages();
            if (currentSection === 'dashboard') loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to clear message history', 'error');
        }
    });

    document.getElementById('disconnectBtn')?.addEventListener('click', async () => {
        if (!confirm('Disconnect this WhatsApp number? You can reconnect any time by scanning a new QR code.')) return;
        try {
            await api('/api/whatsapp/disconnect', { method: 'POST' });
            applyConnectionState({ type: 'disconnected' });
            showToast('WhatsApp disconnected.', 'success');
            if (currentSection === 'dashboard') loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to disconnect', 'error');
        }
    });

    // ── Initial load ────────────────────────────────────────
    loadDashboard();
    initSSE();

    // ── Auto-refresh active section every 15 s ───────────────────
    setInterval(() => {
        // Skip background refresh if user is currently typing in an input or modal is open
        const isEditing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
        const isModalOpen = document.querySelector('.modal-backdrop[style*="display: block"], .modal-backdrop:not([style*="display: none"]):not([style*="display:none"])');
        if (isEditing || isModalOpen) return;

        if (currentSection === 'dashboard') {
            loadDashboard();
        } else if (currentSection === 'messages') {
            loadMessages();
        } else if (currentSection === 'leads') {
            loadLeads();
        } else if (currentSection === 'crm') {
            loadCrm();
        } else if (currentSection === 'campaigns') {
            loadCampaigns(campaignsCurrentOffset);
        }
    }, 15000);
});
