# Architecture

## System diagram

```mermaid
flowchart LR
  subgraph client [Client — Vite]
    UI[Upload + Visualizer]
    WA[Web Audio Engine]
  end

  subgraph server [Server — Express]
    API[REST API]
    JR[Job Runner]
  end

  subgraph engine [Engine — Python]
    D[Deserializer\nDemucs]
    A[Analyzer\nLibrosa]
    P[Planner\nProfiles]
    AP[Applier\nPedalboard]
  end

  UI -->|POST /api/process| API
  UI -->|poll GET /api/jobs/:id| API
  UI -->|GET /api/download/:id| API
  API --> JR
  JR -->|spawn python -m auralis| D
  D --> A --> P --> AP
  AP -->|WAV + job_status.json| API
  API -->|blob| WA
```

## Request lifecycle

1. **Upload** — Client sends MP3/WAV via `POST /api/process` with a profile name.
2. **Queue** — Server writes `data/renders/<jobId>/job_status.json` (status: `queued`) and spawns the Python engine.
3. **Process** — Engine runs four stages, updating `job_status.json` at each step (8% → 100%).
4. **Poll** — Client calls `GET /api/jobs/:id` every 1.5 s for percent, message, and metadata.
5. **Download** — On `complete`, client fetches the WAV and plays it through Web Audio (bypassing fake stem biquads).
6. **Cleanup** — Upload file is deleted; render directory persists until manually removed.

## Engine stages

| Stage | Module | Output |
|-------|--------|--------|
| Separate | `dsp/deserializer.py` | 4 stem WAVs under `stems/htdemucs/` |
| Analyze | `analysis/analyzer.py` | `profile.json` (BPM, genre, sections, energy) |
| Plan | `analysis/planner.py` | `render_plan.json` (per-stem DSP params) |
| Render | `dsp/applier.py` | Final mixed WAV |

## Profile routing

The planner maps a `SongProfile` + output profile name to `StemEffectParams` for each stem. Vocals and bass stay center-locked; spatial FX (width, reverb, pan LFO) apply to drums and other.

Profiles: `audiophile`, `basshead`, `cinema`, `concert`, `hyper_immersive`, `god`.

## Server responsibilities

- **Orchestration only** — no audio processing in Node
- **Process management** — tracks active PIDs, kills on `DELETE /api/jobs/:id`
- **File serving** — streams rendered WAV on download
- **Metadata bridge** — reads `profile.json` on completion, exposes BPM/genre/mood to the visualizer

## Client responsibilities

- Cassette-bay upload UX with decode progress
- Theme system (CSS variables + definitions)
- BPM-synced CRT meters and spindles from server metadata
- `directPlayback` mode: server-rendered audio → `masterGain` → `AnalyserNode`

## Failure modes

| Failure | Behavior |
|---------|----------|
| Python venv missing | `/api/health` returns `ok: false`; spawn errors set job `failed` |
| Demucs timeout / crash | Non-zero exit → job `failed` with stderr |
| Client disconnect mid-job | `DELETE /api/jobs/:id` kills Python, marks cancelled |
| Upload too large | Multer rejects before job is created |
