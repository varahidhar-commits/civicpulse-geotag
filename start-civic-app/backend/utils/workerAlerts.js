// Automatic accountability alerts when a dispatched worker has not started work.
// One notification per assignment, addressed ONLY to the official who assigned it.
const { randomUUID } = require('crypto');
const { load, save } = require('../data/store');

const START_SLA_MINUTES = Object.freeze({
  Critical: 30,
  High: 120,
  Medium: 360,
  Low: 1440
});

function startSlaMinutes(priorityLevel) {
  // For demos, set WORKER_START_SLA_MINUTES=1. Defaults are priority-based.
  const value = process.env.WORKER_START_SLA_MINUTES;
  if (value !== undefined && /^\d+$/.test(value)) {
    const minutes = Number(value);
    if (minutes >= 1 && minutes <= 10080) return minutes;
  }
  return START_SLA_MINUTES[priorityLevel] || START_SLA_MINUTES.Low;
}

// Require an actual timezone on official-selected deadlines. A local HTML
// datetime-local field has no timezone: the browser converts it to ISO first.
function parseOfficerStartDeadline(value, now = new Date()) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  const current = new Date(now).getTime();
  if (!Number.isFinite(ms) || !Number.isFinite(current) || ms <= current) return null;
  return new Date(ms).toISOString();
}

function resetStartDeadline(complaint, now = new Date(), officerDeadline = undefined) {
  const date = new Date(now);
  // Two-argument calls are for legacy automatic defaults only. A third
  // argument indicates an officer-entered deadline and must never fall back.
  const deadline = arguments.length < 3
    ? new Date(date.getTime() + startSlaMinutes(complaint.priorityLevel) * 60 * 1000).toISOString()
    : parseOfficerStartDeadline(officerDeadline, date);

  if (!deadline) throw new Error('A valid future start deadline with a timezone is required.');
  complaint.assignmentId = randomUUID();
  complaint.assignedAt = date.toISOString();
  complaint.startDeadlineAt = deadline;
  complaint.startedAt = null;
  complaint.overdueNotifiedAt = null;
  complaint.completionDeadlineAt = null;
  complaint.completionOverdueNotifiedAt = null;
}

function scanOverdueAssignments(db, now = new Date()) {
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new Error('Invalid time for overdue scan');
  let created = 0;

  for (const complaint of db.complaints || []) {
    const completion = complaint.status === 'in_progress';
    if ((!completion && (complaint.status !== 'assigned' || complaint.startedAt)) || !complaint.assignedWorkerId ||
        !complaint.assignedById || !complaint.assignmentId) continue;
    const type = completion ? 'worker_resolution_overdue' : 'worker_not_started';
    const marker = completion ? 'completionOverdueNotifiedAt' : 'overdueNotifiedAt';
    const deadlineAt = completion ? complaint.completionDeadlineAt : complaint.startDeadlineAt;

    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline) || deadline > currentTime) continue;

    // An idempotency key guards against duplicate messages across repeated scans.
    const alreadySent = db.notifications.some((n) =>
      n.type === type &&
      n.complaintId === complaint.id &&
      n.assignmentId === complaint.assignmentId
    );
    if (alreadySent || complaint[marker]) continue;

    // No unrelated official should receive another officer's assignment alerts.
    const official = (db.users || []).find((u) =>
      u.id === complaint.assignedById && u.role === 'government'
    );
    if (!official) continue;

    const issuedAt = new Date(currentTime).toISOString();
    db.notifications.push({
      id: randomUUID(),
      type,
      recipientId: official.id,
      complaintId: complaint.id,
      assignmentId: complaint.assignmentId,
      complaintTitle: complaint.title,
      workerId: complaint.assignedWorkerId,
      workerName: complaint.assignedWorkerName || 'Assigned worker',
      assignedAt: complaint.assignedAt,
      deadlineAt,
      startDeadlineAt: complaint.startDeadlineAt || null,
      completionDeadlineAt: complaint.completionDeadlineAt || null,
      startedAt: complaint.startedAt || null,
      address: complaint.address || '',
      region: complaint.assignedRegion || '',
      priorityLevel: complaint.priorityLevel,
      createdAt: issuedAt,
      readAt: null
    });
    complaint[marker] = issuedAt;
    created += 1;
  }

  return created;
}

function checkOverdueAssignments() {
  const db = load();
  const created = scanOverdueAssignments(db);
  if (created > 0) save(db);
  return created;
}

module.exports = {
  START_SLA_MINUTES,
  startSlaMinutes,
  resetStartDeadline,
  parseOfficerStartDeadline,
  scanOverdueAssignments,
  checkOverdueAssignments
};
