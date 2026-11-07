"""Performance limits: which CPU cores the backend may use, how many threads a transcription uses,
and the scheduling priority of the transcription process.

Settings live in data/config.json under "performance". They are applied
  * to the server process (core affinity for every thread, torch thread count), and
  * to each transcription subprocess (affinity, threads via OMP/MKL/torch, priority/nice),
and live to a transcription that is already running (cores immediately, priority where the OS allows).

Docker's own `cpus:` / `cpuset:` limits are an outer cap; they are detected and shown, never exceeded.
"""
from __future__ import annotations

import math
import os
import sys
import threading
from pathlib import Path

import psutil

from . import store

PRESETS = ("eco", "balanced", "full", "custom")
PRIORITIES = {"normal": 0, "low": 10, "background": 19}         # Linux nice values
_WIN_CLASSES = {"normal": "NORMAL_PRIORITY_CLASS", "low": "BELOW_NORMAL_PRIORITY_CLASS", "background": "IDLE_PRIORITY_CLASS"}
_PRESET_SHARE = {"eco": (0.25, "background"), "balanced": (0.5, "low"), "full": (1.0, "normal")}
DEFAULT_PRESET = os.environ.get("SCORE_STUDIO_PERF_PRESET", "full").strip().lower()
if DEFAULT_PRESET not in _PRESET_SHARE:
    DEFAULT_PRESET = "full"

_lock = threading.RLock()
_me = psutil.Process()


def _initial_cores() -> list[int]:
    try:
        return sorted(_me.cpu_affinity())
    except (AttributeError, psutil.Error, OSError):      # macOS has no affinity API
        return list(range(psutil.cpu_count() or 1))


# What the container / OS let this process use before we narrowed anything.
ALLOWED: list[int] = _initial_cores()


def cgroup_cpus() -> float | None:
    """Docker `cpus:` quota (cgroup v2 cpu.max or v1 cfs quota), in CPUs; None when unlimited."""
    try:
        q, p = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        return None if q == "max" else int(q) / int(p)
    except (OSError, ValueError):
        pass
    try:
        q = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
        p = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        return None if q <= 0 else q / p
    except (OSError, ValueError):
        return None


def cgroup_memory() -> int | None:
    for f in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            v = Path(f).read_text().strip()
            if v != "max" and int(v) < (1 << 60):
                return int(v)
        except (OSError, ValueError):
            continue
    return None


def in_docker() -> bool:
    return Path("/.dockerenv").exists() or os.environ.get("SCORE_STUDIO_DOCKER") == "1"


# ----------------------------------------------------------------------------- settings
def settings() -> dict:
    s = store.app_config().get("performance") or {}
    preset = s.get("preset") if s.get("preset") in PRESETS else DEFAULT_PRESET
    cores = [c for c in (s.get("cores") or []) if isinstance(c, int) and c in ALLOWED]
    priority = s.get("priority") if s.get("priority") in PRIORITIES else _PRESET_SHARE.get(preset, (1, "normal"))[1]
    if preset == "custom" and not cores:
        cores = list(ALLOWED)
    return dict(preset=preset, cores=cores if preset == "custom" else [], priority=priority)


def validate(body: dict) -> dict:
    """Validate a (partial) PUT body; returns the merged settings or raises ValueError."""
    if not isinstance(body, dict):
        raise ValueError("Body must be an object.")
    unknown = set(body) - {"preset", "cores", "priority"}
    if unknown:
        raise ValueError(f"Unknown performance setting {sorted(unknown)[0]}.")
    cur = settings()
    preset = body.get("preset", cur["preset"])
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of {', '.join(PRESETS)}.")
    out = dict(preset=preset, cores=[], priority=None)
    if preset == "custom":
        cores = body.get("cores", cur["cores"] or ALLOWED)
        if not isinstance(cores, list) or not cores or not all(isinstance(c, int) and not isinstance(c, bool) for c in cores):
            raise ValueError("cores must be a non-empty list of core numbers.")
        bad = [c for c in cores if c not in ALLOWED]
        if bad:
            raise ValueError(f"Core {bad[0]} is not available; allowed cores: {ALLOWED}.")
        out["cores"] = sorted(set(cores))
        pr = body.get("priority", cur["priority"])
    else:
        # A preset picks its own priority unless one is given explicitly with it.
        pr = body.get("priority", _PRESET_SHARE[preset][1])
    if pr not in PRIORITIES:
        raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}.")
    out["priority"] = pr
    return out


def resolve(s: dict | None = None) -> dict:
    """Settings -> concrete cores, thread count and nice value."""
    s = s or settings()
    n = len(ALLOWED)
    if s["preset"] == "custom":
        cores = sorted(s["cores"]) or list(ALLOWED)
    else:
        k = max(1, min(n, round(n * _PRESET_SHARE[s["preset"]][0])))
        cores = ALLOWED[-k:]           # highest-numbered cores: core 0 usually carries the OS and interrupts
    threads = len(cores)
    quota = cgroup_cpus()
    if quota:
        threads = max(1, min(threads, math.ceil(quota)))
    return dict(cores=cores, threads=threads, priority=s["priority"], nice=PRIORITIES[s["priority"]])


def save(s: dict) -> dict:
    from . import worker
    with _lock:                 # persist and apply together, so an older request can't apply after a newer one
        store.update_app_config("performance", lambda _old: s)
        eff = resolve(s)
        apply_server(eff)
        worker.apply_live(eff)
    return eff


# ----------------------------------------------------------------------------- applying
def _thread_ids(pid: int) -> list[int]:
    try:
        return [int(t) for t in os.listdir(f"/proc/{pid}/task")]
    except OSError:
        return [pid]


def set_affinity(pid: int, cores: list[int]) -> bool:
    """Pin every thread of a process (Linux affinity is per thread; new threads inherit it)."""
    try:
        if sys.platform.startswith("linux"):
            ok = False
            for tid in _thread_ids(pid):
                try:
                    os.sched_setaffinity(tid, cores)
                    ok = True
                except OSError:
                    pass
            return ok
        psutil.Process(pid).cpu_affinity(cores)
        return True
    except (AttributeError, psutil.Error, OSError, ValueError):
        return False


def set_priority(pid: int, priority: str) -> bool:
    """Lowering priority always works; raising it back needs CAP_SYS_NICE on Linux (then it applies next job)."""
    try:
        if sys.platform == "win32":
            psutil.Process(pid).nice(getattr(psutil, _WIN_CLASSES[priority]))
            return True
        nice = PRIORITIES[priority]
        ok = True
        for tid in _thread_ids(pid):
            try:
                os.setpriority(os.PRIO_PROCESS, tid, nice)
            except OSError:
                ok = False
        return ok
    except (psutil.Error, OSError):
        return False


def set_torch_threads(threads: int):
    if "torch" in sys.modules:
        try:
            sys.modules["torch"].set_num_threads(threads)
        except Exception:
            pass


def thread_env(threads: int) -> dict:
    t = str(threads)
    return {k: t for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS",
                           "VECLIB_MAXIMUM_THREADS")}


def apply_server(eff: dict | None = None):
    """The web server itself: same cores, normal priority (keeps the UI responsive), same thread cap."""
    eff = eff or resolve()
    set_affinity(os.getpid(), eff["cores"])
    set_torch_threads(eff["threads"])


def apply_child_self(eff: dict):
    """Called first thing inside a transcription subprocess."""
    set_affinity(os.getpid(), eff["cores"])
    set_priority(os.getpid(), eff["priority"])
    os.environ.update(thread_env(eff["threads"]))
    import torch
    torch.set_num_threads(eff["threads"])
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass


# ----------------------------------------------------------------------------- live status
_procs: dict[int, psutil.Process] = {}


def _cpu(pid: int) -> tuple[float, int] | None:
    try:
        p = _procs.get(pid)
        if p is None or not p.is_running():
            p = _procs[pid] = psutil.Process(pid)
            p.cpu_percent(None)
            return 0.0, p.memory_info().rss
        return p.cpu_percent(None), p.memory_info().rss
    except psutil.Error:
        _procs.pop(pid, None)
        return None


def status() -> dict:
    from . import worker
    s = settings()
    eff = resolve(s)
    per_core = psutil.cpu_percent(percpu=True)
    server = _cpu(os.getpid()) or (0.0, 0)
    job = worker.current()
    child, tree = None, set()
    if job:
        try:     # the job plus its children (ffmpeg; on Windows the venv launcher's real python)
            root = psutil.Process(job["pid"])
            tree = {job["pid"]} | {c.pid for c in root.children(recursive=True)}
        except psutil.Error:
            tree = set()
        parts = [x for x in (_cpu(pid) for pid in tree) if x]
        child = (sum(x[0] for x in parts), sum(x[1] for x in parts)) if parts else None
    for pid in list(_procs):
        if pid != os.getpid() and pid not in tree:
            _procs.pop(pid, None)
    vm = psutil.virtual_memory()
    return dict(
        settings=s, effective=eff,
        presets={k: resolve(dict(preset=k, cores=[], priority=v[1])) for k, v in _PRESET_SHARE.items()},
        system=dict(platform=sys.platform, docker=in_docker(), logical_cpus=psutil.cpu_count() or len(ALLOWED),
                    allowed_cores=ALLOWED, cpu_quota=cgroup_cpus(), memory_limit=cgroup_memory(),
                    memory_total=vm.total, memory_available=vm.available,
                    can_raise_priority=sys.platform == "win32" or _can_raise()),
        usage=dict(per_core=[per_core[i] if i < len(per_core) else 0.0 for i in range(max(len(per_core), max(ALLOWED) + 1))],
                   server_cpu=round(server[0], 1), server_rss=server[1],
                   job=dict(job, cpu=round(child[0], 1), rss=child[1]) if job and child else job),
    )


def _can_raise() -> bool:
    """CAP_SYS_NICE (bit 23) lets a running job's priority be raised again; otherwise that waits for the next job."""
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("CapEff:"):
                return bool(int(line.split()[1], 16) & (1 << 23))
    except (OSError, ValueError):
        pass
    return False
