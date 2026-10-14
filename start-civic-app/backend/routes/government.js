const express = require('express');
const { load, save } = require('../data/store');
const { requireAuth, requireRole } = require('../middleware/auth');
const { titleForPoints } = require('../utils/scoring');

const router = express.Router();

// ---- Government: view all worker grievances ----
router.get('/grievances', requireAuth, requireRole('government'), (req, res) => {
  const db = load();
  const { status } = req.query;
  let list = [...db.workerGrievances];
  if (status) list = list.filter((g) => g.status === status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ grievances: list });
});

// ---- Government: respond to / resolve a worker grievance ----
router.post('/grievances/:id/respond', requireAuth, requireRole('government'), (req, res) => {
  const { response, status } = req.body || {};
  const db = load();
  const g = db.workerGrievances.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Grievance not found.' });
  g.response = response || g.response;
  g.status = status && ['open', 'in_review', 'resolved'].includes(status) ? status : 'resolved';
  g.respondedAt = new Date().toISOString();
  save(db);
  res.json({ grievance: g });
});

// ---- Government: list regions ----
router.get('/regions', requireAuth, requireRole('government'), (req, res) => {
  const db = load();
  res.json({ regions: db.regions });
});

// ---- Government: directory of all citizens/workers (lightweight admin view) ----
router.get('/users', requireAuth, requireRole('government'), (req, res) => {
  const db = load();
  const { role } = req.query;
  let list = db.users;
  if (role) list = list.filter((u) => u.role === role);
  res.json({
    users: list.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      region: u.region,
      points: u.points || 0,
      title: titleForPoints(u.points || 0),
      completedTasks: u.completedTasks || 0,
      createdAt: u.createdAt
    }))
  });
});

module.exports = router;
