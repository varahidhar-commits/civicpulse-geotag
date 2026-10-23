const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const store = require('../data/store');
const { JWT_SECRET } = require('../middleware/auth');
let db;
store.load = () => db;
store.save = value => { db = JSON.parse(JSON.stringify(value)); };
const app = express(); app.use(express.json());
app.use('/complaints', require('../routes/complaints'));
app.use('/government', require('../routes/government'));
const future = hours => new Date(Date.now() + hours * 3600000).toISOString();

test('assignment, legacy setup and notification APIs enforce deadlines and privacy', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, role='government', id='officerA', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET', headers: {
        'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${jwt.sign({id, role}, JWT_SECRET)}` } : {})
      }, body: body ? JSON.stringify(body) : undefined
    });
    return {status:response.status, data:await response.json()};
  };
  try {
    db = {users:[{id:'officerA',role:'government'},{id:'officerB',role:'government'},{id:'workerA',role:'worker',name:'Alice'}], complaints:[{id:'c',title:'Road',status:'pending'}],notifications:[]};
    const assignment = {workerId:'workerA',startDeadlineAt:future(1),completionDeadlineAt:future(2)};
    assert.equal((await request('/complaints/c/assign','worker','workerA',assignment)).status,403);
    assert.equal((await request('/complaints/c/assign','government','officerA',{...assignment,completionDeadlineAt:future(0.5)})).status,400);
    assert.equal(db.complaints[0].status,'pending');
    assert.equal((await request('/complaints/c/assign','government','officerA',assignment)).status,200);
    assert.equal(db.complaints[0].completionDeadlineAt,assignment.completionDeadlineAt);
    assert.equal((await request('/complaints/c/start','worker','workerA',{})).status,200);
    const started = db.complaints[0].startedAt;
    delete db.complaints[0].completionDeadlineAt; delete db.complaints[0].assignmentId;
    assert.equal((await request('/complaints/c/deadlines','government','officerB',assignment)).status,403);
    assert.equal((await request('/complaints/c/deadlines','worker','workerA',assignment)).status,403);
    assert.equal((await request('/complaints/c/deadlines','government','officerA',assignment)).status,200);
    assert.equal(db.complaints[0].startedAt,started); assert.equal(db.complaints[0].status,'in_progress');
    assert.ok(db.complaints[0].assignmentId);
    assert.equal((await request('/complaints/c/deadlines','government','officerA',assignment)).status,409);
    db.complaints[0].completionDeadlineAt = '2020-01-01T00:00:00Z';
    assert.equal((await request('/government/notifications',null)).status,401);
    assert.equal((await request('/government/notifications','worker','workerA')).status,403);
    const own = await request('/government/notifications');
    assert.equal(own.data.notifications.length,1); assert.equal(own.data.notifications[0].workerName,'Alice');
    assert.equal((await request('/government/notifications','government','officerB')).data.notifications.length,0);
    const alertId = own.data.notifications[0].id;
    assert.equal((await request(`/government/notifications/${alertId}/read`,'government','officerB',{})).status,404);
    assert.equal((await request(`/government/notifications/${alertId}/read`,'government','officerA',{})).status,200);
    assert.equal((await request('/government/notifications')).data.notifications.length,1);
    db.complaints[0] = {id:'c',status:'assigned',assignedWorkerId:'workerA',assignedById:'officerA'};
    assert.equal((await request('/complaints/c/deadlines','government','officerA',assignment)).status,200);
    assert.equal(db.complaints[0].startDeadlineAt,assignment.startDeadlineAt);
    db.complaints[0].status='resolved';
    assert.equal((await request('/complaints/c/deadlines','government','officerA',assignment)).status,409);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
