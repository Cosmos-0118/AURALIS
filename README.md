# Auralis

Headphone-focused audio enhancer: Demucs stem separation → Librosa analysis → Pedalboard DSP, with a retro hi-fi web UI.

## Architecture

```
Auralis/
├── client/          # Vite frontend (upload, visualizer, playback)
├── server/          # Express API (job queue, file I/O)
├── engine/          # Python pipeline (Demucs + Librosa + Pedalboard)
│   └── auralis/
│       ├── analysis/   # analyzer + render planner
│       ├── dsp/        # deserializer (Demucs) + applier (Pedalboard)
│       └── io/         # job status for polling
├── data/            # Runtime uploads and rendered output (gitignored)
└── docs/            # Tech stack, architecture, profiles
```

## Prerequisites

- Node.js 18+
- Python 3.11+ (3.14 tested on Apple Silicon with MPS)

## Setup

```bash
# JavaScript dependencies
npm install

# Python virtual environment
python3 -m venv engine/.venv
source engine/.venv/bin/activate
python -m pip install -r engine/requirements.txt
```

## Run

```bash
npm start
```

- Frontend: http://localhost:5173
- API: http://localhost:3000/api/health

Upload a track in the UI, pick a profile (Zenith, Cinema, Concert, etc.), and wait for the server-rendered WAV.

## CLI (headless)

From the project root with the venv activated:

```bash
export PYTHONPATH=engine

# Full pipeline
python -m auralis process song.mp3 --profile zenith -o out.wav

# Individual steps
python -m auralis separate song.mp3 --work-dir data/renders/my_track
python -m auralis analyze song.mp3 -o profile.json --profile zenith
```

## Output profiles

| Profile | Character |
|---------|-----------|
| `audiophile` | Minimal FX, neutral staging |
| `basshead` | +6 dB sub, tight compression |
| `cinema` | Wide reverb, cinematic squash |
| `concert` | Arena reverb, BPM-synced pan LFO |
| `hyper_immersive` | Between concert and zenith |
| `zenith` | Peak-tier immersion; Kinetic Engine on spatial stems |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Express server port |
| `AURALIS_PYTHON` | `engine/.venv/bin/python` | Python interpreter |
| `AURALIS_MAX_UPLOAD_MB` | `100` | Upload size limit |
| `OPENROUTER_API_KEY` | — | Optional LLM plan refinement (`--llm`) |

## Documentation

- [Tech stack](docs/techstack.md) — languages, libraries, and tooling
- [Architecture](docs/architecture.md) — request flow and component boundaries
- [Profiles](docs/profiles.md) — DSP preset reference
- [Naming](docs/naming.md) — Kinetic Engine, Zenith, and profile slugs

## License

Private project.
