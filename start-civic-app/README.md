# CivicPulse — Smart Civic Engagement Platform

A full-stack, three-portal civic complaint management platform built for a hackathon MVP: **Public** (citizens), **Government** (authority dashboard), and **Worker** (field staff). Built with Node.js/Express on the backend and a dependency-light vanilla JS frontend, so it runs with a single command and no build step.

---

## ✨ Features

| Feature | Where it lives |
|---|---|
| **AI duplicate detection** (geo-distance + text similarity, crowd confirmation merge) | `backend/routes/complaints.js` → `findDuplicateCandidate()` |
| **AI priority scoring** (category severity + proximity to schools/hospitals + confirmations + aging) | `backend/utils/scoring.js` → `computePriorityScore()` |
| **Real-time civic heat map** (Leaflet, color-coded by status) | `frontend/js/{public,government,main}.js`, `/api/insights/heatmap` |
| **AI resolution verification** (before/after photo heuristic + mandatory citizen feedback) | `backend/utils/scoring.js` → `estimateResolutionConfidence()`, `/complaints/:id/feedback` |
| **Citizen reputation system** (points, unlockable titles) | `backend/utils/scoring.js` → `titleForPoints()`, `POINTS` |
| **Authority dashboard** (KPIs + Chart.js charts, real-time) | `frontend/js/government.js`, `/api/insights/stats` |
| **Gamification** (leaderboard, "Civic Contributor" / "Clean City Champion" / "Civic Hero" titles) | `/api/insights/leaderboard` |
| **Worker benefits + grievance escalation to officials** | `backend/routes/worker.js`, `backend/routes/government.js` |
| **Recurring-issue detection** (flags hotspots with repeat reports of the same type nearby) | `backend/utils/scoring.js` → `computePriorityScore()` |
| **Weather-based ML priority risk** (live forecast → logistic-regression risk model → priority boost) | `backend/utils/weather.js` → `getWeatherRisk()` |
| **"Why this priority" explainability panel** (per-factor point breakdown, shown to officials) | `frontend/js/government.js`, `complaint.priorityReasons` |

---

## 🗂️ Project structure

```
civic-app/
├── backend/
│   ├── server.js              # Express app entrypoint (serves API + frontend)
│   ├── package.json
│   ├── data/store.js          # JSON-file datastore (no native DB deps)
│   ├── middleware/auth.js     # JWT auth + role guards
│   ├── routes/
│   │   ├── auth.js            # register/login/me/workers
│   │   ├── complaints.js      # create/list/confirm/assign/start/resolve/feedback
│   │   ├── worker.js          # tasks, benefits summary, grievances
│   │   ├── government.js      # grievance review, directory, regions
│   │   └── insights.js        # heatmap, stats, leaderboard
│   ├── utils/
│   │   ├── geo.js             # haversine distance
│   │   ├── similarity.js      # Jaccard text similarity
│   │   └── scoring.js         # priority scoring + reputation + AI verification heuristic
│   └── uploads/                # before/after photo storage (created at runtime)
└── frontend/
    ├── index.html              # landing + auth modal + all 3 portal shells
    ├── css/style.css           # design system (civic signage theme)
    └── js/
        ├── api.js              # fetch wrapper + session state
        ├── ui.js                # toasts, chips, formatting helpers
        ├── public.js            # citizen portal logic
        ├── government.js        # authority dashboard logic
        ├── worker.js             # field worker portal logic
        └── main.js               # router, auth modal, landing page
```

---

## 📍 GPS location evidence: camera EXIF or visible GPS Map Camera stamp

**New citizen reports require either embedded GPS EXIF coordinates or a legible GPS coordinate stamp printed on the photo** (like GPS Map Camera photos).

- Supported: JPEG (.jpg/.jpeg), PNG (.png with `eXIf` chunk), and WebP (.webp with `EXIF` chunk), up to **8 MB**.
- The browser first checks the original EXIF GPS tags. If none are present, it sends the photo to the local backend to read a visible `Lat ... Long ...` GPS stamp using OCR (Tesseract.js). Once coordinates are found, the map pin is set automatically and citizens cannot edit the coordinates.
- The backend **independently validates the uploaded image** on complaint submission, either reading EXIF or extracting visibly stamped coordinates using OCR. Images with neither are rejected and removed, and no complaint is created.
- The backend uses coordinates extracted from the **photo itself** (EXIF or printed GPS stamp), **not** browser form values. `photoGpsSource` records `embedded_exif` or `visible_stamp_ocr`. Existing complaints and worker after-repair photos are unchanged.
- To take a compatible photo, enable GPS tagging in the ordinary camera **or** use GPS Map Camera and make sure `Lat` and `Long` appear clearly in the photo itself. If using EXIF, transfer the original; screenshots or messaging apps may strip metadata. Only JPEG, PNG and WebP up to 8 MB are supported (not HEIC).
- **Security note:** Both EXIF metadata and visible coordinate stamps can be edited or spoofed. OCR reading a stamp only confirms what the picture *says*; it is **not** independent proof of the actual photo location. For strict authenticity, add live camera capture/device attestation plus location checks.
- OCR uses `tesseract.js` and an included local English language model (`backend/ocr-data/eng.traineddata.gz`). First install dependencies with `npm install` inside `backend`; no separate Python installation, OCR executable or cloud API is required. The first OCR request may take longer while the worker initializes.
- Photo precheck endpoint: `POST /api/complaints/photo-location`, JWT required, `multipart/form-data` with `photoBefore`. This precheck does not store the uploaded file. Final complaint submission validates again.
- The application still has no background video.
- The included English OCR model comes from the Apache-2.0-licensed `tessdata_fast` project; its license is in `backend/ocr-data/LICENSE-APACHE-2.0.txt`.

Run the tests from the project root using `node --test backend/tests/*.test.js` (on Windows PowerShell, use `cd backend; node --test tests\*.test.js`).

---

## 🚀 Running it

**Requirements:** Node.js 18+ (no database to install — it uses a JSON file store).

```bash
cd backend
npm install
npm start
```

Then open **http://localhost:4000** — the backend serves the frontend directly, so this is the only URL you need.

### Demo accounts (seeded automatically on first boot)

| Role | Email | Password |
|---|---|---|
| Government | `gov.demo@civic.app` | `Gov@1234` |
| Field Worker | `worker.demo@civic.app` | `Work@1234` |
| Citizen | `citizen.demo@civic.app` | `Citizen@1234` |

### Registering new accounts

- **Citizens** can self-register freely from the "Get started" button.
- **Government** and **Worker** accounts require an access code (simple secure-by-default gate for a hackathon demo):
  - Government code: `GOV-2026-CIVIC`
  - Worker code: `WORK-2026-FIELD`
  - Override via environment variables `GOV_INVITE_CODE` / `WORKER_INVITE_CODE` before `npm start` if you want to change them.

---

## 🧪 Try the full loop in under 2 minutes

1. Log in as **Citizen** → *Report an issue* → upload an EXIF GPS photo or a GPS Map Camera stamped photo → verify that the location marker is set → submit. Watch the priority score/level appear.
2. Log in as **Government** → *All complaints* → assign it to the demo Worker.
3. Log in as **Worker** → *My tasks* → *Start work* → *Submit after-photo & resolve*.
4. Log in as **Citizen** → *My reports* → *Verify resolution* → confirm fixed. Points and title update immediately (check *My reputation*).
5. Try reporting a **very similar issue near the same spot** again as citizen — it will auto-merge as a duplicate/crowd-confirmation instead of creating a new ticket, and boost the original's priority.

---

## ⚙️ Design notes / what's "AI" here

This is a hackathon MVP, so the "AI" layers are deliberately lightweight, fast, explainable heuristics rather than trained models — they're structured so any of them could be swapped for a real ML model later without changing the API contract:

- **Duplicate detection** = Haversine distance (≤120m) + Jaccard token-similarity on description text (≥0.28), same category.
- **Priority scoring** = weighted sum of category severity, proximity to seeded school/hospital coordinates (≤300m), crowd-confirmation count, complaint age, recurring-issue history, and live weather risk (see below).
- **Recurring-issue detection** = counts prior reports of the same category within 250m of a new report — a growing cluster (e.g. three potholes forming on the same stretch of road) raises the priority automatically.
- **Weather risk prediction (ML)** = a small **logistic regression** model, `sigmoid(weights · live-forecast-features)`, run per complaint category. It pulls today's rain probability, expected precipitation, wind speed, and max temperature from [Open-Meteo](https://open-meteo.com/) (free, no API key) for the complaint's exact coordinates, then scores how much *that* category should be worried about *that* forecast — e.g. a blocked drain or open pothole gets a big boost ahead of heavy rain, while an uncollected garbage pile gets boosted ahead of a heatwave. The weights are hand-set constants in `backend/utils/weather.js` (`W_RAIN_PROB`, `W_PRECIP_MM`, `W_WIND`, `W_HEAT`) so they can be replaced with weights fit on real outcome data later without touching any calling code. If the forecast API is unreachable (offline, rate-limited, etc.) it fails soft — risk defaults to 0/"Unknown" and complaint creation is never blocked.
- **Resolution verification** = a confidence heuristic from the before/after photo upload, always paired with a **mandatory human-in-the-loop citizen confirmation** before a case is marked `verified` — the system never self-closes a case.
- **Explainability** — every complaint carries a `priorityReasons` array (one entry per scoring factor, with its point contribution) shown to officials as a "🤖 Why AI gave this priority" panel on the Government dashboard.

## 🖥️ Tech stack used

- **Backend:** Node.js + Express, JWT auth (`jsonwebtoken`), `bcryptjs`, `multer` for photo uploads, JSON-file storage (zero external DB setup).
- **Frontend:** Vanilla HTML/CSS/JS (no build step), Leaflet.js for the heat map and Chart.js for the authority dashboard — both bundled locally under `frontend/vendor/` so the app works even with a flaky venue wifi.
- **Weather data:** [Open-Meteo](https://open-meteo.com/) forecast API — free, no signup, no API key. Requires the server to have internet access; the app degrades gracefully without it.
- **Auth:** Role-based JWT (`public` / `government` / `worker`), with invite-code gating for the government and worker roles.

## 📝 Known limitations (by design, for a hackathon MVP)

- Storage is a JSON file, not a production database — fine for a demo, swap for Postgres/Mongo for production.
- "AI" is rule-based/heuristic, not a trained model — see design notes above for how each piece maps to a real ML upgrade path.
- Single-process deployment (frontend + API together) for simplicity — split them behind a reverse proxy for production.
