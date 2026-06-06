"""Pedalboard-based stem DSP and final mixdown (Applier)."""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path

import numpy as np
import soundfile as sf
from pedalboard import (
    Compressor,
    Distortion,
    Gain,
    HighShelfFilter,
    HighpassFilter,
    LowpassFilter,
    LowShelfFilter,
    Pedalboard,
    PeakFilter,
    Reverb,
)

from auralis.dsp.envelopes import envelope_to_samples
from auralis.dsp.master_bus import master_process, measure_integrated_lufs, resolve_lufs_target, stage_pre_master_gain
from auralis.dsp.ms import apply_elliptical_filter, phase_correlation
from auralis.dsp.safeguard import (
    ROLLBACK_FACTOR,
    SPATIAL_STEMS,
    SafeguardReport,
    apply_width_rollback,
    should_trip_safeguard,
)
from auralis.types import RenderPlan, StemPaths

logger = logging.getLogger(__name__)


@dataclasses.dataclass
class RenderOutcome:
    """Full render result for scoring and job metadata."""

    path: Path
    safeguard: SafeguardReport
    stem_buffers: dict[str, np.ndarray]
    mastered: np.ndarray
    sample_rate: int


def _append_micro_detail(board: list, params) -> None:
    """Phase 2 tone shaping — saturation, transient punch, vocal air."""
    if params.stem == "bass" and params.tape_drive_db > 0:
        board.append(Distortion(drive_db=params.tape_drive_db))

    if params.stem == "drums" and params.transient_shaping:
        board.append(
            Compressor(
                threshold_db=params.transient_threshold_db,
                ratio=params.transient_ratio,
                attack_ms=params.transient_attack_ms,
                release_ms=params.transient_release_ms,
            )
        )

    if params.stem == "vocals" and params.vocal_air_db > 0:
        board.append(
            HighShelfFilter(
                cutoff_frequency_hz=params.vocal_air_hz,
                gain_db=params.vocal_air_db,
            )
        )


def _build_tone_board(params, *, include_reverb: bool = False, reverb_wet: float = 1.0) -> Pedalboard:
    """EQ / micro-detail / dynamics chain. Reverb optional for parallel wet bus."""
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

    _append_micro_detail(board, params)

    if include_reverb and reverb_wet > 0:
        board.append(
            Reverb(
                room_size=params.reverb_room_size,
                damping=params.reverb_damping,
                wet_level=reverb_wet,
                dry_level=0.0,
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


def _apply_stereo_width(audio: np.ndarray, width: float | np.ndarray) -> np.ndarray:
    """M/S width. *width* may be scalar or per-sample curve."""
    if audio.ndim == 1:
        return audio

    scalar_width = np.isscalar(width)
    effective = float(width) if scalar_width else float(np.max(width))
    if effective <= 0.01:
        mono = np.mean(audio, axis=0, keepdims=True)
        return np.repeat(mono, 2, axis=0).astype(np.float32)

    left, right = audio[0], audio[1]
    mid = (left + right) * 0.5
    side = (left - right) * 0.5
    if scalar_width:
        side = side * effective
    else:
        side = side * width
    return np.stack([mid + side, mid - side], axis=0).astype(np.float32)


def _apply_pan_lfo(
    audio: np.ndarray,
    sr: int,
    hz: float,
    depth: float | np.ndarray,
) -> np.ndarray:
    """Beat-synced auto-pan. *depth* may be scalar or per-sample envelope."""
    if audio.ndim == 1 or hz <= 0:
        return audio

    n = audio.shape[1]
    t = np.arange(n, dtype=np.float32) / sr
    if np.isscalar(depth):
        if depth <= 0:
            return audio
        pan = float(depth) * np.sin(2 * np.pi * hz * t)
    else:
        pan = depth * np.sin(2 * np.pi * hz * t)

    left_gain = np.clip(1.0 - pan, 0.0, 1.5)
    right_gain = np.clip(1.0 + pan, 0.0, 1.5)

    out = audio.copy()
    out[0] *= left_gain
    out[1] *= right_gain
    return out.astype(np.float32)


def _mix_dry_wet(
    dry: np.ndarray,
    wet: np.ndarray,
    wet_gain: np.ndarray,
) -> np.ndarray:
    """Per-sample crossfade — phase-coherent parallel reverb bus."""
    dry_gain = 1.0 - wet_gain
    if dry.ndim == 1:
        return (dry * dry_gain + wet * wet_gain).astype(np.float32)
    return (dry * dry_gain + wet * wet_gain).astype(np.float32)


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

    n = audio.shape[1]
    uses_reverb = params.reverb_mix > 0 or bool(params.reverb_mix_envelope)
    uses_width_automation = bool(params.width_envelope)
    uses_pan_automation = bool(params.pan_depth_envelope) and params.pan_lfo_hz > 0

    dry_board = _build_tone_board(params, include_reverb=False)
    if len(dry_board) > 0:
        dry = dry_board(audio, sr)
    else:
        dry = audio.copy()

    if uses_reverb:
        wet_board = _build_tone_board(params, include_reverb=True, reverb_wet=1.0)
        wet = wet_board(audio, sr) if len(wet_board) > 0 else dry.copy()
        wet_curve = envelope_to_samples(
            params.reverb_mix_envelope,
            params.reverb_mix,
            n,
            sr,
        )
        wet_curve = np.clip(wet_curve, 0.0, 1.0)
        audio = _mix_dry_wet(dry, wet, wet_curve)
    else:
        audio = dry

    if uses_width_automation:
        width_curve = envelope_to_samples(
            params.width_envelope,
            params.stereo_width,
            n,
            sr,
        )
        audio = _apply_stereo_width(audio, width_curve)
    else:
        audio = _apply_stereo_width(audio, params.stereo_width)

    if uses_pan_automation:
        depth_curve = envelope_to_samples(
            params.pan_depth_envelope,
            params.pan_depth,
            n,
            sr,
        )
        audio = _apply_pan_lfo(audio, sr, params.pan_lfo_hz, depth_curve)
    else:
        audio = _apply_pan_lfo(audio, sr, params.pan_lfo_hz, params.pan_depth)

    if params.elliptical_side_hpf_hz > 0:
        audio = apply_elliptical_filter(audio, sr, side_hpf_hz=params.elliptical_side_hpf_hz)

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), audio.T, sr, subtype="PCM_24")
        logger.info("Wrote processed stem: %s", output_path.name)

    return audio, sr


def sum_stems(stem_buffers: dict[str, np.ndarray]) -> np.ndarray:
    """Sum processed stem buffers into a stereo mix (pre-master)."""
    if not stem_buffers:
        raise ValueError("No stems to mix")

    max_len = max(buf.shape[1] for buf in stem_buffers.values())
    mix = np.zeros((2, max_len), dtype=np.float32)

    for buf in stem_buffers.values():
        padded = np.zeros((2, max_len), dtype=np.float32)
        padded[:, : buf.shape[1]] = _ensure_stereo(buf)
        mix += padded

    return mix


def _process_all_stems(
    stems: StemPaths,
    plan: RenderPlan,
    *,
    work_dir: Path | None,
    keep_stems: bool,
    only: frozenset[str] | None = None,
    stem_buffers: dict[str, np.ndarray] | None = None,
) -> tuple[dict[str, np.ndarray], int]:
    """Process stems from *plan*; optionally re-render a subset into existing buffers."""
    processed_dir = (work_dir / "processed") if work_dir else None
    buffers = dict(stem_buffers or {})
    sample_rate: int | None = None
    targets = only or frozenset({"vocals", "drums", "bass", "other"})

    for name in ("vocals", "drums", "bass", "other"):
        if name not in targets:
            continue
        stem_path = getattr(stems, name)
        params = plan.stem_params[name]
        out_stem = processed_dir / f"{name}.wav" if (keep_stems and processed_dir) else None
        audio, sr = process_stem(stem_path, params, output_path=out_stem)
        buffers[name] = audio
        sample_rate = sr

    assert sample_rate is not None
    return buffers, sample_rate


def mixdown(stem_buffers: dict[str, np.ndarray], sr: int, plan: RenderPlan) -> np.ndarray:
    """Sum processed stems and run the master bus (LUFS + true-peak limit)."""
    return master_process(sum_stems(stem_buffers), sr, plan)


def render(
    stems: StemPaths,
    plan: RenderPlan,
    output_path: Path,
    *,
    work_dir: Path | None = None,
    keep_stems: bool = False,
    source_path: Path | None = None,
) -> RenderOutcome:
    """Apply per-stem FX, safeguard check, master bus, and write *output_path*."""
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    source = source_path or Path(stems.source_track) if stems.source_track else None
    report = SafeguardReport()

    stem_buffers, sample_rate = _process_all_stems(
        stems, plan, work_dir=work_dir, keep_stems=keep_stems
    )
    pre_master = sum_stems(stem_buffers)

    tripped, mix_corr, source_corr = should_trip_safeguard(pre_master, source, sample_rate)
    report.mix_correlation = mix_corr
    report.source_correlation = source_corr

    active_plan = plan
    if tripped:
        report.tripped = True
        report.rollback_factor = ROLLBACK_FACTOR
        active_plan = apply_width_rollback(plan, ROLLBACK_FACTOR)
        stem_buffers, sample_rate = _process_all_stems(
            stems,
            active_plan,
            work_dir=work_dir,
            keep_stems=keep_stems,
            only=SPATIAL_STEMS,
            stem_buffers=stem_buffers,
        )
        pre_master = sum_stems(stem_buffers)
        report.correlation_after = phase_correlation(pre_master)
        logger.warning(
            "Safeguard tripped: mix_corr=%.3f source_corr=%.3f → after rollback=%.3f",
            mix_corr,
            source_corr,
            report.correlation_after,
        )

    source_audio: np.ndarray | None = None
    source_lufs: float | None = None
    if source and source.exists():
        try:
            source_audio, _ = _load_stem(source)
            source_lufs = measure_integrated_lufs(source_audio, sample_rate)
            if source_lufs is not None:
                logger.info("Source integrated loudness: %.1f LUFS", source_lufs)
        except Exception as exc:
            logger.warning("Could not measure source loudness: %s", exc)

    lufs_target = resolve_lufs_target(active_plan.master_lufs_target, source_lufs)
    if source_lufs is not None and lufs_target > active_plan.master_lufs_target:
        logger.info(
            "LUFS target raised: %.1f → %.1f (source %.1f LUFS)",
            active_plan.master_lufs_target,
            lufs_target,
            source_lufs,
        )

    if source_audio is not None:
        pre_master = stage_pre_master_gain(pre_master, source_audio, sample_rate)

    mastered = master_process(pre_master, sample_rate, active_plan, lufs_target=lufs_target)
    sf.write(str(output_path), mastered.T, sample_rate, subtype="PCM_24")
    logger.info("Final mix written to %s", output_path)
    return RenderOutcome(
        path=output_path,
        safeguard=report,
        stem_buffers=stem_buffers,
        mastered=mastered,
        sample_rate=sample_rate,
    )
