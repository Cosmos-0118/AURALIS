"""Write pipeline progress to job_status.json for Express polling."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


def write_status(work_dir: Path, **fields: Any) -> None:
    """Merge *fields* into work_dir/job_status.json."""
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / "job_status.json"

    current: dict[str, Any] = {}
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            current = {}

    current.update(fields)
    current["updatedAt"] = time.time()
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")


def stage(work_dir: Path, status: str, percent: int, message: str) -> None:
    write_status(work_dir, status=status, percent=percent, message=message)
