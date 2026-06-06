"""Master bus — glue compression, LUFS normalization, true-peak limiting."""

from __future__ import annotations

import logging

import numpy as np
import pyloudnorm as pyln
from pedalboard import (
    Compressor,
    Gain,
    HighpassFilter,
    Limiter,
    LowpassFilter,
    Pedalboard,
)

from auralis.types import RenderPlan

logger = logging.getLogger(__name__)


def _linear_from_db(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def normalize_lufs(audio: np.ndarray, sr: int, target_lufs: float) -> np.ndarray:
    """
    Integrated loudness normalization (ITU-R BS.1770 via pyloudnorm).

    Expects *audio* as (channels, samples); returns same layout.
    """
    if audio.size == 0:
        return audio

    stereo = audio.T
    min_samples = max(int(sr * 0.4), 1)
    if stereo.shape[0] < min_samples:
        logger.debug("Skipping LUFS normalize — buffer shorter than 400 ms")
        return audio

    meter = pyln.Meter(sr)
    try:
        loudness = meter.integrated_loudness(stereo)
    except ValueError:
        logger.debug("Skipping LUFS normalize — inaudible or invalid meter input")
        return audio

    if not np.isfinite(loudness):
        return audio

    normalized = pyln.normalize.loudness(stereo, loudness, target_lufs)
    logger.info("LUFS normalize: %.1f → %.1f LUFS", loudness, target_lufs)
    return normalized.T.astype(np.float32)


def trim_to_lufs(audio: np.ndarray, sr: int, target_lufs: float) -> np.ndarray:
    """Apply a gain offset so integrated loudness lands on *target_lufs*."""
    if audio.size == 0:
        return audio

    stereo = audio.T
    meter = pyln.Meter(sr)
    try:
        current = meter.integrated_loudness(stereo)
    except ValueError:
        return audio

    if not np.isfinite(current):
        return audio

    delta_db = target_lufs - current
    if abs(delta_db) < 0.25:
        return audio

    logger.debug("LUFS trim: %.1f → %.1f (Δ %.1f dB)", current, target_lufs, delta_db)
    return (audio * (10.0 ** (delta_db / 20.0))).astype(np.float32)


def apply_true_peak_ceiling(audio: np.ndarray, ceiling_db: float) -> np.ndarray:
    """Hard sample-peak ceiling — safety net after the limiter (-0.1 dBTP target)."""
    ceiling = _linear_from_db(ceiling_db)
    peak = float(np.max(np.abs(audio)))
    if peak <= ceiling or peak == 0.0:
        return audio
    logger.debug("True-peak ceiling: scaling %.3f → %.3f", peak, ceiling)
    return (audio * (ceiling / peak)).astype(np.float32)


def master_process(mix: np.ndarray, sr: int, plan: RenderPlan) -> np.ndarray:
    """
    Final mastering chain after stem summing:

    1. Profile master gain + band limiting
    2. Gentle glue compression
    3. LUFS normalization (streaming parity)
    4. Brickwall limiter + true-peak ceiling
    """
    glue = Pedalboard([
        Gain(gain_db=plan.master_gain_db),
        HighpassFilter(cutoff_frequency_hz=30.0),
        LowpassFilter(cutoff_frequency_hz=18000.0),
        Compressor(
            threshold_db=plan.master_glue_threshold_db,
            ratio=2.0,
            attack_ms=10.0,
            release_ms=120.0,
        ),
    ])
    audio = glue(mix, sr)

    audio = normalize_lufs(audio, sr, plan.master_lufs_target)

    limiter = Pedalboard([
        Limiter(
            threshold_db=plan.master_true_peak_db,
            release_ms=50.0,
        ),
    ])
    audio = limiter(audio, sr)
    audio = apply_true_peak_ceiling(audio, plan.master_true_peak_db)

    # Limiter pulls level below the first LUFS pass — trim back to target, then re-ceiling
    audio = trim_to_lufs(audio, sr, plan.master_lufs_target)
    audio = apply_true_peak_ceiling(audio, plan.master_true_peak_db)

    peak_db = 20.0 * np.log10(max(float(np.max(np.abs(audio))), 1e-9))
    logger.info("Master bus complete — sample peak %.2f dBFS", peak_db)
    return audio.astype(np.float32)
