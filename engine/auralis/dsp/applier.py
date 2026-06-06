"""Pedalboard-based stem DSP and final mixdown (Applier)."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import soundfile as sf
from pedalboard import (
    Compressor,
    Gain,
    HighShelfFilter,
    HighpassFilter,
    LowpassFilter,
    LowShelfFilter,
    Pedalboard,
    PeakFilter,
    Reverb,
)

from auralis.types import RenderPlan, StemPaths

logger = logging.getLogger(__name__)


def _build_stem_board(params) -> Pedalboard:
    """Construct a Pedalboard chain for one stem from StemEffectParams."""
    board: list = []

    if params.eq_low_db:
        board.append(
            LowShelfFilter(
                cutoff_frequency_hz=params.eq_low_hz,
                gain_db=params.eq_low_db,
            )
        )
    if params.eq_mid_db:
        board.append(
            PeakFilter(
                cutoff_frequency_hz=params.eq_mid_hz,
                gain_db=params.eq_mid_db,
                q=0.8,
            )
        )
    if params.eq_high_db:
        board.append(
            HighShelfFilter(
                cutoff_frequency_hz=params.eq_high_hz,
                gain_db=params.eq_high_db,
            )
        )

    if params.reverb_mix > 0:
        board.append(
            Reverb(
                room_size=params.reverb_room_size,
                damping=params.reverb_damping,
                wet_level=params.reverb_mix,
                dry_level=max(0.0, 1.0 - params.reverb_mix),
            )
        )

    if params.gain_db:
        board.append(Gain(gain_db=params.gain_db))

    if params.compressor_enabled:
        board.append(
            Compressor(
                threshold_db=params.comp_threshold_db,
                ratio=params.comp_ratio,
                attack_ms=params.comp_attack_ms,
                release_ms=params.comp_release_ms,
            )
        )

    return Pedalboard(board) if board else Pedalboard([])


def _apply_stereo_width(audio: np.ndarray, width: float) -> np.ndarray:
    """Simple M/S width control. width=1.0 is neutral; >1 widens."""
    if audio.ndim == 1:
        return audio
    if width <= 0.01:
        mono = np.mean(audio, axis=0, keepdims=True)
        return np.repeat(mono, 2, axis=0)

    left, right = audio[0], audio[1]
    mid = (left + right) * 0.5
    side = (left - right) * 0.5 * width
    out = np.stack([mid + side, mid - side], axis=0)
    return out.astype(np.float32)


def _apply_pan_lfo(audio: np.ndarray, sr: int, hz: float, depth: float) -> np.ndarray:
    """Beat-synced auto-pan on stereo stems only."""
    if audio.ndim == 1 or hz <= 0 or depth <= 0:
        return audio

    n = audio.shape[1]
    t = np.arange(n, dtype=np.float32) / sr
    pan = depth * np.sin(2 * np.pi * hz * t)
    left_gain = np.clip(1.0 - pan, 0.0, 1.5)
    right_gain = np.clip(1.0 + pan, 0.0, 1.5)

    out = audio.copy()
    out[0] *= left_gain
    out[1] *= right_gain
    return out.astype(np.float32)


def _load_stem(path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(str(path), always_2d=True)
    return audio.T.astype(np.float32), sr


def _ensure_stereo(audio: np.ndarray) -> np.ndarray:
    if audio.ndim == 1:
        return np.stack([audio, audio], axis=0)
    return audio


def process_stem(path: Path, params, *, output_path: Path | None = None) -> tuple[np.ndarray, int]:
    audio, sr = _load_stem(path)
    audio = _ensure_stereo(audio)

    if params.center_lock:
        mono = np.mean(audio, axis=0, keepdims=True)
        audio = np.repeat(mono, 2, axis=0)

    board = _build_stem_board(params)
    if len(board) > 0:
        audio = board(audio, sr)

    audio = _apply_stereo_width(audio, params.stereo_width)
    audio = _apply_pan_lfo(audio, sr, params.pan_lfo_hz, params.pan_depth)

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), audio.T, sr, subtype="PCM_24")
        logger.info("Wrote processed stem: %s", output_path.name)

    return audio, sr


def mixdown(stem_buffers: dict[str, np.ndarray], sr: int, plan: RenderPlan) -> np.ndarray:
    """Sum processed stems and apply light master gain."""
    if not stem_buffers:
        raise ValueError("No stems to mix")

    max_len = max(buf.shape[1] for buf in stem_buffers.values())
    mix = np.zeros((2, max_len), dtype=np.float32)

    for buf in stem_buffers.values():
        padded = np.zeros((2, max_len), dtype=np.float32)
        padded[:, : buf.shape[1]] = _ensure_stereo(buf)
        mix += padded

    master = Pedalboard([
        Gain(gain_db=plan.master_gain_db),
        HighpassFilter(cutoff_frequency_hz=30.0),
        LowpassFilter(cutoff_frequency_hz=18000.0),
        Compressor(
            threshold_db=plan.master_limiter_db,
            ratio=4.0,
            attack_ms=3,
            release_ms=100,
        ),
    ])
    return master(mix, sr)


def render(
    stems: StemPaths,
    plan: RenderPlan,
    output_path: Path,
    *,
    work_dir: Path | None = None,
    keep_stems: bool = False,
) -> Path:
    """
    Apply per-stem FX from *plan*, mix down, and write *output_path*.
    """
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    processed_dir = (work_dir / "processed") if work_dir else None
    stem_buffers: dict[str, np.ndarray] = {}
    sample_rate: int | None = None

    for name in ("vocals", "drums", "bass", "other"):
        stem_path = getattr(stems, name)
        params = plan.stem_params[name]
        out_stem = processed_dir / f"{name}.wav" if (keep_stems and processed_dir) else None
        audio, sr = process_stem(stem_path, params, output_path=out_stem)
        stem_buffers[name] = audio
        sample_rate = sr

    assert sample_rate is not None
    mixed = mixdown(stem_buffers, sample_rate, plan)
    sf.write(str(output_path), mixed.T, sample_rate, subtype="PCM_24")
    logger.info("Final mix written to %s", output_path)
    return output_path
