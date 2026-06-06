"""
Kinetic Engine — section-adaptive parameter envelopes.

Derives motion from Librosa energy analysis: soundstage width, reverb wetness,
and pan depth breathe with the track's verse / build / drop arc. Decouples
time-domain classification from static profile peaks in the planner.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Literal

from auralis.types import SectionMarker, SongProfile, StemEffectParams

logger = logging.getLogger(__name__)

Envelope = list[tuple[float, float]]

KINETIC_PROFILES = frozenset({"zenith", "concert", "cinema", "hyper_immersive"})

AUTOMATED_STEMS = frozenset({"drums", "other"})

_VALLEY_RATIO: dict[str, float] = {
    "stereo_width": 0.62,
    "reverb_mix": 0.12,
    "pan_depth": 0.18,
}

_BUILD_LABELS = frozenset({"chorus", "verse"})
_DROP_LABELS = frozenset({"drop"})
_INTIMATE_LABELS = frozenset({"intro", "verse", "breakdown", "outro", "body"})

RAMP_SEC = 4.0
DROP_HOLD_SEC = 12.0
DECAY_SEC = 6.0
SNAP_SEC = 0.04


def enrich_with_kinetic(
    stem_params: dict[str, StemEffectParams],
    profile: SongProfile,
    profile_name: str,
) -> dict[str, StemEffectParams]:
    """Attach Kinetic Engine envelopes to immersive-profile spatial stems."""
    if profile_name not in KINETIC_PROFILES:
        return stem_params

    enriched: dict[str, StemEffectParams] = {}
    for stem, params in stem_params.items():
        if stem not in AUTOMATED_STEMS or params.center_lock:
            enriched[stem] = params
            continue

        envelopes = build_stem_envelopes(profile, params, profile_name)
        if not envelopes:
            enriched[stem] = params
            continue

        enriched[stem] = dataclasses.replace(params, **envelopes)

    logger.info(
        "Kinetic Engine envelopes applied (profile=%s, stems=%s)",
        profile_name,
        [s for s, p in enriched.items() if p.has_automation()],
    )
    return enriched


def build_stem_envelopes(
    profile: SongProfile,
    params: StemEffectParams,
    profile_name: str,
) -> dict[str, Envelope]:
    """Build width / reverb / pan keyframes from analysis metadata."""
    peaks = {
        "stereo_width": params.stereo_width,
        "reverb_mix": _drop_reverb_peak(params, profile_name),
        "pan_depth": params.pan_depth,
    }
    valleys = {k: _valley_value(k, v, profile_name) for k, v in peaks.items()}

    width_kf = _compose_envelope(
        profile,
        peaks["stereo_width"],
        valleys["stereo_width"],
        profile_name=profile_name,
    )
    reverb_kf = _compose_envelope(
        profile,
        peaks["reverb_mix"],
        valleys["reverb_mix"],
        profile_name=profile_name,
        snap=True,
    )
    if params.stem == "other":
        reverb_kf = _apply_density_ducking(reverb_kf, profile, peaks["reverb_mix"], valleys["reverb_mix"])
    pan_kf = _compose_envelope(
        profile,
        peaks["pan_depth"],
        valleys["pan_depth"],
        profile_name=profile_name,
    )

    result: dict[str, Envelope] = {}
    if _is_dynamic(width_kf, peaks["stereo_width"], valleys["stereo_width"]):
        result["width_envelope"] = width_kf
    if _is_dynamic(reverb_kf, peaks["reverb_mix"], valleys["reverb_mix"]):
        result["reverb_mix_envelope"] = reverb_kf
    if params.pan_lfo_hz > 0 and _is_dynamic(pan_kf, peaks["pan_depth"], valleys["pan_depth"]):
        result["pan_depth_envelope"] = pan_kf

    return result


def _energy_ratio_at(profile: SongProfile, time_sec: float) -> float:
    """Section energy relative to track average at *time_sec*."""
    if profile.avg_rms <= 0:
        return 1.0
    for section in profile.sections:
        if section.start_sec <= time_sec < section.end_sec:
            return section.energy / profile.avg_rms
    return 1.0


def _apply_density_ducking(
    keyframes: Envelope,
    profile: SongProfile,
    peak: float,
    valley: float,
) -> Envelope:
    """
    Inverse reverb envelope — dense sections dip wetness, sparse sections bloom.

    Prevents muddy choruses while keeping verse/drop space expansive.
    """
    if len(keyframes) < 2:
        return keyframes

    dense_wet_floor = max(0.08, peak * 0.25)
    adjusted: list[tuple[float, float, str]] = []

    for t, v in keyframes:
        ratio = _energy_ratio_at(profile, t)
        if ratio >= 1.15:
            duck = max(0.22, 0.55 - (ratio - 1.15) * 0.35)
            v = max(dense_wet_floor, v * duck)
        elif ratio <= 0.85:
            v = min(peak, v * 1.2)
        adjusted.append((t, v, "hold"))

    return _merge_keyframes(adjusted, profile.duration_sec)


def _drop_reverb_peak(params: StemEffectParams, profile_name: str) -> float:
    """Drop reverb can exceed the static planner mix for immersive impact."""
    base = params.reverb_mix
    boosts = {
        "zenith": 0.40,
        "cinema": 0.45,
        "concert": 0.35,
        "hyper_immersive": 0.30,
    }
    return max(base, boosts.get(profile_name, base))


def _valley_value(param: str, peak: float, profile_name: str) -> float:
    ratio = _VALLEY_RATIO[param]
    if profile_name == "cinema" and param == "stereo_width":
        ratio = 0.55
    if param == "reverb_mix":
        return max(0.04, peak * ratio)
    if param == "pan_depth":
        return peak * ratio if peak > 0 else 0.0
    return max(0.85, peak * ratio)


def _compose_envelope(
    profile: SongProfile,
    peak: float,
    valley: float,
    *,
    profile_name: str,
    snap: bool = False,
) -> Envelope:
    """Merge section labels, energy curve, and drop timestamps into keyframes."""
    duration = max(profile.duration_sec, 0.1)
    keyframes: list[tuple[float, float, Literal["hold", "ramp", "snap"]]] = [
        (0.0, valley, "hold"),
    ]

    for section in profile.sections:
        keyframes.extend(_section_keyframes(section, profile.avg_rms, peak, valley))

    for drop_t in profile.drop_timestamps:
        keyframes.extend(_drop_keyframes(drop_t, duration, peak, valley, snap=snap))

    if len(keyframes) <= 1:
        keyframes.append((duration, valley, "hold"))

    merged = _merge_keyframes(keyframes, duration)
    merged = _inject_build_ramps(merged, profile, peak, valley)

    if profile_name in ("zenith", "hyper_immersive"):
        merged = _ensure_drop_contrast(
            merged,
            profile.drop_timestamps,
            profile.duration_sec,
            peak,
            valley,
        )

    return merged


def _section_keyframes(
    section: SectionMarker,
    avg_rms: float,
    peak: float,
    valley: float,
) -> list[tuple[float, float, str]]:
    energy_ratio = section.energy / avg_rms if avg_rms > 0 else 1.0
    label = section.label.lower()

    if label in _DROP_LABELS or energy_ratio >= 1.45:
        target = peak
    elif label in _INTIMATE_LABELS or energy_ratio <= 0.8:
        target = valley
    elif label in _BUILD_LABELS or energy_ratio >= 1.05:
        target = valley + (peak - valley) * 0.45
    else:
        target = valley + (peak - valley) * 0.25

    return [
        (section.start_sec, target, "ramp"),
        (section.end_sec, target, "hold"),
    ]


def _drop_keyframes(
    drop_t: float,
    duration: float,
    peak: float,
    valley: float,
    *,
    snap: bool,
) -> list[tuple[float, float, str]]:
    drop_t = max(0.0, min(drop_t, duration))
    ramp_start = max(0.0, drop_t - RAMP_SEC)
    hold_end = min(duration, drop_t + DROP_HOLD_SEC)
    decay_end = min(duration, hold_end + DECAY_SEC)

    points: list[tuple[float, float, str]] = [
        (ramp_start, valley, "ramp"),
    ]
    if snap:
        points.append((max(0.0, drop_t - SNAP_SEC), valley, "hold"))
        points.append((drop_t, peak, "snap"))
    else:
        points.append((drop_t, peak, "ramp"))
    points.extend([
        (hold_end, peak, "hold"),
        (decay_end, valley, "ramp"),
    ])
    return points


def _merge_keyframes(
    points: list[tuple[float, float, str]],
    duration: float,
) -> Envelope:
    """Sort by time; at duplicate timestamps keep the loudest spatial value."""
    by_time: dict[float, float] = {}
    for t, v, _mode in sorted(points, key=lambda p: p[0]):
        t = round(max(0.0, min(t, duration)), 4)
        by_time[t] = max(by_time.get(t, v), v) if t in by_time else v

    if 0.0 not in by_time:
        by_time[0.0] = next(iter(by_time.values())) if by_time else 1.0
    if duration not in by_time:
        by_time[duration] = list(by_time.values())[-1]

    return sorted((t, v) for t, v in by_time.items())


def _inject_build_ramps(
    keyframes: Envelope,
    profile: SongProfile,
    peak: float,
    valley: float,
) -> Envelope:
    """Add gradual opens before detected energy climbs."""
    if len(keyframes) < 2:
        return keyframes

    extra: Envelope = []
    for i in range(1, len(keyframes)):
        t_prev, v_prev = keyframes[i - 1]
        t_curr, v_curr = keyframes[i]
        if v_curr > v_prev + 0.08 and (t_curr - t_prev) >= RAMP_SEC * 1.5:
            mid_t = max(t_prev, t_curr - RAMP_SEC)
            mid_v = valley + (v_curr - valley) * 0.55
            extra.append((mid_t, mid_v))

    if not extra:
        return keyframes

    merged = _merge_keyframes(
        [(t, v, "ramp") for t, v in keyframes] + [(t, v, "ramp") for t, v in extra],
        profile.duration_sec,
    )
    return merged


def _ensure_drop_contrast(
    keyframes: Envelope,
    drop_times: list[float],
    duration: float,
    peak: float,
    valley: float,
) -> Envelope:
    """Guarantee drops hit full peak even if section labels were conservative."""
    if not drop_times:
        return keyframes

    extra: list[tuple[float, float, str]] = []
    for drop_t in drop_times:
        extra.extend(_drop_keyframes(drop_t, duration, peak, valley, snap=True))

    return _merge_keyframes(
        [(t, v, "hold") for t, v in keyframes] + extra,
        duration,
    )


def _is_dynamic(keyframes: Envelope, peak: float, valley: float) -> bool:
    if len(keyframes) < 2:
        return False
    spread = max(v for _, v in keyframes) - min(v for _, v in keyframes)
    return spread > max(0.05, abs(peak - valley) * 0.15)
