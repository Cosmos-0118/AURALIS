"""Safeguard circuit — phase-correlation protection with width rollback."""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from auralis.dsp.ms import phase_correlation
from auralis.types import RenderPlan, StemEffectParams

logger = logging.getLogger(__name__)

PHASE_THRESHOLD = 0.15
ROLLBACK_FACTOR = 0.7
SPATIAL_STEMS = frozenset({"drums", "other"})


@dataclasses.dataclass
class SafeguardReport:
    """Outcome of the pre-master phase check."""

    tripped: bool = False
    mix_correlation: float = 1.0
    source_correlation: float = 1.0
    correlation_after: float | None = None
    rollback_factor: float | None = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def load_source_aligned(path: Path, target_sr: int, target_len: int) -> np.ndarray:
    """Load source audio resampled and length-matched to the stem sum."""
    audio, sr = sf.read(str(path), always_2d=True)
    stereo = audio.T.astype(np.float32)
    if stereo.ndim == 1:
        stereo = np.stack([stereo, stereo], axis=0)

    if sr != target_sr:
        stereo = np.stack([
            librosa.resample(stereo[0], orig_sr=sr, target_sr=target_sr),
            librosa.resample(stereo[1], orig_sr=sr, target_sr=target_sr),
        ])

    if stereo.shape[1] > target_len:
        stereo = stereo[:, :target_len]
    elif stereo.shape[1] < target_len:
        pad = np.zeros((2, target_len - stereo.shape[1]), dtype=np.float32)
        stereo = np.concatenate([stereo, pad], axis=1)

    return stereo.astype(np.float32)


def should_trip_safeguard(
    mix: np.ndarray,
    source_path: Path | None,
    sr: int,
) -> tuple[bool, float, float]:
    """
    Compare summed mix phase correlation against threshold and source reference.

    Trips when mix correlation < 0.15, or when widening collapsed correlation
    relative to an already-healthy source (>0.25 → mix < 35% of source).
    """
    mix_corr = phase_correlation(mix)
    source_corr = 1.0

    if source_path and source_path.exists():
        try:
            source = load_source_aligned(source_path, sr, mix.shape[1])
            source_corr = phase_correlation(source)
        except Exception as exc:
            logger.warning("Safeguard source load failed (%s); using mix-only check", exc)

    tripped = mix_corr < PHASE_THRESHOLD
    if not tripped and source_corr > 0.25:
        tripped = mix_corr < source_corr * 0.35

    return tripped, mix_corr, source_corr


def _scale_width_value(value: float, factor: float) -> float:
    """Scale width around unity so 1.0 stays neutral."""
    if value <= 1.0:
        return value
    return 1.0 + (value - 1.0) * factor


def _scale_envelope(
    keyframes: list[tuple[float, float]] | None,
    factor: float,
    *,
    width_style: bool = False,
) -> list[tuple[float, float]] | None:
    if not keyframes:
        return None
    if width_style:
        return [(t, _scale_width_value(v, factor)) for t, v in keyframes]
    return [(t, v * factor) for t, v in keyframes]


def apply_width_rollback(plan: RenderPlan, factor: float = ROLLBACK_FACTOR) -> RenderPlan:
    """
    Scale spatial intensity on drums/other by *factor*.

    Multiplies entire envelope arrays (preserving Kinetic arc shape) and scales
    static width / pan depth — not a hard ceiling clamp.
    """
    rolled: dict[str, StemEffectParams] = {}

    for stem, params in plan.stem_params.items():
        if stem not in SPATIAL_STEMS:
            rolled[stem] = params
            continue

        rolled[stem] = dataclasses.replace(
            params,
            stereo_width=_scale_width_value(params.stereo_width, factor),
            pan_depth=params.pan_depth * factor,
            width_envelope=_scale_envelope(params.width_envelope, factor, width_style=True),
            pan_depth_envelope=_scale_envelope(params.pan_depth_envelope, factor),
        )

    logger.warning(
        "Safeguard rollback: spatial stems scaled by %.0f%% (width + pan envelopes)",
        factor * 100,
    )
    return dataclasses.replace(plan, stem_params=rolled)
