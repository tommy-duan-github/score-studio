"""Background transcription queue: audio -> Transkun -> DuET -> first engraving.

One job at a time. Each job runs in its own subprocess (app.jobrun) so the performance limits
(cores, threads, priority — see perf.py) apply to it, a job can be cancelled, and its memory is
returned to the system when it finishes.
"""
from __future__ import annotations

import json
import math
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil

from . import engine, perf, store

_q: "queue.Queue[str]" = queue.Queue()
_queued: set[str] = set()
_qlock = threading.Lock()
_current: dict | None = None          # {"project", "pid" (None while starting), "started", "proc"}
_cancelled: set[str] = set()
_stopping = False
BACKEND = Path(__file__).resolve().parents[1]


def device():
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def submit(pid: str):
    with _qlock:
        if pid in _queued:
            return
        _queued.add(pid)
    _q.put(pid)


def queued() -> list[str]:
    with _qlock:
        return list(_queued)


def current() -> dict | None:
    c = _current
    return None if c is None or c["pid"] is None else dict(project=c["project"], pid=c["pid"], started=c["started"])


def _kill_tree(pid: int):
    try:
        root = psutil.Process(pid)
    except psutil.Error:
        return
    procs = root.children(recursive=True) + [root]
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(procs, timeout=5)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass


def cancel(pid: str) -> bool:
    """Stop a queued or running transcription. Returns True if it was running."""
    with _qlock:
        _queued.discard(pid)
        c = _current
        if not c or c["project"] != pid:
            return False
        _cancelled.add(pid)          # also covers a job that is starting: _run sees this once Popen returns
        proc_pid = c["pid"]
    if proc_pid is not None:
        _kill_tree(proc_pid)
    return True


def apply_live(eff: dict):
    """Apply new limits to a running job: cores at once; priority where the OS allows."""
    c = _current
    if not c or c["pid"] is None:      # not started yet: it picks up the new limits when it starts
        return
    try:
        procs = [psutil.Process(c["pid"])]
        procs += procs[0].children(recursive=True)
    except psutil.Error:
        return
    for p in procs:
        perf.set_affinity(p.pid, eff["cores"])
        perf.set_priority(p.pid, eff["priority"])


def _progress(p: store.Project, status: str, fraction: float, message: str):
    p.update(status=status, progress=dict(stage=status, fraction=round(max(0.0, min(1.0, fraction)), 3), message=message))


# ----------------------------------------------------------------------------- runs inside the subprocess
_models = {}


def duet_model():
    if "duet" not in _models:
        from duet import DuET
        _models["duet"] = DuET.from_pretrained("Wayne42/DuET", device=device(),
                                               revision=os.environ.get("SCORE_STUDIO_DUET_REVISION") or None)
    return _models["duet"]


def transkun_model():
    if "transkun" not in _models:
        from duet.audio import load_audio_model
        _models["transkun"] = load_audio_model(device())
    return _models["transkun"]


def process(p: store.Project):
    meta = p.meta()
    t0 = time.time()
    if p.analysis.exists():
        shutil.rmtree(p.analysis)
    if meta["source"] == "audio":
        _progress(p, "transcribing", 0.05, "Loading the piano transcription model…")
        model = transkun_model()
        _progress(p, "transcribing", 0.15, "Transcribing audio to notes (Transkun)…")
        from duet.audio import audio_to_midi
        if p.performance.exists():
            p.performance.unlink()
        audio_to_midi(p.source, p.performance, device=device(), model=model)
    else:
        shutil.copyfile(p.source, p.performance)

    _progress(p, "analysing", 0.4, "Loading the score model…")
    m = duet_model()
    from duet.midi import read_performance_midi
    from duet.config import CORE_SECONDS
    data = read_performance_midi(p.performance)
    if not len(data["ref_onset"]):
        raise ValueError("The file contains no notes.")
    total = max(1, math.ceil((float(data["ref_onset"].max()) + 1e-6) / CORE_SECONDS))

    def cb(detail):
        k = detail["index"] + 1
        _progress(p, "analysing", 0.4 + 0.5 * min(1.0, k / total),
                  f"Reading rhythm, bars and hands (DuET) — section {k} of {total}…")

    _progress(p, "analysing", 0.42, f"Reading rhythm, bars and hands (DuET) — section 1 of {total}…")
    m.transcribe(p.performance, p.analysis, progress=cb, title=meta["title"])
    _progress(p, "engraving", 0.93, "Engraving the score…")
    engine.forget(p.id)
    res = engine.render(p)
    p.update(status="ready", bars=res.doc["meta"]["bars"], version=meta.get("version", 0) + 1, error=None,
             progress=dict(stage="ready", fraction=1.0, message=f"Done in {time.time() - t0:.0f} s"))


# ----------------------------------------------------------------------------- server side
def _run(pid: str):
    """Runs with _current already set to this project (pid None) by _loop."""
    global _current
    p = store.get(pid)
    if p is None:
        return
    eff = perf.resolve()
    env = dict(os.environ, **perf.thread_env(eff["threads"]))
    env["PYTHONPATH"] = str(BACKEND) + os.pathsep + env.get("PYTHONPATH", "")
    kw = {}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    proc = subprocess.Popen([sys.executable, "-m", "app.jobrun", pid, json.dumps(eff)], env=env, cwd=str(BACKEND), **kw)
    with _qlock:
        _current["pid"] = proc.pid
        kill = pid in _cancelled or _stopping
    if kill:
        _kill_tree(proc.pid)
    else:
        newer = perf.resolve()
        if newer != eff:                  # limits changed while the process was starting
            apply_live(newer)
    code = proc.wait()
    engine.forget(pid)
    with _qlock:
        cancelled = pid in _cancelled
        _cancelled.discard(pid)
    if cancelled or _stopping:
        return
    p = store.get(pid)
    if p is None or code == 0:
        return
    if p.meta()["status"] not in ("ready", "error"):
        hint = " — the machine/container probably ran out of memory" if code in (-9, 137) else ""
        p.update(status="error", error=f"The transcription process stopped unexpectedly (exit code {code}){hint}.",
                 progress=dict(stage="error", fraction=1.0, message="Failed"))


def _loop():
    global _current
    while True:
        pid = _q.get()
        with _qlock:
            if _stopping:
                return
            if pid not in _queued:
                continue          # cancelled while waiting
            _queued.discard(pid)
            _cancelled.discard(pid)
            _current = dict(project=pid, pid=None, started=store.now())
        try:
            _run(pid)
        except Exception as exc:          # keep the queue alive
            p = store.get(pid)
            if p is not None:
                p.update(status="error", error=f"{type(exc).__name__}: {exc}",
                         progress=dict(stage="error", fraction=1.0, message="Failed"))
        finally:
            with _qlock:
                _current = None


_started = False
_thread: threading.Thread | None = None


def start():
    global _started, _thread
    if _started:
        return
    _started = True
    perf.apply_server()
    _thread = threading.Thread(target=_loop, name="transcriber", daemon=True)
    _thread.start()
    # resume anything that was interrupted by a restart
    for p in store.all_projects():
        if p.meta()["status"] not in ("ready", "error"):
            submit(p.id)


def shutdown():
    """Stop launching jobs, kill the running one (it resumes on next start), and wait for the worker to exit."""
    global _stopping
    with _qlock:
        _stopping = True
        c = _current
        proc_pid = c["pid"] if c else None
    if proc_pid is not None:
        _kill_tree(proc_pid)
    _q.put("")                     # wake the loop so it sees _stopping
    if _thread is not None:
        _thread.join(timeout=15)
