"""Mid/Side utilities — elliptical filtering and stereo analysis."""

from __future__ import annotations

import numpy as np
from pedalboard import HighpassFilter, Pedalboard


def apply_elliptical_filter(
    audio: np.ndarray,
    sr: int,
    *,
    side_hpf_hz: float = 200.0,
) -> np.ndarray:
    """
    Elliptical EQ: high-pass the Side channel so kick/snare body stays in Mid.

    Cymbals and hi-hats remain wide; low-frequency punch stays center-locked.
    """
    if audio.ndim == 1 or side_hpf_hz <= 0:
        return audio

    mid = (audio[0] + audio[1]) * 0.5
    side = (audio[0] - audio[1]) * 0.5

    side_stereo = np.stack([side, side], axis=0)
    hpf = Pedalboard([HighpassFilter(cutoff_frequency_hz=side_hpf_hz)])
    side_filtered = hpf(side_stereo, sr)[0]

    return np.stack([mid + side_filtered, mid - side_filtered], axis=0).astype(np.float32)


def phase_correlation(audio: np.ndarray) -> float:
    """
    L/R phase correlation in [-1, 1].

    Values below ~0.15 indicate dangerous out-of-phase widening.
    """
    if audio.ndim == 1 or audio.shape[1] < 2:
        return 1.0

    left = audio[0].astype(np.float64)
    right = audio[1].astype(np.float64)
    denom = np.sqrt(np.sum(left**2) * np.sum(right**2))
    if denom <= 0:
        return 1.0
    return float(np.clip(np.sum(left * right) / denom, -1.0, 1.0))
