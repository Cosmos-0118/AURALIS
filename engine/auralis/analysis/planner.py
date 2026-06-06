"""Render plan builder — maps SongProfile + output profile to per-stem DSP params."""

from __future__ import annotations

import dataclasses
import logging
from typing import Any

from auralis.analysis.kinetic import enrich_with_kinetic
from auralis.dsp.envelopes import coerce_envelope
from auralis.types import (
    OUTPUT_PROFILES,
    STEM_NAMES,
    RenderPlan,
    SongProfile,
    StemEffectParams,
    resolve_profile,
)

logger = logging.getLogger(__name__)

_STEM_FIELDS = {f.name for f in dataclasses.fields(StemEffectParams)}


def _stem_params(stem: str, **kwargs: Any) -> dict[str, Any]:
    return {"stem": stem, **kwargs}


def _base_plan() -> dict[str, dict[str, Any]]:
    """Safety-net defaults: vocals/bass anchored, spatial stems neutral."""
    return {
        "vocals": _stem_params(
            "vocals",
            center_lock=True,
            stereo_width=1.0,
            reverb_mix=0.0,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
        ),
        "bass": _stem_params(
            "bass",
            center_lock=True,
            stereo_width=0.0,
            reverb_mix=0.0,
            eq_low_db=0.0,
        ),
        "drums": _stem_params(
            "drums",
            stereo_width=1.0,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
            reverb_mix=0.0,
        ),
        "other": _stem_params(
            "other",
            stereo_width=1.0,
            reverb_mix=0.0,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
        ),
    }


def _deep_merge_stem(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    return {**base, **override}


def _dict_to_stem_params(stem: str, data: dict[str, Any]) -> StemEffectParams:
    kwargs = {k: v for k, v in data.items() if k in _STEM_FIELDS}
    kwargs["stem"] = stem
    for env_key in ("width_envelope", "reverb_mix_envelope", "pan_depth_envelope"):
        if env_key in kwargs:
            kwargs[env_key] = coerce_envelope(kwargs[env_key])
    return StemEffectParams(**kwargs)


def _merge_plans(
    base: dict[str, dict[str, Any]],
    profile_overrides: dict[str, dict[str, Any]],
) -> dict[str, StemEffectParams]:
    return {
        stem: _dict_to_stem_params(
            stem,
            _deep_merge_stem(base.get(stem, _stem_params(stem)), profile_overrides.get(stem, {})),
        )
        for stem in STEM_NAMES
    }


def _build_basshead_mode() -> dict[str, dict[str, Any]]:
    return {
        "bass": _stem_params(
            "bass",
            eq_low_hz=80.0,
            eq_low_db=6.0,
            tape_drive_db=5.0,
            comp_threshold_db=-12.0,
            comp_ratio=4.0,
            comp_attack_ms=8.0,
            comp_release_ms=120.0,
        ),
        "drums": _stem_params(
            "drums",
            eq_low_hz=60.0,
            eq_low_db=3.0,
            transient_shaping=True,
            stereo_width=1.2,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
        ),
        "vocals": _stem_params(
            "vocals",
            eq_low_hz=150.0,
            eq_low_db=-2.0,
            stereo_width=0.95,
            compressor_enabled=False,
        ),
        "other": _stem_params(
            "other",
            eq_low_hz=150.0,
            eq_low_db=-2.0,
            stereo_width=1.1,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
        ),
    }


def _build_cinema_mode() -> dict[str, dict[str, Any]]:
    return {
        "other": _stem_params(
            "other",
            reverb_room_size=0.9,
            reverb_damping=0.2,
            reverb_mix=0.4,
            stereo_width=2.5,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
        ),
        "drums": _stem_params(
            "drums",
            transient_shaping=True,
            elliptical_side_hpf_hz=200.0,
            comp_threshold_db=-18.0,
            comp_ratio=6.0,
            comp_attack_ms=4.0,
            comp_release_ms=90.0,
            stereo_width=1.35,
            reverb_room_size=0.6,
            reverb_damping=0.35,
            reverb_mix=0.12,
        ),
        "vocals": _stem_params(
            "vocals",
            vocal_air_db=1.5,
            reverb_room_size=0.4,
            reverb_damping=0.45,
            reverb_mix=0.1,
            stereo_width=1.0,
        ),
        "bass": _stem_params(
            "bass",
            eq_low_db=1.5,
            tape_drive_db=2.5,
            compressor_enabled=True,
            comp_threshold_db=-14.0,
            comp_ratio=3.0,
        ),
    }


def _build_concert_mode(bpm: float) -> dict[str, dict[str, Any]]:
    quarter_note_hz = (bpm / 60.0) / 4.0
    return {
        "drums": _stem_params(
            "drums",
            transient_shaping=True,
            elliptical_side_hpf_hz=200.0,
            reverb_room_size=0.8,
            reverb_damping=0.3,
            reverb_mix=0.3,
            stereo_width=1.45,
            pan_lfo_hz=quarter_note_hz,
            pan_depth=0.4,
            eq_high_db=1.0,
        ),
        "other": _stem_params(
            "other",
            reverb_room_size=0.8,
            reverb_damping=0.3,
            reverb_mix=0.3,
            stereo_width=1.65,
            pan_lfo_hz=quarter_note_hz * 0.85,
            pan_depth=0.4,
        ),
        "vocals": _stem_params(
            "vocals",
            vocal_air_db=2.0,
            eq_high_hz=4000.0,
            eq_high_db=2.0,
            eq_mid_db=1.0,
            reverb_room_size=0.55,
            reverb_damping=0.4,
            reverb_mix=0.08,
        ),
    }


def _build_audiophile_mode() -> dict[str, dict[str, Any]]:
    return {
        "vocals": _stem_params(
            "vocals",
            center_lock=True,
            stereo_width=1.0,
            reverb_mix=0.0,
            compressor_enabled=False,
            eq_mid_db=0.0,
            eq_high_db=0.0,
        ),
        "bass": _stem_params(
            "bass",
            center_lock=True,
            stereo_width=0.0,
            compressor_enabled=False,
        ),
        "drums": _stem_params(
            "drums",
            stereo_width=1.25,
            eq_high_hz=8000.0,
            eq_high_db=1.0,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
            reverb_mix=0.0,
            compressor_enabled=True,
            comp_threshold_db=-20.0,
            comp_ratio=2.0,
        ),
        "other": _stem_params(
            "other",
            stereo_width=1.25,
            eq_high_hz=8000.0,
            eq_high_db=1.0,
            pan_lfo_hz=0.0,
            pan_depth=0.0,
            reverb_mix=0.0,
            compressor_enabled=True,
            comp_threshold_db=-20.0,
            comp_ratio=2.0,
        ),
    }


def _build_hyper_immersive_mode(bpm: float) -> dict[str, dict[str, Any]]:
    pan_hz = (bpm / 60.0) * 0.15
    return {
        "bass": _stem_params(
            "bass",
            tape_drive_db=2.5,
        ),
        "drums": _stem_params(
            "drums",
            transient_shaping=True,
            elliptical_side_hpf_hz=200.0,
            stereo_width=1.55,
            reverb_room_size=0.65,
            reverb_damping=0.35,
            reverb_mix=0.18,
            pan_lfo_hz=pan_hz,
            pan_depth=0.55,
            eq_high_db=1.5,
        ),
        "other": _stem_params(
            "other",
            stereo_width=1.95,
            reverb_room_size=0.75,
            reverb_damping=0.28,
            reverb_mix=0.22,
            pan_lfo_hz=pan_hz * 0.75,
            pan_depth=0.75,
            eq_high_db=1.2,
        ),
        "vocals": _stem_params(
            "vocals",
            vocal_air_db=2.0,
            eq_mid_db=0.75,
            stereo_width=0.95,
            reverb_mix=0.05,
        ),
    }


def _build_zenith_mode(bpm: float) -> dict[str, dict[str, Any]]:
    pan_hz = (bpm / 60.0) * 0.125
    return {
        "vocals": _stem_params(
            "vocals",
            vocal_air_db=2.5,
            eq_mid_db=1.5,
            eq_high_db=1.0,
            stereo_width=0.95,
            reverb_room_size=0.35,
            reverb_damping=0.5,
            reverb_mix=0.04,
        ),
        "bass": _stem_params(
            "bass",
            eq_low_db=1.0,
            tape_drive_db=3.0,
            stereo_width=0.0,
        ),
        "drums": _stem_params(
            "drums",
            transient_shaping=True,
            elliptical_side_hpf_hz=200.0,
            eq_high_db=1.5,
            stereo_width=1.525,
            reverb_room_size=0.5,
            reverb_mix=0.12,
            pan_lfo_hz=pan_hz,
            pan_depth=0.65,
        ),
        "other": _stem_params(
            "other",
            eq_mid_db=0.5,
            eq_high_db=1.0,
            stereo_width=1.85,
            reverb_room_size=0.7,
            reverb_damping=0.25,
            reverb_mix=0.22,
            pan_lfo_hz=pan_hz * 0.7,
            pan_depth=0.85,
        ),
    }


_PROFILE_BUILDERS = {
    "audiophile": lambda bpm, _p: _build_audiophile_mode(),
    "basshead": lambda bpm, _p: _build_basshead_mode(),
    "cinema": lambda bpm, _p: _build_cinema_mode(),
    "concert": lambda bpm, _p: _build_concert_mode(bpm),
    "hyper_immersive": lambda bpm, _p: _build_hyper_immersive_mode(bpm),
    "zenith": lambda bpm, _p: _build_zenith_mode(bpm),
}


def _master_settings(profile_name: str, profile: SongProfile) -> tuple[float, float, float]:
    """
    Per-profile master bus: (glue_threshold_db, gain_db, lufs_target).

    LUFS targets align perceived loudness across profiles — Basshead runs hotter,
    Audiophile preserves dynamics.
    """
    bass_heavy = "electronic" in profile.genre_hint.lower() or "dance" in profile.genre_hint.lower()
    settings: dict[str, tuple[float, float, float]] = {
        "audiophile": (-2.0, 0.0, -16.0),
        "basshead": (-1.0, 0.5, -11.5),
        "cinema": (-2.0, 0.0, -14.0),
        "concert": (-1.5, 0.25, -13.0),
        "hyper_immersive": (-1.0, 0.0, -13.5),
        "zenith": (-1.0, 0.5 if bass_heavy else 0.0, -14.0),
    }
    return settings.get(profile_name, (-1.0, 0.0, -14.0))


def _tune_micro_detail(
    stem_params: dict[str, StemEffectParams],
    profile: SongProfile,
) -> dict[str, StemEffectParams]:
    """
    Profile definitions own micro-detail defaults; Librosa RMS nudges transient
    thresholds so quiet masters still punch and loud masters don't over-squash.
    """
    ref_rms = 0.1
    offset_db = float(max(-4.0, min(4.0, (ref_rms - profile.avg_rms) * 35.0)))

    tuned: dict[str, StemEffectParams] = {}
    for stem, params in stem_params.items():
        if params.transient_shaping:
            tuned[stem] = dataclasses.replace(
                params,
                transient_threshold_db=params.transient_threshold_db + offset_db,
            )
        else:
            tuned[stem] = params
    return tuned


def build_render_plan(profile: SongProfile, profile_name: str = "audiophile") -> RenderPlan:
    """
    Dictionary-based profile router (LLM hook point).

    Merges per-profile stem overrides onto anchored base defaults.
    """
    profile_name = resolve_profile(profile_name)
    if profile_name not in OUTPUT_PROFILES:
        raise ValueError(f"Unknown profile '{profile_name}'. Choose from {OUTPUT_PROFILES}")

    bpm = max(profile.bpm, 60.0)
    builder = _PROFILE_BUILDERS.get(profile_name, _PROFILE_BUILDERS["zenith"])
    stem_params = _merge_plans(_base_plan(), builder(bpm, profile))
    stem_params = _tune_micro_detail(stem_params, profile)
    stem_params = enrich_with_kinetic(stem_params, profile, profile_name)
    glue_db, master_gain, lufs_target = _master_settings(profile_name, profile)

    return RenderPlan(
        profile_name=profile_name,
        stem_params=stem_params,
        master_gain_db=master_gain,
        master_glue_threshold_db=glue_db,
        master_lufs_target=lufs_target,
        master_limiter_db=glue_db,
    )
