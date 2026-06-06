"""Librosa analysis — extracts tempo, energy, and structure from source audio."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import librosa
import numpy as np

from auralis.types import SectionMarker, SongProfile

logger = logging.getLogger(__name__)


def analyze(input_path: Path, *, hop_length: int = 512) -> SongProfile:
    """Extract tempo, energy, sections, and genre hints from *input_path*."""
    input_path = input_path.resolve()
    logger.info("Analyzing %s", input_path.name)

    y, sr = librosa.load(str(input_path), sr=None, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length)
    bpm = float(np.atleast_1d(tempo)[0])

    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    avg_rms = float(np.mean(rms))
    peak = float(np.max(np.abs(y)))
    crest_factor = peak / avg_rms if avg_rms > 0 else 4.0

    sections: list[SectionMarker] = []
    try:
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop_length)
        bounds = librosa.segment.agglomerative(mfcc, k=6)
        bound_times = librosa.frames_to_time(bounds, sr=sr, hop_length=hop_length)
        for i in range(len(bound_times) - 1):
            start = float(bound_times[i])
            end = float(bound_times[i + 1])
            start_frame = librosa.time_to_frames(start, sr=sr, hop_length=hop_length)
            end_frame = librosa.time_to_frames(end, sr=sr, hop_length=hop_length)
            seg_energy = float(np.mean(rms[start_frame:end_frame]))
            label = _label_section(seg_energy, avg_rms, i, len(bound_times) - 1)
            sections.append(
                SectionMarker(label=label, start_sec=start, end_sec=end, energy=seg_energy)
            )
    except Exception as exc:
        logger.warning("Section detection failed, using single section: %s", exc)
        sections = [
            SectionMarker(label="body", start_sec=0.0, end_sec=duration, energy=avg_rms)
        ]

    drop_timestamps = _detect_drops(rms, sr, hop_length, threshold=avg_rms * 1.6)
    energy_curve = [float(v) for v in rms[:: max(1, len(rms) // 200)]]
    genre_hint, mood_hint = _classify_spectral(y, sr, crest_factor)

    profile = SongProfile(
        source=str(input_path),
        duration_sec=float(duration),
        sample_rate=int(sr),
        bpm=round(bpm, 1),
        genre_hint=genre_hint,
        mood_hint=mood_hint,
        avg_rms=avg_rms,
        crest_factor=crest_factor,
        sections=sections,
        energy_curve=energy_curve,
        drop_timestamps=drop_timestamps,
    )
    logger.info(
        "Profile: %.1f BPM, genre=%s, %d sections, %d drops",
        profile.bpm,
        profile.genre_hint,
        len(profile.sections),
        len(profile.drop_timestamps),
    )
    return profile


def save_profile(profile: SongProfile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile.to_dict(), indent=2), encoding="utf-8")
    logger.info("Wrote profile to %s", path)


def load_profile(path: Path) -> SongProfile:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    sections = [SectionMarker(**s) for s in data.pop("sections", [])]
    return SongProfile(sections=sections, **data)


def _label_section(energy: float, avg: float, index: int, total: int) -> str:
    if energy > avg * 1.45:
        return "drop" if index > 0 else "intro"
    if energy < avg * 0.75:
        return "breakdown"
    if index == total - 1:
        return "outro"
    return "verse" if index % 2 == 0 else "chorus"


def _detect_drops(
    rms: np.ndarray, sr: int, hop_length: int, *, threshold: float
) -> list[float]:
    drops: list[float] = []
    above = rms > threshold
    for i in range(1, len(above)):
        if above[i] and not above[i - 1]:
            t = float(librosa.frames_to_time(i, sr=sr, hop_length=hop_length))
            if not drops or (t - drops[-1]) > 8.0:
                drops.append(t)
    return drops


def _classify_spectral(y: np.ndarray, sr: int, crest_factor: float) -> tuple[str, str]:
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    S = np.abs(librosa.stft(y))
    freqs = librosa.fft_frequencies(sr=sr)
    bass_mask = freqs < 150
    high_mask = freqs > 5000
    total = float(np.sum(S))
    if total <= 0:
        return "Pop / Balanced", "Warm & Calibrated"

    bass_ratio = float(np.sum(S[bass_mask, :])) / total
    high_ratio = float(np.sum(S[high_mask, :])) / total

    if crest_factor > 5.2:
        return "Classical / Acoustic", "Pure Dynamic Range"
    if bass_ratio > 0.28:
        return "Electronic / Dance", "Heavy Sub Bass"
    if high_ratio > 0.12 or centroid > 3000:
        return "Rock / High-Energy", "Bright & Dynamic"
    if bass_ratio < 0.15 and high_ratio < 0.06:
        return "Acoustic / Vocal", "Intimate Centered"
    return "Pop / Balanced", "Warm Harmonized"
