"""Demucs-based stem separation (Deserializer)."""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys
from pathlib import Path

from auralis.types import STEM_NAMES, StemPaths

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "htdemucs"


def resolve_device(requested: str | None = None) -> str:
    """
    Pick the best Demucs device. Defaults to MPS on Apple Silicon, else CPU.

    Pass ``"cuda"``, ``"mps"``, or ``"cpu"`` to override auto-detection.
    """
    if requested:
        return requested

    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        logger.warning("torch not installed; falling back to cpu")
    return "cpu"


def _track_stem_dir(output_root: Path, model: str, track_name: str) -> Path:
    return output_root / model / track_name


def separate(
    input_path: Path,
    work_dir: Path,
    *,
    model: str = DEFAULT_MODEL,
    device: str | None = None,
    overwrite: bool = False,
) -> StemPaths:
    """
    Split *input_path* into vocals / drums / bass / other using Hybrid Demucs.

    Returns paths to the four stem WAV files under *work_dir*/stems/.
    """
    input_path = input_path.resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    stems_root = work_dir / "stems"
    track_name = input_path.stem
    stem_dir = _track_stem_dir(stems_root, model, track_name)

    expected = {name: stem_dir / f"{name}.wav" for name in STEM_NAMES}
    if not overwrite and all(p.exists() for p in expected.values()):
        logger.info("Reusing cached stems at %s", stem_dir)
        return StemPaths(
            vocals=expected["vocals"],
            drums=expected["drums"],
            bass=expected["bass"],
            other=expected["other"],
            source_track=track_name,
            model=model,
        )

    stems_root.mkdir(parents=True, exist_ok=True)

    resolved_device = resolve_device(device)
    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "--out",
        str(stems_root),
        "-n",
        model,
        "-d",
        resolved_device,
        str(input_path),
    ]

    logger.info("Running Demucs on %s: %s", resolved_device, " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            "Demucs separation failed.\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )

    missing = [name for name, path in expected.items() if not path.exists()]
    if missing:
        raise FileNotFoundError(
            f"Demucs finished but stems are missing: {missing} in {stem_dir}"
        )

    logger.info("Stems written to %s", stem_dir)
    return StemPaths(
        vocals=expected["vocals"],
        drums=expected["drums"],
        bass=expected["bass"],
        other=expected["other"],
        source_track=track_name,
        model=model,
    )


def clean_stems(work_dir: Path) -> None:
    """Remove separated stems from a prior run."""
    stems_root = work_dir / "stems"
    if stems_root.exists():
        shutil.rmtree(stems_root)
        logger.info("Removed %s", stems_root)


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    parser = argparse.ArgumentParser(description="Demucs stem separation (MPS auto-detect)")
    parser.add_argument("input", nargs="?", default="engine/fixtures/test.mp3", help="Input audio file")
    parser.add_argument("--work-dir", default="data/renders/test_run", help="Pipeline work directory")
    parser.add_argument("--device", help="Force device: mps, cpu, cuda")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input)
    work_dir = Path(args.work_dir)
    device = resolve_device(args.device)

    print(f"[*] Device: {device}")
    print(f"[*] Input:  {input_path}")

    stems = separate(
        input_path,
        work_dir,
        device=args.device,
        overwrite=args.overwrite,
    )
    print("[+] Deserialization complete.")
    for name in STEM_NAMES:
        print(f"    {name}: {getattr(stems, name)}")
