const test = require('node:test');
const assert = require('node:assert/strict');
const { resetStartDeadline, scanOverdueAssignments, startSlaMinutes, parseOfficerStartDeadline } = require('../utils/workerAlerts');

function fixture(priorityLevel='Critical') {
  return {
    users: [{ id: 'officerA', role: 'government' }, { id: 'officerB', role: 'government' }],
    complaints: [{
      id: 'case1', title: 'Blocked road', priorityLevel, status: 'assigned',
      assignedWorkerId: 'workerA', assignedWorkerName: 'Worker A', assignedById: 'officerA'
    }],
    notifications: []
  };
}

test('SLA defaults vary by priority', () => {
  if (process.env.WORKER_START_SLA_MINUTES) return; // configurable override
  assert.ok(startSlaMinutes('Critical') < startSlaMinutes('High'));
  assert.ok(startSlaMinutes('High') < startSlaMinutes('Low'));
});

test('no alert before deadline, one after deadline, only original officer receives it', () => {
  const db = fixture();
  resetStartDeadline(db.complaints[0], new Date('2026-10-18T00:00:00Z'));
  const deadline = Date.parse(db.complaints[0].startDeadlineAt);
  assert.equal(scanOverdueAssignments(db, new Date(deadline - 1)), 0);
  assert.equal(scanOverdueAssignments(db, new Date(deadline)), 1);
  assert.equal(scanOverdueAssignments(db, new Date(deadline + 60000)), 0);
  assert.equal(db.notifications.length, 1);
  assert.equal(db.notifications[0].recipientId, 'officerA');
  assert.equal(db.notifications[0].type, 'worker_not_started');
});

test('started work does not trigger delayed-start alert', () => {
  const db = fixture();
  resetStartDeadline(db.complaints[0], new Date('2026-10-18T00:00:00Z'));
  db.complaints[0].status = 'in_progress';
  assert.equal(scanOverdueAssignments(db, new Date('2026-10-20T00:00:00Z')), 0);
});

test('reassignment creates a fresh independent alert cycle', () => {
  const db = fixture();
  resetStartDeadline(db.complaints[0], new Date('2026-10-18T00:00:00Z'));
  scanOverdueAssignments(db, new Date('2026-10-20T00:00:00Z'));
  const first = db.complaints[0].assignmentId;
  db.complaints[0].assignedWorkerId = 'workerB';
  db.complaints[0].assignedById = 'officerB';
  resetStartDeadline(db.complaints[0], new Date('2026-10-21T00:00:00Z'));
  assert.notEqual(db.complaints[0].assignmentId, first);
  scanOverdueAssignments(db, new Date('2026-10-23T00:00:00Z'));
  assert.equal(db.notifications.length, 2);
  assert.equal(db.notifications[1].recipientId, 'officerB');
});

test('government-chosen local deadline is stored as the same UTC instant', () => {
  const assignedAt = new Date('2026-10-18T00:00:00Z');
  const chosen = '2026-10-18T10:30:00+05:30';
  assert.equal(parseOfficerStartDeadline(chosen, assignedAt), '2026-10-18T05:00:00.000Z');
  const db = fixture('Low');
  resetStartDeadline(db.complaints[0], assignedAt, chosen);
  assert.equal(db.complaints[0].startDeadlineAt, '2026-10-18T05:00:00.000Z');
  assert.equal(scanOverdueAssignments(db, new Date('2026-10-18T04:59:59Z')), 0);
  assert.equal(scanOverdueAssignments(db, new Date('2026-10-18T05:00:00Z')), 1);
  assert.equal(db.notifications[0].recipientId, 'officerA');
});

test('government must choose a valid future deadline with timezone', () => {
  const now = new Date('2026-10-18T04:00:00Z');
  for (const invalid of [null, undefined, '', '2026-10-18T10:30', 'not-a-date', '2026-10-18T03:00:00Z', '2026-10-18T04:00:00Z']) {
    assert.equal(parseOfficerStartDeadline(invalid, now), null, String(invalid));
    const db = fixture();
    assert.throws(() => resetStartDeadline(db.complaints[0], now, invalid), /valid future/);
    assert.equal(db.complaints[0].assignedAt, undefined);
  }
});

 test('completion alert occurs at deadline, independently of start alert, and persists deduplication', () => {
  const db = fixture(); const c = db.complaints[0];
  resetStartDeadline(c, new Date('2026-10-18T00:00:00Z'));
  c.completionDeadlineAt = '2026-10-19T00:00:00Z';
  scanOverdueAssignments(db, new Date('2026-10-18T12:00:00Z'));
  c.status = 'in_progress'; c.startedAt = '2026-10-18T13:00:00Z';
  assert.equal(scanOverdueAssignments(db, new Date('2026-10-18T23:59:59Z')), 0);
  assert.equal(scanOverdueAssignments(db, new Date(c.completionDeadlineAt)), 1);
  const n = db.notifications[1];
  assert.equal(n.type, 'worker_resolution_overdue');
  assert.equal(n.recipientId, 'officerA'); assert.equal(n.workerName, 'Worker A');
  assert.equal(n.complaintTitle, 'Blocked road'); assert.equal(n.startedAt, c.startedAt);
  assert.equal(n.deadlineAt, c.completionDeadlineAt);
  const restored = JSON.parse(JSON.stringify(db));
  restored.notifications[1].readAt = '2026-10-19T00:01:00Z';
  restored.complaints[0].completionOverdueNotifiedAt = null;
  assert.equal(scanOverdueAssignments(restored, new Date('2026-10-20T00:00:00Z')), 0);
});

test('resolved and verified complaints never trigger completion alerts', () => {
  for (const status of ['resolved', 'verified', 'pending']) {
    const db = fixture(); const c = db.complaints[0];
    resetStartDeadline(c, new Date('2026-10-18T00:00:00Z'));
    c.status = status; c.completionDeadlineAt = '2026-10-19T00:00:00Z';
    assert.equal(scanOverdueAssignments(db, new Date('2026-10-20T00:00:00Z')), 0);
  }
});

test('legacy missing or invalid deadlines and unknown assigning officials are never guessed', () => {
  for (const status of ['assigned', 'in_progress']) {
    for (const deadline of [undefined, null, '', 'bad date']) {
      const db = fixture(); const c = db.complaints[0];
      c.status = status; c.assignmentId = 'legacy';
      c.startDeadlineAt = deadline; c.completionDeadlineAt = deadline;
      assert.equal(scanOverdueAssignments(db, new Date('2026-10-20T00:00:00Z')), 0);
    }
    for (const owner of [undefined, 'unknown', 'workerA']) {
      const db = fixture(); const c = db.complaints[0];
      resetStartDeadline(c, new Date('2026-10-18T00:00:00Z'));
      c.status = status; c.completionDeadlineAt = c.startDeadlineAt; c.assignedById = owner;
      assert.equal(scanOverdueAssignments(db, new Date('2026-10-20T00:00:00Z')), 0);
    }
  }
});

test('reassignment clears both delay markers and requires a new completion deadline', () => {
  const db = fixture(); const c = db.complaints[0];
  c.completionDeadlineAt = '2026-10-19T00:00:00Z'; c.completionOverdueNotifiedAt = 'old';
  resetStartDeadline(c, new Date('2026-10-18T00:00:00Z'));
  assert.equal(c.completionDeadlineAt, null); assert.equal(c.completionOverdueNotifiedAt, null);
});
