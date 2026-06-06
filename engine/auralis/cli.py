"""
Auralis CLI — headless audio pipeline.

Usage:
    python -m auralis process song.mp3 --profile zenith -o out.wav
    python -m auralis separate song.mp3
    python -m auralis analyze song.mp3
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from auralis import __version__
from auralis.types import OUTPUT_PROFILES, PipelineResult, resolve_profile

logger = logging.getLogger(__name__)


def _profile_arg(value: str) -> str:
    """Argparse type — accepts legacy aliases (e.g. god → zenith)."""
    resolved = resolve_profile(value.strip().lower())
    if resolved not in OUTPUT_PROFILES:
        raise argparse.ArgumentTypeError(
            f"invalid profile '{value}' (choose from {', '.join(OUTPUT_PROFILES)})"
        )
    return resolved


def _default_work_dir(input_path: Path) -> Path:
    return Path("data") / "renders" / input_path.stem


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_separate(args: argparse.Namespace) -> int:
    from auralis.dsp.deserializer import separate

    input_path = Path(args.input).resolve()
    work_dir = Path(args.work_dir).resolve() if args.work_dir else _default_work_dir(input_path)

    stems = separate(
        input_path,
        work_dir,
        model=args.model,
        device=args.device,
        overwrite=args.overwrite,
    )
    print(json.dumps(stems.as_dict(), indent=2))
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    from auralis.analysis import analyze, build_render_plan, save_profile

    input_path = Path(args.input).resolve()
    profile = analyze(input_path)

    if args.output:
        save_profile(profile, Path(args.output))
    else:
        print(json.dumps(profile.to_dict(), indent=2))

    if args.profile:
        plan = build_render_plan(profile, args.profile)
        plan_path = Path(args.output).with_suffix(".plan.json") if args.output else None
        if plan_path:
            plan_path.write_text(json.dumps(plan.to_dict(), indent=2), encoding="utf-8")
            logger.info("Wrote render plan to %s", plan_path)

    return 0


def cmd_process(args: argparse.Namespace) -> int:
    from auralis.analysis import analyze, build_render_plan, save_profile
    from auralis.dsp.applier import render
    from auralis.dsp.deserializer import separate
    from auralis.io.job_status import stage, write_status
    from auralis.llm import enhance_plan_with_llm

    input_path = Path(args.input).resolve()
    profile_name = resolve_profile(args.profile)
    work_dir = Path(args.work_dir).resolve() if args.work_dir else _default_work_dir(input_path)
    output_path = (
        Path(args.output).resolve()
        if args.output
        else work_dir / f"{input_path.stem}.{profile_name}.wav"
    )

    work_dir.mkdir(parents=True, exist_ok=True)
    logger.info("=== AURALIS PIPELINE: %s (profile=%s) ===", input_path.name, profile_name)
    logger.info("Work dir: %s", work_dir)

    try:
        stage(work_dir, "separating", 8, "DEMUCS STEM SEPARATION...")
        logger.info("[1/4] Deserializing stems via Demucs...")
        stems = separate(
            input_path,
            work_dir,
            model=args.model,
            device=args.device,
            overwrite=args.overwrite,
        )
        stage(work_dir, "separating", 62, "STEM SEPARATION COMPLETE")

        stage(work_dir, "analyzing", 68, "LIBROSA BRAIN ANALYSIS...")
        logger.info("[2/4] Running brain analysis...")
        profile = analyze(input_path)
        profile_path = work_dir / "profile.json"
        save_profile(profile, profile_path)
        stage(work_dir, "analyzing", 78, "ANALYSIS COMPLETE")

        stage(work_dir, "rendering", 82, "BUILDING RENDER PLAN...")
        logger.info("[3/4] Building render plan (profile=%s)...", profile_name)
        if args.llm:
            plan = enhance_plan_with_llm(profile, profile_name, provider=args.llm_provider)
        else:
            plan = build_render_plan(profile, profile_name)

        plan_path = work_dir / "render_plan.json"
        plan_path.write_text(json.dumps(plan.to_dict(), indent=2), encoding="utf-8")

        stage(work_dir, "rendering", 88, "PEDALBOARD DSP RENDER...")
        logger.info("[4/4] Applying DSP and mixing down...")
        from auralis.analysis.scoring import compute_ai_score

        outcome = render(
            stems,
            plan,
            output_path,
            work_dir=work_dir,
            keep_stems=args.keep_stems,
            source_path=input_path,
        )

        ai_score = compute_ai_score(
            output=outcome.mastered,
            drums=outcome.stem_buffers["drums"],
            plan=plan,
            safeguard=outcome.safeguard,
            source_path=input_path,
            sample_rate=outcome.sample_rate,
        )

        meta = {
            "bpm": profile.bpm,
            "genre": profile.genre_hint,
            "mood": profile.mood_hint,
            "profile": profile_name,
            "safeguard": outcome.safeguard.to_dict(),
            "ai_score": ai_score.to_dict(),
        }
        if outcome.safeguard.tripped:
            meta["safeguard_message"] = (
                f"Phase correlation {outcome.safeguard.mix_correlation:.2f} — "
                f"width rollback {int((outcome.safeguard.rollback_factor or 0.7) * 100)}% applied"
            )

        write_status(
            work_dir,
            status="complete",
            percent=100,
            message="DECODE COMPLETE // LOCKED",
            output=str(output_path),
            meta=meta,
        )

        result = PipelineResult(
            input_path=input_path,
            output_path=output_path,
            stems=stems,
            profile=profile,
            plan=plan,
            work_dir=work_dir,
        )

        summary = {
            "version": __version__,
            "input": str(result.input_path),
            "output": str(result.output_path),
            "profile": profile_name,
            "bpm": profile.bpm,
            "genre": profile.genre_hint,
            "stems": stems.as_dict(),
            "work_dir": str(work_dir),
        }
        print(json.dumps(summary, indent=2))
        return 0
    except Exception as exc:
        write_status(
            work_dir,
            status="failed",
            percent=0,
            message="PIPELINE FAILED",
            error=str(exc),
        )
        raise


def cmd_clean(args: argparse.Namespace) -> int:
    from auralis.dsp.deserializer import clean_stems

    work_dir = Path(args.work_dir).resolve()
    clean_stems(work_dir)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auralis",
        description="Auralis headless pipeline: Demucs → Librosa → Pedalboard",
    )
    parser.add_argument("--version", action="version", version=f"auralis {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")

    sub = parser.add_subparsers(dest="command", required=True)

    p_process = sub.add_parser("process", help="Run full pipeline: separate → analyze → apply → mix")
    p_process.add_argument("input", help="Input audio file (mp3, wav, flac, …)")
    p_process.add_argument(
        "-o", "--output",
        help="Output WAV path (default: data/renders/<track>/<track>.<profile>.wav)",
    )
    p_process.add_argument(
        "--profile", "-p",
        type=_profile_arg,
        default="audiophile",
        help="Output mode preset (default: audiophile; legacy: god → zenith)",
    )
    p_process.add_argument("--work-dir", help="Scratch directory for stems and analysis JSON")
    p_process.add_argument("--model", default="htdemucs", help="Demucs model name (default: htdemucs)")
    p_process.add_argument("--device", help="Demucs device: cpu, cuda, mps")
    p_process.add_argument("--overwrite", action="store_true", help="Re-run Demucs even if stems exist")
    p_process.add_argument("--keep-stems", action="store_true", help="Save per-stem processed WAVs")
    p_process.add_argument("--llm", action="store_true", help="Refine plan via OpenRouter/Groq LLM")
    p_process.add_argument(
        "--llm-provider",
        default="openrouter",
        choices=("openrouter", "groq"),
        help="LLM API provider (default: openrouter)",
    )
    p_process.set_defaults(func=cmd_process)

    p_sep = sub.add_parser("separate", help="Demucs stem separation only")
    p_sep.add_argument("input", help="Input audio file")
    p_sep.add_argument("--work-dir", help="Output root for stems")
    p_sep.add_argument("--model", default="htdemucs")
    p_sep.add_argument("--device", help="Demucs device: cpu, cuda, mps")
    p_sep.add_argument("--overwrite", action="store_true")
    p_sep.set_defaults(func=cmd_separate)

    p_an = sub.add_parser("analyze", help="Librosa analysis only")
    p_an.add_argument("input", help="Input audio file")
    p_an.add_argument("-o", "--output", help="Write profile JSON to this path")
    p_an.add_argument(
        "--profile",
        type=_profile_arg,
        help="Also emit a rule-based render plan (legacy: god → zenith)",
    )
    p_an.set_defaults(func=cmd_analyze)

    p_clean = sub.add_parser("clean", help="Remove cached stems from a work directory")
    p_clean.add_argument("work_dir", help="Pipeline work directory to clean")
    p_clean.set_defaults(func=cmd_clean)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        logger.info("Interrupted")
        return 130
    except Exception as exc:
        logger.error("%s", exc)
        if args.verbose:
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
