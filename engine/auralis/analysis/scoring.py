"""Zenith AI Score — post-render quality metrics for the UI."""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path

import numpy as np

from auralis.dsp.ms import phase_correlation
from auralis.dsp.safeguard import SafeguardReport, load_source_aligned
from auralis.types import RenderPlan

logger = logging.getLogger(__name__)


@dataclasses.dataclass
class AiScore:
    immersion: int
    clarity: int
    punch: int
    warmth: int

    def to_dict(self) -> dict[str, int]:
        return dataclasses.asdict(self)


def _ms_ratio(audio: np.ndarray) -> float:
    """Side RMS / Mid RMS — higher means wider soundstage."""
    if audio.ndim == 1:
        return 0.0
    mid = (audio[0] + audio[1]) * 0.5
    side = (audio[0] - audio[1]) * 0.5
    mid_rms = float(np.sqrt(np.mean(mid**2)))
    side_rms = float(np.sqrt(np.mean(side**2)))
    if mid_rms <= 1e-9:
        return 0.0
    return side_rms / mid_rms


def _clamp_score(value: float) -> int:
    return int(round(max(0.0, min(100.0, value))))


def _score_immersion(
    source: np.ndarray | None,
    output: np.ndarray,
    safeguard: SafeguardReport,
) -> int:
    out_ratio = _ms_ratio(output)
    in_ratio = _ms_ratio(source) if source is not None else out_ratio

    if in_ratio <= 1e-9:
        mult = 1.0
    else:
        mult = out_ratio / in_ratio

    # identity → 50, 2× wider → 90
    score = 50.0 + (mult - 1.0) * 40.0
    if safeguard.tripped:
        score = min(score, 85.0)

    return _clamp_score(score)


def _score_clarity(plan: RenderPlan, safeguard: SafeguardReport) -> int:
    corr = (
        safeguard.correlation_after
        if safeguard.correlation_after is not None
        else safeguard.mix_correlation
    )
    # 1.0 → 100, 0.3 → 70
    score = 70.0 + ((corr - 0.3) / 0.7) * 30.0

    vocals = plan.stem_params.get("vocals")
    if vocals and vocals.vocal_air_db > 0:
        score += 5.0

    return _clamp_score(score)


def _score_punch(drums: np.ndarray) -> int:
    mono = drums[0] if drums.ndim > 1 else drums
    peak = float(np.max(np.abs(mono)))
    rms = float(np.sqrt(np.mean(mono**2)))
    if rms <= 1e-9:
        return 50

    crest = peak / rms
    # crest 4 → 50, crest 10+ → 95
    score = 50.0 + ((crest - 4.0) / 6.0) * 45.0
    return _clamp_score(score)


def _score_warmth(plan: RenderPlan) -> int:
    bass = plan.stem_params.get("bass")
    if not bass:
        return 45

    score = 45.0
    score += bass.tape_drive_db * 8.0
    score += max(0.0, bass.eq_low_db) * 3.0
    return _clamp_score(min(score, 98.0))


def compute_ai_score(
    *,
    output: np.ndarray,
    drums: np.ndarray,
    plan: RenderPlan,
    safeguard: SafeguardReport,
    source_path: Path | None = None,
    sample_rate: int,
) -> AiScore:
    """Derive 0–100 Immersion / Clarity / Punch / Warmth from post-render arrays."""
    source: np.ndarray | None = None
    if source_path and source_path.exists():
        try:
            source = load_source_aligned(source_path, sample_rate, output.shape[1])
        except Exception as exc:
            logger.warning("AI score source load failed: %s", exc)

    score = AiScore(
        immersion=_score_immersion(source, output, safeguard),
        clarity=_score_clarity(plan, safeguard),
        punch=_score_punch(drums),
        warmth=_score_warmth(plan),
    )
    logger.info(
        "Zenith AI Score — immersion=%d clarity=%d punch=%d warmth=%d",
        score.immersion,
        score.clarity,
        score.punch,
        score.warmth,
    )
    return score
