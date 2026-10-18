const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { load, save } = require('../data/store');
const { resetStartDeadline, parseOfficerStartDeadline } = require('../utils/workerAlerts');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { distanceMeters } = require('../utils/geo');
const { jaccardSimilarity } = require('../utils/similarity');
const {
 computePriorityScore ,
  titleForPoints,
  POINTS,
  estimateResolutionConfidence
} = require('../utils/scoring');
const { getWeatherRisk } = require('../utils/weather');
// Shared with the citizen upload UI so browser and server validate the same GPS EXIF data.
const GeoTag = require('../../frontend/js/geotag');
const { findPhotoGps } = require('../utils/photoGps');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Citizen photos get a safe, canonical extension (never trust client filenames).
    const citizenExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    const ext = file.fieldname === 'photoBefore'
      ? (citizenExtensions[file.mimetype] || '.img')
      : (path.extname(file.originalname) || '.jpg');
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photoBefore' && !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      const err = new Error('Citizen photos must be JPEG, PNG or WebP files with embedded GPS or a visible GPS coordinate stamp.');
      err.status = 400;
      return cb(err);
    }
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed.'));
  }
});

const DUPLICATE_DISTANCE_METERS = 120;
const DUPLICATE_TEXT_SIMILARITY = 0.28;
const CROWD_CONFIRM_THRESHOLD = 3; // confirmations needed to formally mark as verified duplicate cluster

function fileUrl(req, filename) {
  if (!filename) return null;
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

function serializeComplaint(req, c) {
  return {
    ...c,
    photoBeforeUrl: fileUrl(req, c.photoBefore),
    photoAfterUrl: fileUrl(req, c.photoAfter),
    confirmationsCount: (c.confirmations || []).length
  };
}

/**
 * AI Duplicate Complaint Detection:
 * A new report is compared against existing OPEN complaints of the same
 * category within DUPLICATE_DISTANCE_METERS, using text similarity on the
 * description. Strong matches are auto-linked; the reporter's submission is
 * then treated as "crowd confirmation" of the existing complaint instead of
 * creating noise, and the original complaint's priority rises accordingly.
 */
function findDuplicateCandidate(db, { category, lat, lng, description }) {
  const openStatuses = ['pending', 'assigned', 'in_progress'];
  let best = null;
  let bestScore = 0;
  for (const c of db.complaints) {
    if (c.category !== category) continue;
    if (!openStatuses.includes(c.status)) continue;
    const d = distanceMeters(lat, lng, c.lat, c.lng);
    if (d > DUPLICATE_DISTANCE_METERS) continue;
    const sim = jaccardSimilarity(description, c.description);
    if (sim >= DUPLICATE_TEXT_SIMILARITY) {
      const combined = sim - d / (DUPLICATE_DISTANCE_METERS * 4); // prefer closer + more similar
      if (combined > bestScore) {
        bestScore = combined;
        best = c;
      }
    }
  }
  return best;
}

// ---- Pre-check photo location (without saving the uploaded file) ----
// Browser uses this to accept GPS Map Camera-style stamps after server OCR.
const previewUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else { const err = new Error('Choose a JPEG, PNG or WebP photo.'); err.status = 400; cb(err); }
  }
});

router.post('/photo-location', requireAuth, requireRole('public'), previewUpload.single('photoBefore'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Select a location-stamped photo.' });
  const type = GeoTag.imageType(req.file.buffer);
  const expected = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  if (!type || expected[type] !== req.file.mimetype) {
    return res.status(400).json({ error: 'Uploaded file is not a valid JPEG, PNG or WebP photo.' });
  }
  try {
    const gps = await findPhotoGps(req.file.buffer);
    if (!gps) return res.status(400).json({ error: 'No readable GPS coordinates found. Use an original geotagged photo or a clear GPS Map Camera photo showing both Lat and Long.' });
    res.json({ latitude: gps.latitude, longitude: gps.longitude, source: gps.source });
  } catch (err) {
    console.error('Photo OCR error:', err);
    return res.status(503).json({ error: 'GPS stamp OCR could not start. Run npm install in the backend folder and restart the server, then retry.' });
  }
});

// ---- Create complaint (public citizens) ----
// Photo GPS is mandatory: embedded EXIF OR explicitly labelled visible
// latitude/longitude stamp. Form coordinates are never trusted.
router.post('/', requireAuth, requireRole('public'), upload.single('photoBefore'), async (req, res) => {
  function rejectReport(message) {
    // Multer writes to disk before this handler. Do not keep rejected photos.
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_err) { /* already removed */ }
    }
    return res.status(400).json({ error: message });
  }

  if (!req.file) return rejectReport('A GPS-geotagged photo is mandatory. The report was not submitted.');

  const imageBytes = fs.readFileSync(req.file.path);
  const actualType = GeoTag.imageType(imageBytes);
  const expectedMime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  if (!actualType || req.file.mimetype !== expectedMime[actualType]) {
    return rejectReport('Unsupported or mismatched photo format. Use an original JPEG, PNG or WebP image with GPS location metadata.');
  }
  let photoGps;
  try {
    photoGps = await findPhotoGps(imageBytes);
  } catch (err) {
    console.error('Photo OCR error:', err);
    return rejectReport('GPS stamp OCR could not run. Run npm install in the backend folder and restart the server.');
  }
  if (!photoGps) {
    return rejectReport('Photo rejected: no embedded GPS or readable stamped Lat/Long coordinates found. Upload a GPS Map Camera photo showing both coordinates.');
  }

  const { title, description, category, address } = req.body || {};
  if (!title || !description || !category) {
    return rejectReport('title, description and category are required.');
  }
  // Authoritative coordinates are from the image itself, never form fields.
  const latNum = photoGps.latitude;
  const lngNum = photoGps.longitude;

  const db = load();
  const duplicate = findDuplicateCandidate(db, { category, lat: latNum, lng: lngNum, description });

  if (duplicate) {
    // Treat as crowd confirmation of the existing complaint rather than a new record.
    duplicate.confirmations = duplicate.confirmations || [];
    if (!duplicate.confirmations.includes(req.user.id)) {
      duplicate.confirmations.push(req.user.id);
    }
    const weatherRisk = await getWeatherRisk(duplicate.lat, duplicate.lng, duplicate.category);
    const scoring = computePriorityScore(
  {
    id: duplicate.id,
    category: duplicate.category,
    lat: duplicate.lat,
    lng: duplicate.lng,
    confirmationsCount: duplicate.confirmations.length,
    createdAt: duplicate.createdAt
  },
  db.sensitiveLocations,
  db.complaints,
  weatherRisk
);
    duplicate.priorityScore = scoring.score;
    duplicate.recurringCount = scoring.recurringCount;
    duplicate.recurringRisk = scoring.recurringRisk;
    duplicate.weatherRisk = scoring.weatherRisk;
    duplicate.priorityReasons = scoring.reasons;
    duplicate.priorityLevel = scoring.level;
    duplicate.nearSensitiveLocation = scoring.nearSensitiveLocation;
    duplicate.nearestSensitiveLocation = scoring.nearestSensitiveLocation;
    if (duplicate.confirmations.length >= CROWD_CONFIRM_THRESHOLD) {
      duplicate.crowdVerified = true;
    }

    // Reward the reporter for surfacing a confirmed real-world issue.
    const reporter = db.users.find((u) => u.id === req.user.id);
    if (reporter) reporter.points = (reporter.points || 0) + POINTS.CROWD_CONFIRM;

    save(db);
    try { fs.unlinkSync(req.file.path); } catch (_err) { /* best effort */ }
    return res.status(200).json({
      duplicate: true,
      message: 'A similar complaint already exists nearby. Your report has been merged in as a crowd confirmation, boosting its priority.',
      complaint: serializeComplaint(req, duplicate)
    });
  }

  const complaint = {
    id: uuid(),
    title,
    description,
    category,
    lat: latNum,
    lng: lngNum,
    address: address || '',
    status: 'pending',
    photoBefore: req.file.filename,
    photoGpsVerified: true, // location format verified, NOT authenticity of geolocation
    photoGpsSource: photoGps.source,
    photoAfter: null,
    reporterId: req.user.id,
    reporterName: req.user.name,
    assignedWorkerId: null,
    assignedWorkerName: null,
    assignedRegion: null,
    confirmations: [],
    crowdVerified: false,
    resolutionConfidence: null,
    feedbackRating: null,
    feedbackComment: null,
    createdAt: new Date().toISOString(),
    assignedAt: null,
    resolvedAt: null,
    verifiedAt: null
  };
  const weatherRisk = await getWeatherRisk(latNum, lngNum, category);
  const scoring = computePriorityScore(
  complaint,
  db.sensitiveLocations,
  db.complaints,
  weatherRisk
);
  complaint.priorityScore = scoring.score;
  complaint.priorityLevel = scoring.level;
  complaint.nearSensitiveLocation = scoring.nearSensitiveLocation;
  complaint.nearestSensitiveLocation = scoring.nearestSensitiveLocation;

  complaint.recurringCount = scoring.recurringCount;
  complaint.recurringRisk = scoring.recurringRisk;
  complaint.weatherRisk = scoring.weatherRisk;
  complaint.priorityReasons = scoring.reasons;
  db.complaints.push(complaint);

  const reporter = db.users.find((u) => u.id === req.user.id);
  if (reporter) reporter.points = (reporter.points || 0) + POINTS.REPORT_COMPLAINT;

  save(db);
  res.status(201).json({ duplicate: false, complaint: serializeComplaint(req, complaint) });
});

// ---- List complaints (filterable) ----
router.get('/', optionalAuth, (req, res) => {
  const db = load();
  let list = [...db.complaints];
  const { status, category, region, mine } = req.query;

  if (status) list = list.filter((c) => c.status === status);
  if (category) list = list.filter((c) => c.category === category);
  if (region) list = list.filter((c) => c.assignedRegion === region);
  if (mine === 'true' && req.user) list = list.filter((c) => c.reporterId === req.user.id);
  if (mine === 'assigned' && req.user) list = list.filter((c) => c.assignedWorkerId === req.user.id);

  list.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  res.json({ complaints: list.map((c) => serializeComplaint(req, c)) });
});

router.get('/:id', optionalAuth, (req, res) => {
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  res.json({ complaint: serializeComplaint(req, c) });
});

// ---- Crowd confirmation on an existing complaint (upvote "this is happening to me too") ----
router.post('/:id/confirm', requireAuth, requireRole('public'), async (req, res) => {
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  c.confirmations = c.confirmations || [];
  if (c.confirmations.includes(req.user.id)) {
    return res.status(409).json({ error: 'You already confirmed this complaint.' });
  }
  if (c.reporterId === req.user.id) {
    return res.status(400).json({ error: 'You cannot confirm your own complaint.' });
  }
  c.confirmations.push(req.user.id);

  const weatherRisk = await getWeatherRisk(c.lat, c.lng, c.category);
  const scoring = computePriorityScore(
  {
    id: c.id,
    category: c.category,
    lat: c.lat,
    lng: c.lng,
    confirmationsCount: c.confirmations.length,
    createdAt: c.createdAt
  },
  db.sensitiveLocations,
  db.complaints,
  weatherRisk
);
  c.priorityScore = scoring.score;
  c.recurringCount = scoring.recurringCount;
  c.recurringRisk = scoring.recurringRisk;
  c.weatherRisk = scoring.weatherRisk;
  c.priorityReasons = scoring.reasons;
  c.priorityLevel = scoring.level;
  if (c.confirmations.length >= CROWD_CONFIRM_THRESHOLD) c.crowdVerified = true;

  const user = db.users.find((u) => u.id === req.user.id);
  if (user) user.points = (user.points || 0) + POINTS.CROWD_CONFIRM;

  save(db);
  res.json({ complaint: serializeComplaint(req, c) });
});

// ---- Government: assign complaint to a worker/region ----
router.post('/:id/assign', requireAuth, requireRole('government'), (req, res) => {
  const { workerId, region, startDeadlineAt } = req.body || {};
  if (!workerId) return res.status(400).json({ error: 'workerId is required.' });
  const deadline = parseOfficerStartDeadline(startDeadlineAt);
  if (!deadline) {
    return res.status(400).json({ error: 'Select a future start-work deadline (date and time) before assigning a worker.' });
  }
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  const worker = db.users.find((u) => u.id === workerId && u.role === 'worker');
  if (!worker) return res.status(404).json({ error: 'Worker not found.' });

  if (!['pending', 'assigned'].includes(c.status)) return res.status(409).json({ error: 'Only pending or unstarted tasks can be assigned or reassigned.' });
  c.assignedById = req.user.id;
  c.assignedWorkerId = worker.id;
  c.assignedWorkerName = worker.name;
  c.assignedRegion = region || worker.region || 'Central Zone';
  c.status = 'assigned';
  resetStartDeadline(c, new Date(), deadline);
  save(db);
  res.json({ complaint: serializeComplaint(req, c) });
});

// ---- Worker: start work ----
router.post('/:id/start', requireAuth, requireRole('worker'), (req, res) => {
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  if (c.assignedWorkerId !== req.user.id) return res.status(403).json({ error: 'This task is not assigned to you.' });
  if (c.status !== 'assigned') return res.status(409).json({ error: 'Task must be assigned and not yet started.' });
  c.startedAt = new Date().toISOString();
  c.status = 'in_progress';
  save(db);
  res.json({ complaint: serializeComplaint(req, c) });
});

// ---- Worker: submit after-photo to resolve ----
router.post('/:id/resolve', requireAuth, requireRole('worker'), upload.single('photoAfter'), (req, res) => {
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  if (c.assignedWorkerId !== req.user.id) return res.status(403).json({ error: 'This task is not assigned to you.' });
  if (!req.file) return res.status(400).json({ error: 'An after-photo is required as proof of completion.' });

  c.photoAfter = req.file.filename;
  c.status = 'resolved';
  c.resolvedAt = new Date().toISOString();

  const beforePath = c.photoBefore ? path.join(UPLOAD_DIR, c.photoBefore) : null;
  const beforeStat = beforePath && fs.existsSync(beforePath) ? fs.statSync(beforePath) : { size: 0 };
  const afterStat = fs.statSync(req.file.path);
  const ai = estimateResolutionConfidence(beforeStat, afterStat);
  c.resolutionConfidence = ai.confidence;
  c.resolutionNote = ai.note;

  save(db);
  res.json({ complaint: serializeComplaint(req, c), aiVerification: ai });
});

// ---- Citizen: give feedback / confirm the resolution (closes the loop) ----
router.post('/:id/feedback', requireAuth, requireRole('public'), (req, res) => {
  const { rating, comment, verified } = req.body || {};
  if (rating === undefined || verified === undefined) {
    return res.status(400).json({ error: 'rating and verified are required.' });
  }
  const db = load();
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found.' });
  if (c.reporterId !== req.user.id) return res.status(403).json({ error: 'Only the original reporter can verify this resolution.' });
  if (c.status !== 'resolved') return res.status(400).json({ error: 'Complaint is not awaiting verification.' });

  c.feedbackRating = Number(rating);
  c.feedbackComment = comment || '';
  c.verifiedAt = new Date().toISOString();

  const isVerified = verified === true || verified === 'true';
  if (isVerified) {
    c.status = 'verified';
    const reporter = db.users.find((u) => u.id === c.reporterId);
    if (reporter) reporter.points = (reporter.points || 0) + POINTS.REPORTER_VERIFIED_RESOLUTION;

    const worker = db.users.find((u) => u.id === c.assignedWorkerId);
    if (worker) {
      let pts = POINTS.WORKER_TASK_COMPLETE;
      if (c.nearSensitiveLocation) pts += POINTS.WORKER_SENSITIVE_BONUS;
      worker.points = (worker.points || 0) + pts;
      worker.completedTasks = (worker.completedTasks || 0) + 1;
    }
  } else {
    // Citizen disputes the fix -> official must assign the reopened complaint
    // and explicitly choose another start deadline.
    c.status = 'pending';
    c.assignedWorkerId = null;
    c.assignedWorkerName = null;
    c.assignedRegion = null;
    c.assignedById = null;
    c.assignedAt = null;
    c.assignmentId = null;
    c.startDeadlineAt = null;
    c.startedAt = null;
    c.overdueNotifiedAt = null;
    c.photoAfter = null;
    c.resolutionConfidence = null;
    c.resolvedAt = null;
  }

  save(db);
  res.json({ complaint: serializeComplaint(req, c) });
});

module.exports = router;
