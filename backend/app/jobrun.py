"""Transcription subprocess: `python -m app.jobrun <project_id> <effective-limits-json>` (started by worker.py)."""
from __future__ import annotations

import json
import sys
import traceback


def main() -> int:
    pid, eff = sys.argv[1], json.loads(sys.argv[2])
    from . import perf
    perf.apply_child_self(eff)          # before torch spins up its thread pools
    from . import store, worker
    p = store.get(pid)
    if p is None:
        return 0
    try:
        worker.process(p)
        return 0
    except Exception as exc:
        traceback.print_exc()
        msg = f"{type(exc).__name__}: {exc}"
        if "os error 1455" in msg or "paging file is too small" in msg.lower() or isinstance(exc, MemoryError):
            msg = ("Not enough memory: Windows ran out of virtual memory (RAM + paging file). Close other apps, "
                   "or let Windows manage the paging file size, then try again.")
        p.update(status="error", error=msg,
                 progress=dict(stage="error", fraction=1.0, message="Failed"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
