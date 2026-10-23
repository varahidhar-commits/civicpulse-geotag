// ==========================================================================
// CivicPulse - Government portal
// ==========================================================================
const GovernmentPortal = (() => {
  let govMap, statusChart, categoryChart, regionChart, workersCache = [];

  function init() {
    document.querySelectorAll('#view-government [data-gv]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.gv));
    });
    document.getElementById('btn-refresh-gov').addEventListener('click', loadOverview);
    document.getElementById('btn-apply-gov-filter').addEventListener('click', loadComplaints);
    document.getElementById('btn-refresh-alerts').addEventListener('click', loadAlerts);
    document.addEventListener('civic-language-changed', () => {
      // Canvas chart labels are painted pixels, so repaint in the new language.
      if (!document.getElementById('gv-overview').classList.contains('hidden') &&
          !document.getElementById('view-government').classList.contains('hidden')) loadOverview();
    });
    // Refresh the badge only when the officer is online and viewing this portal.
    setInterval(() => {
      if (Session.hasRole('government')) loadAlertBadge();
    }, 30 * 1000);
  }

  function switchView(name) {
    document.querySelectorAll('#view-government [data-gv]').forEach((b) => b.classList.toggle('active', b.dataset.gv === name));
    ['overview', 'alerts', 'complaints', 'map', 'disaster', 'grievances', 'directory'].forEach((v) => {
      document.getElementById(`gv-${v}`).classList.toggle('hidden', v !== name);
    });
    if (name === 'overview') loadOverview();
    if (name === 'alerts') loadAlerts();
    if (name === 'complaints') loadComplaints();
    if (name === 'map') loadGovMap();
    if (name === 'disaster') DisasterPrevention.renderGov();
    if (name === 'grievances') loadGrievances();
    if (name === 'directory') loadDirectory();
  }

  function welcomeText() {
    const u = Session.user;
    if (u) document.getElementById('gov-welcome').textContent = `Welcome, ${u.name.split('(')[0].trim()}`;
  }

  async function loadOverview() {
    welcomeText();
    loadAlertBadge();
    try {
      const stats = await Api.stats();
      const kpis = document.getElementById('gov-kpis');
      kpis.innerHTML = [
        kpi('Total reports', stats.total, ''),
        kpi('Pending', stats.pending, 'Awaiting assignment'),
        kpi('In progress', stats.inProgress, 'Currently being worked'),
        kpi('Critical', stats.critical, 'Needs urgent attention'),
        kpi('Verified fixes', stats.verified, 'Confirmed by citizens'),
        kpi('Avg. resolution', `${stats.avgResolutionHours}h`, 'Report to resolve')
      ].join('');

      renderChart('chart-status', () => statusChart, (c) => statusChart = c, 'doughnut', Object.keys(stats.byStatus).map((k) => STATUS_LABELS[k] || k), Object.values(stats.byStatus), Object.keys(stats.byStatus).map((k) => STATUS_MAP_COLOR[k] || '#999'));
      renderChart('chart-category', () => categoryChart, (c) => categoryChart = c, 'bar', Object.keys(stats.byCategory).map(categoryLabel), Object.values(stats.byCategory), '#2C63C7');
      renderChart('chart-region', () => regionChart, (c) => regionChart = c, 'bar', Object.keys(stats.byRegion), Object.values(stats.byRegion), '#E8A33D', true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadAlertBadge() {
    try {
      const { unreadCount } = await Api.govNotifications();
      const el = document.getElementById('gov-alert-count');
      if (el) el.textContent = unreadCount ? `(${unreadCount})` : '';
    } catch (err) { console.warn('Could not refresh delay notification badge:', err); }
  }

  async function loadAlerts() {
    const el = document.getElementById('gov-alerts-list');
    el.innerHTML = '<p>Loading alerts…</p>';
    try {
      const { notifications, unreadCount } = await Api.govNotifications();
      const badge = document.getElementById('gov-alert-count');
      if (badge) badge.textContent = unreadCount ? `(${unreadCount})` : '';
      if (!notifications.length) {
        el.innerHTML = '<div class="empty-state"><p>✅ No worker delays reported yet.</p></div>';
        return;
      }
      el.innerHTML = notifications.map(n => `
        <div class="card" style="margin-bottom:12px;border-left:4px solid ${n.readAt ? '#8aa0b3' : '#e35b4f'}">
          <div class="complaint-title" data-i18n-allow>⚠️ ${n.type === 'worker_resolution_overdue' ? 'Worker delay — resolution not submitted' : 'Worker not yet started the work'}: ${escapeHtml(n.complaintTitle || 'Complaint')}</div>
          <div class="complaint-meta"><span>Assigned worker: <b>${escapeHtml(n.workerName)}</b></span>
            <span>${n.type === 'worker_resolution_overdue' ? 'Completion deadline' : 'Start deadline'}: ${escapeHtml(new Date(n.deadlineAt).toLocaleString(I18n.locale(), {hour12:true}))}</span>
            <span>${escapeHtml(timeAgo(n.createdAt))}</span></div>
          <p class="field-hint">Complaint ID: ${escapeHtml(n.complaintId)}. <span>${n.type === 'worker_resolution_overdue' ? 'Contact the worker about the overdue resolution.' : 'Please contact the worker or reassign the unstarted task.'}</span><br>Assigned: ${escapeHtml(n.assignedAt ? new Date(n.assignedAt).toLocaleString() : 'Unknown (legacy)')} · Started: ${escapeHtml(n.startedAt ? new Date(n.startedAt).toLocaleString() : 'Not started')}<br>Start deadline: ${escapeHtml(n.startDeadlineAt || n.deadlineAt || 'Not set')} · Completion deadline: ${escapeHtml(n.completionDeadlineAt || 'Not set')}<br>${escapeHtml(n.address || '')} · ${escapeHtml(n.region || '')} · ${escapeHtml(n.priorityLevel || '')}</p>
          ${!n.readAt ? `<button class="btn btn-outline btn-sm" data-read-alert="${escapeHtml(n.id)}">Mark as read</button>` : '<span class="field-hint">✓ Read</span>'}
        </div>`).join('');
      el.querySelectorAll('[data-read-alert]').forEach(btn => btn.addEventListener('click', async () => {
        try { await Api.markGovNotificationRead(btn.dataset.readAlert); await loadAlerts(); }
        catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) { el.innerHTML = alertHtml(err.message); }
  }

  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }

  function renderChart(canvasId, getter, setter, type, labels, data, color, horizontal = false) {
    if (typeof Chart === 'undefined') {
      const canvas = document.getElementById(canvasId);
      if (canvas) canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'field-hint', textContent: 'Chart library unavailable (offline or CDN blocked).' }));
      return;
    }
    const existing = getter();
    if (existing) existing.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    const chart = new Chart(ctx, {
      type,
      data: {
        labels: labels.map((label) => I18n.t(label)),
        datasets: [{ label: 'Count', data, backgroundColor: Array.isArray(color) ? color : color, borderRadius: 6 }]
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        plugins: { legend: { display: type === 'doughnut' } },
        scales: type === 'doughnut' ? {} : { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
    setter(chart);
  }

  async function ensureWorkers() {
    if (!workersCache.length) {
      const { workers } = await Api.workers();
      workersCache = workers;
    }
    return workersCache;
  }

  async function loadComplaints() {
    const el = document.getElementById('gov-complaints-list');
    el.innerHTML = '<p>Loading…</p>';
    const status = document.getElementById('gov-filter-status').value;
    const category = document.getElementById('gov-filter-category').value;
    const params = [];
    if (status) params.push(`status=${status}`);
    if (category) params.push(`category=${category}`);
    try {
      const [{ complaints }, workers] = await Promise.all([
        Api.listComplaints(params.length ? `?${params.join('&')}` : ''),
        ensureWorkers()
      ]);
      if (!complaints.length) { el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No complaints match these filters.</p></div>'; return; }
      el.innerHTML = complaints.map((c) => govComplaintCard(c, workers)).join('');
      complaints.forEach((c) => {
        const assignBtn = document.getElementById(`assign-btn-${c.id}`);
        if (assignBtn) assignBtn.addEventListener('click', () => assignComplaint(c.id));
        const deadlineBtn = document.getElementById(`deadlines-btn-${c.id}`);
        if (deadlineBtn) deadlineBtn.addEventListener('click', () => setLegacyDeadlines(c));
      });
    } catch (err) {
      el.innerHTML = alertHtml(err.message);
    }
  }

  function govComplaintCard(c, workers) {
    const canAssign = c.status === 'pending' || c.status === 'assigned';
    const workerOptions = workers.map((w) =>
      `<option value="${escapeHtml(w.id)}" ${c.assignedWorkerId === w.id ? 'selected' : ''}>${escapeHtml(w.name)} — ${escapeHtml(w.region || '')}</option>`
    ).join('');
    const assignBlock = canAssign ? `
      <div style="margin-top:12px;padding:14px;border:1px solid #cbdcf5;border-radius:10px;background:#f4f8ff">
        <strong>🏛️ Assign worker and choose start deadline</strong>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-top:10px">
          <label style="display:block;flex:1;min-width:180px;font-size:13px;font-weight:600">
            Worker
            <select id="worker-select-${c.id}" style="margin-top:5px;width:100%">
              ${workerOptions || '<option disabled selected>No workers registered yet</option>'}
            </select>
          </label>
          <div class="deadline-fields">
            <label class="deadline-date">Start work before (date)
              <input type="date" id="start-date-${c.id}" min="${localDateTimeInputMin().slice(0,10)}" required />
            </label>
            <label>Hour
              <select id="start-hour-${c.id}" aria-label="Deadline hour">
                ${Array.from({length:12}, (_,i) => i + 1).map(n => `<option value="${n}">${String(n).padStart(2,'0')}</option>`).join('')}
              </select>
            </label>
            <label>Minute
              <select id="start-minute-${c.id}" aria-label="Deadline minute">
                ${Array.from({length:60}, (_,i) => i).map(n => `<option value="${n}">${String(n).padStart(2,'0')}</option>`).join('')}
              </select>
            </label>
            <label>AM / PM
              <select id="start-period-${c.id}" aria-label="Deadline AM or PM">
                <option value="AM">AM</option><option value="PM">PM</option>
              </select>
            </label>
          </div>
          <label>Submit resolution before (local date and time)<input type="datetime-local" id="completion-date-${c.id}" required></label>
          <button class="btn btn-primary btn-sm" id="assign-btn-${c.id}" ${workers.length ? '' : 'disabled'}>
            ${c.status === 'assigned' ? 'Update assignment & deadline' : 'Assign with deadline'}
          </button>
        </div>
        <p class="field-hint" style="margin:8px 0 0">The worker will see this deadline in My tasks. If work has not started by then, you will receive a 🔔 Worker Delays alert.</p>
      </div>` : '';
    const photos = [];
    if (c.photoBeforeUrl) photos.push(`<img src="${c.photoBeforeUrl}" alt="Before">`);
    if (c.photoAfterUrl) photos.push(`<img src="${c.photoAfterUrl}" alt="After">`);
    return `
      <div class="complaint-card">
        <div class="complaint-top">
          ${scoreBadgeHtml(c.priorityScore, c.priorityLevel)}
          <div style="flex:1">
            <div class="complaint-title">${escapeHtml(c.title)}</div>
            <div class="complaint-meta">
              ${statusChip(c.status)} ${priorityChip(c.priorityLevel)} ${weatherChip(c.weatherRisk)} ${recurringChip(c.recurringRisk, c.recurringCount)}
              <span>${categoryLabel(c.category)}</span>
              <span>Reported by ${escapeHtml(c.reporterName)} · ${timeAgo(c.createdAt)}</span>
              <span>👍 ${c.confirmationsCount}</span>
              ${c.nearSensitiveLocation ? `<span>🏫 Near ${escapeHtml(c.nearestSensitiveLocation?.name || '')}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="complaint-desc">${escapeHtml(c.description)}</div>
        ${c.recurringRisk && c.recurringRisk !== 'Low' ? `
  <div style="
    margin-top:10px;
    padding:10px 12px;
    border-radius:8px;
    background:#fff3cd;
    border-left:4px solid #ff9800;
  ">
    🔁 <b>Recurring Issue Risk: ${escapeHtml(c.recurringRisk)}</b><br>
    <span style="font-size:13px;">
      ${c.recurringCount || 0} similar previous issue(s) detected near this location.
    </span>
  </div>
` : ''}

${c.priorityReasons?.length ? `
  <div style="
    margin-top:10px;
    padding:10px 12px;
    border-radius:8px;
    background:#eef5ff;
  ">
    <b>🤖 Why AI gave this priority</b>
    <div style="margin-top:6px;font-size:13px;">
      ${c.priorityReasons.map(r =>
        `• ${escapeHtml(r.detail)} (+${r.points})`
      ).join('<br>')}
    </div>
  </div>
` : ''}
        ${c.address ? `<p class="field-hint">📍 ${escapeHtml(c.address)} (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})</p>` : ''}
        ${photos.length ? `<div class="complaint-photos">${photos.join('')}</div>` : ''}
        ${c.assignedWorkerName ? `<p class="field-hint">Assigned to <b>${escapeHtml(c.assignedWorkerName)}</b> · ${escapeHtml(c.assignedRegion || '')}</p>` : ''}
        ${c.status === 'assigned' && c.startDeadlineAt ? `<p class="field-hint">⏱ Start deadline: ${escapeHtml(new Date(c.startDeadlineAt).toLocaleString(I18n.locale(), {hour12:true}))}</p>` : ''}
        ${['assigned', 'in_progress'].includes(c.status) ? `<p class="field-hint">Completion deadline: ${escapeHtml(c.completionDeadlineAt ? new Date(c.completionDeadlineAt).toLocaleString() : 'Not set — no completion delay alert until the assigning official sets it.')}</p>` : ''}
        ${c.status === 'assigned' && !c.startDeadlineAt ? '<p class="field-hint">Legacy assignment: no start deadline is set, so no start-delay alert can be issued. Set explicit deadlines below.</p>' : ''}
        ${['assigned', 'in_progress'].includes(c.status) && !c.completionDeadlineAt && c.assignedById === Session.user.id ? `<div><label>Start deadline (only if missing and unstarted)<input type="datetime-local" id="legacy-start-${c.id}"></label><label>Completion deadline<input type="datetime-local" id="legacy-completion-${c.id}"></label><button class="btn btn-outline btn-sm" id="deadlines-btn-${c.id}">Set missing deadlines</button></div>` : ''}
        ${!c.assignedById && c.status === 'assigned' ? '<p class="field-hint">Assigning official is unknown. Reassign this unstarted task with explicit deadlines to enable private alerts.</p>' : ''}
        ${assignBlock}
      </div>`;
  }

  function localDateTimeInputMin() {
    const date = new Date(Date.now() + 60 * 1000);
    const offset = date.getTimezoneOffset() * 60 * 1000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  async function assignComplaint(id) {
    const select = document.getElementById(`worker-select-${id}`);
    const dateInput = document.getElementById(`start-date-${id}`);
    const hourInput = document.getElementById(`start-hour-${id}`);
    const minuteInput = document.getElementById(`start-minute-${id}`);
    const periodInput = document.getElementById(`start-period-${id}`);
    if (!select || !select.value) { toast('Choose a worker.', 'error'); return; }
    if (!dateInput || !dateInput.value) {
      toast('Choose a deadline date.', 'error');
      if (dateInput) dateInput.focus();
      return;
    }
    // Time choice is explicit 12-hour AM/PM and converted in local timezone.
    const deadlineISO = DeadlineTime.toISO(
      dateInput.value, hourInput.value, minuteInput.value, periodInput.value
    );
    if (!deadlineISO) {
      toast('Choose a valid future date and time.', 'error');
      dateInput.focus();
      return;
    }
    const completionValue = document.getElementById(`completion-date-${id}`).value;
    const completion = completionValue ? new Date(completionValue) : null;
    if (!completion || !Number.isFinite(completion.getTime()) || completion <= new Date(deadlineISO)) {
      toast('Choose a completion deadline after the start deadline.', 'error'); return;
    }
    const button = document.getElementById(`assign-btn-${id}`);
    try {
      if (button) button.disabled = true;
      await Api.assignComplaint(id, {
        workerId: select.value,
        startDeadlineAt: deadlineISO,
        completionDeadlineAt: completion.toISOString()
      });
      toast('Task assigned with a start deadline. The worker can now see it.', 'success');
      await loadComplaints();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  }

  async function setLegacyDeadlines(c) {
    const iso = (id) => {
      const value = document.getElementById(id).value;
      return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
    };
    try {
      await Api.setComplaintDeadlines(c.id, {
        startDeadlineAt: iso(`legacy-start-${c.id}`),
        completionDeadlineAt: iso(`legacy-completion-${c.id}`)
      });
      toast('Deadlines saved.', 'success');
      await loadComplaints();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadGovMap() {
    if (typeof L === 'undefined') { Main.mapUnavailable('gov-heatmap'); return; }
    if (!govMap) {
      govMap = L.map('gov-heatmap').setView([13.0827, 80.2707], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(govMap);
    }
    govMap.eachLayer((l) => { if (l instanceof L.CircleMarker) govMap.removeLayer(l); });
    try {
      const { points, sensitiveLocations } = await Api.heatmap();
      points.forEach((p) => {
        L.circleMarker([p.lat, p.lng], {
          radius: 6 + p.weight, fillColor: STATUS_MAP_COLOR[p.status] || '#5B6672', color: '#fff', weight: 1.5, fillOpacity: 0.75
        }).bindPopup(`<b>${escapeHtml(p.title)}</b><br>${STATUS_LABELS[p.status]} · Priority ${p.priorityScore} (${p.priorityLevel})`).addTo(govMap);
      });
      sensitiveLocations.forEach((s) => {
        L.circleMarker([s.lat, s.lng], { radius: 5, color: '#E8A33D', fillColor: '#E8A33D', fillOpacity: 0.9 })
          .bindPopup(`${s.type === 'school' ? '🏫' : '🏥'} ${escapeHtml(s.name)}`).addTo(govMap);
      });
      setTimeout(() => govMap.invalidateSize(), 50);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function loadGrievances() {
    const el = document.getElementById('gov-grievances-list');
    el.innerHTML = '<p>Loading…</p>';
    try {
      const { grievances } = await Api.govGrievances();
      if (!grievances.length) { el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No grievances submitted yet.</p></div>'; return; }
      el.innerHTML = grievances.map((g) => `
        <div class="card">
          <div class="complaint-top">
            <div style="flex:1">
              <div class="complaint-title">${escapeHtml(g.subject)}</div>
              <div class="complaint-meta">
                <span class="chip chip-${g.status === 'resolved' ? 'verified' : g.status === 'in_review' ? 'assigned' : 'pending'}">${g.status.replace('_', ' ')}</span>
                <span>From ${escapeHtml(g.workerName)} · ${escapeHtml(g.region || '')}</span>
                <span>${timeAgo(g.createdAt)}</span>
              </div>
            </div>
          </div>
          <div class="complaint-desc">${escapeHtml(g.description)}</div>
          ${g.response ? `<p class="field-hint"><b>Official response:</b> ${escapeHtml(g.response)}</p>` : ''}
          ${g.status !== 'resolved' ? `
            <div class="form-group" style="margin-top:10px">
              <textarea id="resp-${g.id}" placeholder="Write a response…"></textarea>
            </div>
            <div class="complaint-actions">
              <button class="btn btn-outline btn-sm" data-review="${g.id}">Mark in review</button>
              <button class="btn btn-primary btn-sm" data-resolve="${g.id}">Respond &amp; resolve</button>
            </div>` : ''}
        </div>`).join('');
      el.querySelectorAll('[data-resolve]').forEach((btn) => btn.addEventListener('click', () => respondGrievance(btn.dataset.resolve, 'resolved')));
      el.querySelectorAll('[data-review]').forEach((btn) => btn.addEventListener('click', () => respondGrievance(btn.dataset.review, 'in_review')));
    } catch (err) {
      el.innerHTML = alertHtml(err.message);
    }
  }

  async function respondGrievance(id, status) {
    const textarea = document.getElementById(`resp-${id}`);
    try {
      await Api.respondGrievance(id, { response: textarea ? textarea.value.trim() : '', status });
      toast('Grievance updated.', 'success');
      loadGrievances();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadDirectory() {
    const wEl = document.getElementById('gov-worker-directory');
    const cEl = document.getElementById('gov-citizen-directory');
    wEl.innerHTML = cEl.innerHTML = '<p>Loading…</p>';
    try {
      const [{ users: workers }, { users: citizens }] = await Promise.all([Api.govUsers('worker'), Api.govUsers('public')]);
      wEl.innerHTML = workers.length ? tableHtml(workers, ['name', 'region', 'points', 'completedTasks'], ['Name', 'Region', 'Points', 'Tasks done']) : emptyMini('No field workers registered yet.');
      cEl.innerHTML = citizens.length ? tableHtml(citizens, ['name', 'points', 'title'], ['Name', 'Points', 'Title']) : emptyMini('No citizens registered yet.');
      workersCache = workers;
    } catch (err) {
      wEl.innerHTML = cEl.innerHTML = alertHtml(err.message);
    }
  }

  function emptyMini(msg) { return `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`; }

  function tableHtml(rows, fields, labels) {
    return `<table><thead><tr>${labels.map((l) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => `<tr>${fields.map((f) => `<td>${escapeHtml(String(r[f] ?? ''))}</td>`).join('')}</tr>`).join('')}
    </tbody></table>`;
  }

  return { init, switchView, loadOverview };
})();
