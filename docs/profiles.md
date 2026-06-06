# Output Profiles

Each profile is a preset of per-stem DSP parameters built by `analysis/planner.py` and applied by `dsp/applier.py`.

## Quick reference

| Profile | Best for | Key moves |
|---------|----------|-----------|
| `audiophile` | Neutral listening | Minimal FX, light drum/other width (+1.25), subtle air |
| `basshead` | Sub-heavy genres | +6 dB @ 80 Hz bass, tight 4:1 compression, narrow stage |
| `cinema` | Film score, ambience | 2.5× width on `other`, heavy reverb, 6:1 drum squash |
| `concert` | Live energy | Arena reverb, pan LFO locked to BPM ÷ 4 |
| `hyper_immersive` | EDM / pop immersion | Between concert and zenith — wide stage, moderate LFO |
| `zenith` | Peak-tier immersion | Kinetic Engine + maximal spatial staging; vocals/bass centered |

## Stem rules (all profiles)

- **Vocals** — `center_lock=true`, clarity EQ, minimal reverb
- **Bass** — `center_lock=true`, no stereo widening
- **Drums** — spatial width, optional pan LFO, light reverb
- **Other** — widest field, most reverb and movement

## Per-profile detail

### Audiophile

Transparent mastering-style pass. No pan LFO. Light high-shelf air on drums/other. Gentle 2:1 compression on spatial stems only.

### Basshead

Boosts sub (80 Hz, +6 dB), tightens bass with 4:1 compression. Cuts low mud on vocals/other (−2 dB @ 150 Hz). Narrower overall stage.

### Cinema

Massive `other` stem: 2.5× width, 0.4 reverb mix, large room. Drums get 6:1 squash and moderate width. Vocals get a touch of hall reverb. Master limiter at −2 dB.

### Concert

Reverb-heavy arena feel. Pan LFO on drums and other at quarter-note rate (BPM ÷ 4). Vocal presence boost at 4 kHz.

### Hyper Immersive

Strong width (1.55 drums, 1.95 other) with BPM-synced pan LFO (~0.15 Hz scaled). Moderate reverb. Vocals slightly narrowed for contrast.

### Zenith

Center-locked vocals/bass. Drums: 1.525× width, pan LFO at BPM × 0.125, depth 0.65. Other: 1.85× width, depth 0.85, rich reverb. Kinetic Engine breathes width and reverb with section energy. Master gain +0.5 dB on electronic/dance tracks.

## DSP primitives (Pedalboard)

Each stem chain can include:

- Low/high shelf EQ, peak EQ
- Highpass / lowpass filters
- Reverb (room size, damping, mix)
- Compressor (threshold, ratio, attack, release)
- Stereo width scaling
- Pan LFO (sine modulation on L/R balance)
- Master gain + peak limiter on mixdown

## Micro-detail (tone board)

Static per-profile values in the planner; transient thresholds get a light RMS nudge from Librosa analysis.

| Stem | Node | Profiles |
|------|------|----------|
| `bass` | `Distortion` (tape drive) | Basshead 5 dB, Zenith 3 dB, Cinema 2.5 dB |
| `drums` | Slow-attack `Compressor` (transient punch) | Zenith, Concert, Cinema, Hyper Immersive, Basshead |
| `vocals` | `HighShelfFilter` @ 8.5 kHz (air) | Zenith 2.5 dB, Concert 2 dB, Cinema 1.5 dB |

Audiophile bypasses all micro-detail nodes for transparency.

## CLI usage

```bash
export PYTHONPATH=engine
python -m auralis process track.mp3 --profile zenith -o out.wav
python -m auralis analyze track.mp3 --profile cinema -o profile.json
```

## Optional LLM refinement

Pass `--llm` to send the Librosa profile to OpenRouter/Groq. The model adjusts stem params within the same schema. Falls back to rule-based plan if no API key or on parse failure.

```bash
export OPENROUTER_API_KEY=sk-...
python -m auralis process track.mp3 --profile zenith --llm
```
