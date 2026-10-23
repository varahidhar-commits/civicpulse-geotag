// ==========================================================================
// CivicPulse - Worker portal
// ==========================================================================
const WorkerPortal = (() => {
  let activeResolveId = null;

  function init() {
    document.querySelectorAll('#view-worker [data-wv]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.wv));
    });
    document.getElementById('btn-refresh-tasks').addEventListener('click', loadTasks);
    document.getElementById('grievance-form').addEventListener('submit', onSubmitGrievance);
    wireFileDrop('resolve-photo-drop', 'resolve-photo');
    document.getElementById('resolve-close').addEventListener('click', () => hideModal('resolve-modal'));
    document.getElementById('resolve-submit-btn').addEventListener('click', onSubmitResolve);
    // Update the worker's visible deadline countdown every 30 seconds.
    setInterval(refreshStartDeadlines, 30 * 1000);
  }

  function switchView(name) {
    document.querySelectorAll('#view-worker [data-wv]').forEach((b) => b.classList.toggle('active', b.dataset.wv === name));
    ['tasks', 'benefits', 'grievance'].forEach((v) => {
      document.getElementById(`wv-${v}`).classList.toggle('hidden', v !== name);
    });
    if (name === 'tasks') loadTasks();
    if (name === 'benefits') loadBenefits();
    if (name === 'grievance') loadMyGrievances();
  }

  function welcomeText() {
    const u = Session.user;
    if (u) document.getElementById('worker-welcome').textContent = `My tasks — ${u.name.split('(')[0].trim()}`;
  }

  async function loadTasks() {
    welcomeText();
    const el = document.getElementById('worker-tasks-list');
    el.innerHTML = '<p>Loading…</p>';
    try {
      const { tasks } = await Api.workerTasks();
      if (!tasks.length) { el.innerHTML = '<div class="empty-state"><div class="icon">🧰</div><p>No tasks assigned yet. Check back soon.</p></div>'; return; }
      el.innerHTML = tasks.map(taskCard).join('');
      refreshStartDeadlines();
      tasks.forEach((t) => {
        const startBtn = document.getElementById(`start-btn-${t.id}`);
        if (startBtn) startBtn.addEventListener('click', () => startTask(t.id));
        const resolveBtn = document.getElementById(`resolve-btn-${t.id}`);
        if (resolveBtn) resolveBtn.addEventListener('click', () => openResolveModal(t.id));
      });
    } catch (err) {
      el.innerHTML = alertHtml(err.message);
    }
  }

  function refreshStartDeadlines() {
    document.querySelectorAll('#worker-tasks-list [data-start-deadline]').forEach((el) => {
      const deadline = Date.parse(el.dataset.startDeadline);
      if (!Number.isFinite(deadline)) {
        el.textContent = 'Deadline unavailable';
        return;
      }
      const remaining = deadline - Date.now();
      const minutes = Math.ceil(Math.abs(remaining) / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const mins = minutes % 60;
      const parts = [days ? `${days}d` : '', hours ? `${hours}h` : '', mins || (!days && !hours) ? `${mins}m` : ''].filter(Boolean).join(' ');
      el.textContent = remaining <= 0 ? `Overdue by ${parts}` : `Time remaining: ${parts}`;
      el.style.color = remaining <= 0 ? '#b42318' : '#116b48';
      el.style.fontWeight = '700';
    });
  }

  function startDeadlineHtml(t) {
    if (t.status !== 'assigned') return '';
    if (!t.startDeadlineAt) {
      return '<div class="field-hint" style="margin-top:12px">⏱ A start deadline has not been set for this assignment.</div>';
    }
    const deadline = new Date(t.startDeadlineAt);
    if (Number.isNaN(deadline.getTime())) return '';
    return `
      <div style="margin-top:12px;padding:12px 14px;border-radius:10px;background:#eef5ff;border-left:4px solid #2c63c7">
        <strong>⏱ Start work deadline</strong><br>
        <span>${escapeHtml(deadline.toLocaleString(I18n.locale(), { dateStyle: 'medium', timeStyle: 'short', hour12: true }))}</span><br>
        <span data-start-deadline="${escapeHtml(t.startDeadlineAt)}" aria-live="polite"></span><br>
        <small>This is the deadline to START the task, not to complete it. Press “Start work” before the deadline.</small>
      </div>`;
  }

  function taskCard(t) {
    const photos = [];
    if (t.photoBeforeUrl) photos.push(`<img src="${t.photoBeforeUrl}" alt="Before">`);
    if (t.photoAfterUrl) photos.push(`<img src="${t.photoAfterUrl}" alt="After">`);
    let actions = '';
    if (t.status === 'assigned') actions = `<button class="btn btn-primary btn-sm" id="start-btn-${t.id}">Start work</button>`;
    else if (t.status === 'in_progress') actions = `<button class="btn btn-amber btn-sm" id="resolve-btn-${t.id}">Submit after-photo &amp; resolve</button>`;
    else if (t.status === 'resolved') actions = `<p class="field-hint">Awaiting citizen verification…</p>`;
    else if (t.status === 'verified') actions = `<p class="field-hint">✅ Verified by citizen. Points awarded.</p>`;
    return `
      <div class="complaint-card">
        <div class="complaint-top">
          ${scoreBadgeHtml(t.priorityScore, t.priorityLevel)}
          <div style="flex:1">
            <div class="complaint-title">${escapeHtml(t.title)}</div>
            <div class="complaint-meta">
              ${statusChip(t.status)} ${priorityChip(t.priorityLevel)} ${weatherChip(t.weatherRisk)} ${recurringChip(t.recurringRisk, t.recurringCount)}
              <span>${categoryLabel(t.category)}</span>
              <span>${timeAgo(t.createdAt)}</span>
              ${t.nearSensitiveLocation ? `<span>🏫 Near ${escapeHtml(t.nearestSensitiveLocation?.name || '')} (+bonus points)</span>` : ''}
            </div>
          </div>
        </div>
        <div class="complaint-desc">${escapeHtml(t.description)}</div>
        ${t.address ? `<p class="field-hint">📍 ${escapeHtml(t.address)}</p>` : ''}
        ${photos.length ? `<div class="complaint-photos">${photos.join('')}</div>` : ''}
        ${startDeadlineHtml(t)}
        ${['assigned', 'in_progress'].includes(t.status) ? `<p class="field-hint">Submit resolution before: ${escapeHtml(t.completionDeadlineAt ? new Date(t.completionDeadlineAt).toLocaleString(I18n.locale(), {hour12:true}) : 'Not set — contact the assigning official.')}</p>` : ''}
        <div class="complaint-actions">${actions}</div>
      </div>`;
  }

  async function startTask(id) {
    try {
      await Api.startComplaint(id);
      toast('Task started.', 'success');
      loadTasks();
    } catch (err) { toast(err.message, 'error'); }
  }

  function openResolveModal(id) {
    activeResolveId = id;
    document.getElementById('resolve-alert-slot').innerHTML = '';
    document.getElementById('resolve-photo-drop').textContent = 'Click to add after-photo';
    document.getElementById('resolve-photo-drop').classList.remove('has-file');
    document.getElementById('resolve-photo').value = '';
    showModal('resolve-modal');
  }

  async function onSubmitResolve() {
    const slot = document.getElementById('resolve-alert-slot');
    const input = document.getElementById('resolve-photo');
    if (!input.files[0]) { slot.innerHTML = alertHtml('An after-photo is required.'); return; }
    const fd = new FormData();
    fd.append('photoAfter', input.files[0]);
    try {
      const res = await Api.resolveComplaint(activeResolveId, fd);
      hideModal('resolve-modal');
      toast(`Marked resolved. AI confidence: ${Math.round(res.aiVerification.confidence * 100)}%.`, 'success');
      loadTasks();
    } catch (err) {
      slot.innerHTML = alertHtml(err.message);
    }
  }

  async function loadBenefits() {
    const el = document.getElementById('worker-summary-card');
    try {
      const { profile, taskCounts } = await Api.workerSummary();
      el.innerHTML = `
        <div class="seal-badge" style="font-size:1.1rem;margin-bottom:14px"><span class="seal-icon">🎖️</span>${escapeHtml(profile.title)}</div>
        <div class="kpi-grid" style="grid-template-columns:repeat(2,1fr)">
          <div class="kpi"><div class="kpi-label">Points</div><div class="kpi-value">${profile.points}</div></div>
          <div class="kpi"><div class="kpi-label">Tasks completed</div><div class="kpi-value">${profile.completedTasks}</div></div>
        </div>
        <p class="field-hint" style="margin-top:12px">${profile.nextTitle ? `${profile.pointsToNextTitle} pts to reach "${profile.nextTitle}"` : 'You\'ve reached the top title!'}</p>
        <table style="margin-top:10px">
          <tr><td>Assigned</td><td>${taskCounts.assigned}</td></tr>
          <tr><td>In progress</td><td>${taskCounts.inProgress}</td></tr>
          <tr><td>Awaiting verification</td><td>${taskCounts.resolved}</td></tr>
          <tr><td>Verified complete</td><td>${taskCounts.verified}</td></tr>
        </table>`;
    } catch (err) {
      el.innerHTML = alertHtml(err.message);
    }
  }

  async function onSubmitGrievance(e) {
    e.preventDefault();
    const slot = document.getElementById('grievance-alert-slot');
    slot.innerHTML = '';
    try {
      await Api.submitGrievance({
        subject: document.getElementById('gr-subject').value.trim(),
        description: document.getElementById('gr-desc').value.trim()
      });
      slot.innerHTML = alertHtml('Submitted to higher officials.', 'success');
      toast('Grievance submitted.', 'success');
      document.getElementById('grievance-form').reset();
      loadMyGrievances();
    } catch (err) {
      slot.innerHTML = alertHtml(err.message);
    }
  }

  async function loadMyGrievances() {
    const el = document.getElementById('my-grievances-list');
    el.innerHTML = '<p>Loading…</p>';
    try {
      const { grievances } = await Api.myGrievances();
      if (!grievances.length) { el.innerHTML = '<div class="empty-state"><p>No grievances submitted yet.</p></div>'; return; }
      el.innerHTML = grievances.map((g) => `
        <div class="complaint-card">
          <div class="complaint-top">
            <div style="flex:1">
              <div class="complaint-title">${escapeHtml(g.subject)}</div>
              <div class="complaint-meta">
                <span class="chip chip-${g.status === 'resolved' ? 'verified' : g.status === 'in_review' ? 'assigned' : 'pending'}">${g.status.replace('_', ' ')}</span>
                <span>${timeAgo(g.createdAt)}</span>
              </div>
            </div>
          </div>
          <div class="complaint-desc">${escapeHtml(g.description)}</div>
          ${g.response ? `<p class="field-hint"><b>Official response:</b> ${escapeHtml(g.response)}</p>` : '<p class="field-hint">Awaiting response…</p>'}
        </div>`).join('');
    } catch (err) {
      el.innerHTML = alertHtml(err.message);
    }
  }

  return { init, switchView };
})();
