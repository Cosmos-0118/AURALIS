"""Control-rate helpers — keyframe envelopes to per-sample curves."""

from __future__ import annotations

import numpy as np

Envelope = list[tuple[float, float]]


def coerce_envelope(raw: object) -> Envelope | None:
    """Normalize JSON/list envelopes to ``[(time_sec, value), ...]``."""
    if raw is None:
        return None
    if not raw:
        return None
    return [(float(t), float(v)) for t, v in raw]


def envelope_to_samples(
    keyframes: Envelope | None,
    fallback: float,
    n_samples: int,
    sr: int,
) -> np.ndarray:
    """
    Linearly interpolate a keyframe envelope to one value per sample.

    Spatial params (width, pan depth) use this path — vectorized ``np.interp``
    over the full buffer is effectively free compared to stem separation.
    """
    if not keyframes:
        return np.full(n_samples, fallback, dtype=np.float32)

    times = np.array([k[0] for k in keyframes], dtype=np.float64)
    values = np.array([k[1] for k in keyframes], dtype=np.float32)
    sample_times = np.arange(n_samples, dtype=np.float64) / sr
    return np.interp(sample_times, times, values).astype(np.float32)


def envelope_to_blocks(
    keyframes: Envelope | None,
    fallback: float,
    n_samples: int,
    sr: int,
    block_size: int,
) -> np.ndarray:
    """
    Interpolate envelope at block centers — optional lighter path for params
    where per-sample resolution is overkill. Not used for reverb crossfade
    (we still use per-sample there); kept for future CPU tuning.
    """
    if not keyframes:
        n_blocks = (n_samples + block_size - 1) // block_size
        return np.full(n_blocks, fallback, dtype=np.float32)

    curve = envelope_to_samples(keyframes, fallback, n_samples, sr)
    n_blocks = (n_samples + block_size - 1) // block_size
    block_vals = np.empty(n_blocks, dtype=np.float32)
    for i in range(n_blocks):
        start = i * block_size
        end = min(start + block_size, n_samples)
        block_vals[i] = float(np.mean(curve[start:end]))
    return block_vals
