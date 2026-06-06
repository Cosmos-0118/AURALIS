"""Optional LLM enhancement for render plans (OpenRouter / GroqCloud)."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from auralis.analysis.planner import build_render_plan
from auralis.types import RenderPlan, SongProfile

logger = logging.getLogger(__name__)


def enhance_plan_with_llm(
    profile: SongProfile,
    profile_name: str,
    *,
    provider: str = "openrouter",
) -> RenderPlan:
    """
    Send the Librosa profile to an OpenAI-compatible endpoint and parse
    adjusted stem parameters. Falls back to rule-based plan on any failure.
    """
    base_plan = build_render_plan(profile, profile_name)

    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("GROQ_API_KEY")
    if not api_key:
        logger.info("No LLM API key set; using rule-based render plan")
        return base_plan

    try:
        from openai import OpenAI  # optional dependency
    except ImportError:
        logger.warning("openai package not installed; using rule-based render plan")
        return base_plan

    base_url = "https://openrouter.ai/api/v1" if provider == "openrouter" else "https://api.groq.com/openai/v1"
    model = os.environ.get("AURALIS_LLM_MODEL", "meta-llama/llama-3.1-8b-instruct")

    client = OpenAI(api_key=api_key, base_url=base_url)
    prompt = _build_prompt(profile, profile_name, base_plan.to_dict())

    logger.info("Requesting LLM render plan via %s", provider)
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are an expert mastering engineer. Given song analysis JSON, "
                    "output ONLY valid JSON matching the render plan schema. "
                    "Keep vocals and bass center_lock=true with minimal spatial FX. "
                    "Apply spatial widening and pan LFO only to drums and other."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content or "{}"
    data: dict[str, Any] = json.loads(raw)
    return _plan_from_llm_json(data, profile_name, fallback=base_plan)


def _build_prompt(profile: SongProfile, profile_name: str, base_plan: dict[str, Any]) -> str:
    return json.dumps(
        {
            "task": "Refine stem DSP parameters for headphone immersion",
            "output_profile": profile_name,
            "analysis": profile.to_dict(),
            "baseline_plan": base_plan,
            "constraints": {
                "vocals": "center_lock, clarity, minimal reverb",
                "bass": "center_lock, no spatial widening",
                "drums": "spatial movement, moderate width",
                "other": "widest spatial field, section-adaptive reverb",
            },
        },
        indent=2,
    )


def _plan_from_llm_json(
    data: dict[str, Any],
    profile_name: str,
    *,
    fallback: RenderPlan,
) -> RenderPlan:
    """Parse LLM JSON; return *fallback* if structure is invalid."""
    try:
        from auralis.types import StemEffectParams

        stem_params = {}
        for name, params in data.get("stem_params", {}).items():
            stem_params[name] = StemEffectParams(stem=name, **params)
        if set(stem_params) != {"vocals", "drums", "bass", "other"}:
            raise ValueError("Incomplete stem_params from LLM")
        return RenderPlan(
            profile_name=profile_name,
            stem_params=stem_params,
            master_limiter_db=float(data.get("master_limiter_db", fallback.master_limiter_db)),
            master_gain_db=float(data.get("master_gain_db", fallback.master_gain_db)),
        )
    except Exception as exc:
        logger.warning("LLM plan parse failed (%s); using rule-based plan", exc)
        return fallback
