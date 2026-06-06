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


def measure_integrated_lufs(audio: np.ndarray, sr: int) -> float | None:
    """Return integrated LUFS for *(channels, samples)* audio, or None if unmeterable."""
    if audio.size == 0:
        return None

    stereo = audio.T
    min_samples = max(int(sr * 0.4), 1)
    if stereo.shape[0] < min_samples:
        return None

    meter = pyln.Meter(sr)
    try:
        loudness = meter.integrated_loudness(stereo)
    except ValueError:
        return None

    if not np.isfinite(loudness):
        return None
    return float(loudness)


def resolve_lufs_target(profile_target: float, source_lufs: float | None) -> float:
    """
    Pick a mastering LUFS target that won't sit far below the source.

    Profile targets keep outputs consistent; source matching prevents YouTube /
    commercial masters from sounding deflated after processing.
    """
    if source_lufs is None:
        return profile_target

    matched = max(profile_target, source_lufs - 0.5)
    return min(matched, -9.0)


def stage_pre_master_gain(mix: np.ndarray, source: np.ndarray, sr: int) -> np.ndarray:
    """Recover level lost in stem separation / wet FX before the master bus."""
    mix_lufs = measure_integrated_lufs(mix, sr)
    src_lufs = measure_integrated_lufs(source, sr)

    if mix_lufs is not None and src_lufs is not None:
        delta_db = src_lufs - mix_lufs
        if delta_db > 1.0:
            gain_db = min(delta_db, 10.0)
            logger.info(
                "Pre-master LUFS staging: %.1f → %.1f LUFS (+%.1f dB)",
                mix_lufs,
                mix_lufs + gain_db,
                gain_db,
            )
            return (mix * (10.0 ** (gain_db / 20.0))).astype(np.float32)

    mix_peak = float(np.max(np.abs(mix)))
    src_peak = float(np.max(np.abs(source)))
    if mix_peak > 1e-9 and src_peak / mix_peak > 1.15:
        gain = min(src_peak / mix_peak, 3.162)
        logger.info("Pre-master peak staging: ×%.2f (%.1f dB)", gain, 20.0 * np.log10(gain))
        return (mix * gain).astype(np.float32)

    return mix


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


def master_process(
    mix: np.ndarray,
    sr: int,
    plan: RenderPlan,
    *,
    lufs_target: float | None = None,
) -> np.ndarray:
    """
    Final mastering chain after stem summing:

    1. Profile master gain + band limiting
    2. Gentle glue compression
    3. LUFS normalization (streaming parity / source-matched target)
    4. Brickwall limiter + true-peak ceiling
    5. Final LUFS touch-up after limiting
    """
    target = plan.master_lufs_target if lufs_target is None else lufs_target

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

    audio = normalize_lufs(audio, sr, target)

    limiter = Pedalboard([
        Limiter(
            threshold_db=plan.master_true_peak_db,
            release_ms=50.0,
        ),
    ])
    audio = limiter(audio, sr)
    audio = apply_true_peak_ceiling(audio, plan.master_true_peak_db)

    # Limiter pulls integrated loudness down — normalize once more, then ceiling.
    audio = normalize_lufs(audio, sr, target)
    audio = apply_true_peak_ceiling(audio, plan.master_true_peak_db)

    peak_db = 20.0 * np.log10(max(float(np.max(np.abs(audio))), 1e-9))
    out_lufs = measure_integrated_lufs(audio, sr)
    if out_lufs is not None:
        logger.info("Master bus complete — %.1f LUFS, sample peak %.2f dBFS", out_lufs, peak_db)
    else:
        logger.info("Master bus complete — sample peak %.2f dBFS", peak_db)
    return audio.astype(np.float32)
