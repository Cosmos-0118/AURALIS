# Tech Stack

## Overview

| Layer | Runtime | Role |
|-------|---------|------|
| Client | Browser + Vite | Upload UI, visualizer, Web Audio playback |
| Server | Node.js + Express | File uploads, job orchestration, status polling |
| Engine | Python 3.11+ | Stem separation, analysis, DSP render |

## Client

| Technology | Version | Usage |
|------------|---------|-------|
| Vite | 5.x | Dev server, HMR, production build |
| Vanilla JS (ES modules) | — | UI logic, no framework |
| Web Audio API | — | Playback, analyser-driven visualizer |
| CSS | — | Retro hi-fi device UI, theme system |

**Key modules:** `client/src/main.js`, `audio/engine.js`, `api/pipeline.js`, `themes/`

## Server

| Technology | Version | Usage |
|------------|---------|-------|
| Node.js | 18+ | HTTP server |
| Express | 4.x | REST API |
| Multer | 1.x | Multipart file uploads (100 MB cap) |
| CORS | 2.x | Dev cross-origin between Vite and API |
| concurrently | 9.x | Run server + Vite together via `npm start` |

**Key modules:** `server/index.js`, `routes/api.js`, `jobs/runner.js`, `jobs/status.js`

**API endpoints:**

- `POST /api/process` — upload audio, queue job
- `GET /api/jobs/:id` — poll progress
- `GET /api/download/:id` — fetch rendered WAV
- `DELETE /api/jobs/:id` — cancel running job
- `GET /api/health` — Python venv + profile list

## Engine

| Technology | Version | Usage |
|------------|---------|-------|
| Python | 3.11+ (3.14 tested) | CLI and server-spawned worker |
| PyTorch | 2.1+ | Demucs inference backend |
| torchaudio | 2.1+ | Audio I/O for Demucs |
| torchcodec | 0.14+ | Required for torchaudio 2.11+ save paths |
| Demucs (htdemucs) | 4.x | 4-stem separation: vocals, drums, bass, other |
| Librosa | 0.10+ | BPM, energy, sections, genre/mood hints |
| Pedalboard | 0.9+ | Per-stem EQ, reverb, compression, mixdown |
| NumPy / SciPy | 1.26+ / 1.11+ | Signal math |
| soundfile | 0.12+ | WAV read/write |
| pyloudnorm | 0.1+ | ITU-R BS.1770 LUFS normalization on master bus |

**Optional:**

| Technology | Usage |
|------------|-------|
| OpenAI SDK | LLM render-plan refinement via OpenRouter or Groq (`--llm`) |

**Acceleration:** Demucs auto-selects MPS on Apple Silicon, CUDA when available, else CPU.

## Data & I/O

| Path | Contents |
|------|----------|
| `data/uploads/` | Incoming uploads (deleted after job starts) |
| `data/renders/<jobId>/` | Stems, `profile.json`, `render_plan.json`, output WAV, `job_status.json` |

## Dev tooling

| Tool | Purpose |
|------|---------|
| Vite proxy | Forwards `/api` → `localhost:3000` during dev |
| `PYTHONPATH=engine` | Resolves `auralis` package when spawning from server |
| `.gitignore` | Excludes `node_modules/`, `engine/.venv/`, `data/*` |

## What is not used

- No React/Vue/Svelte on the frontend
- No database — job state is file-based (`job_status.json`)
- No Redis/queue worker — one Python process per job, spawned by Express
- No Docker/Kubernetes in the current setup
