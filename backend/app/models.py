"""Model files: what is installed, one-click downloads from the original sources, and removal.

* ``duet``      — DuET weights (Hugging Face ``Wayne42/DuET`` at a pinned revision, in the HF cache). Required.
* ``transkun``  — Transkun v2 checkpoint, shipped inside the ``transkun`` pip package. Required, built in.
* YourMT3+ checkpoints (``mimbres/YourMT3`` model repo) + the YourMT3 code (Hugging Face space), under
  ``YOURMT3_HOME``. Optional; ``yptf-multi-ps`` is the recommended default for multiple instruments.
* ``cuda`` — portable desktop build with the CPU runtime only: CUDA PyTorch from download.pytorch.org, installed
  into ``runtime/cuda-site`` and put ahead of the CPU build on the path of transcription processes (and of the app
  after a restart). Offered when an NVIDIA GPU is present; recommended then.

The portable desktop app ships without DuET / YourMT3+ and asks to download them on first start; the Docker image
bakes them in (read-only there, so they show as built in). Downloads run one at a time in a background thread.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import threading
import time
from pathlib import Path

from . import multi

DUET_REPO = "Wayne42/DuET"
DUET_DEFAULT_REVISION = "27e1ed4d66c5e36fdc656517317ffeb65e6fc58e"
DUET_FILES = ["config.json", "model.safetensors"]
MT3_REPO = "mimbres/YourMT3"
MT3_SPACE_REVISION = "5e66c1ea173a8186e0d20432b841d3180cc015b5"
MT3_MODEL_REVISION = "e45ebd70398682d54b7bb1901a5216e18f3b1824"
# download sizes (bytes), used before a download starts; refreshed from the hub when it does
SIZES = {"duet": 428427069, "yptf-multi-ps": 541553263, "moe-nops": 561544628, "moe-ps": 758957292,
         "yptf-single": 361050039, "ymt3+": 542707465}
MT3_CODE_BYTES = 2_000_000

CUDA_BYTES = 3_300_000_000          # torch + torchaudio cu128 wheels for Windows, roughly
CUDA_INDEX = "https://download.pytorch.org/whl/cu128"

_lock = threading.RLock()
_jobs: dict[str, dict] = {}          # key -> {state, progress, error, total, done}
_queue: list[str] = []
_thread: threading.Thread | None = None


def duet_revision() -> str:
    return os.environ.get("SCORE_STUDIO_DUET_REVISION") or DUET_DEFAULT_REVISION


def _hf_cache() -> Path:
    from huggingface_hub import constants
    return Path(constants.HF_HUB_CACHE)


def _duet_dir() -> Path:
    return _hf_cache() / ("models--" + DUET_REPO.replace("/", "--"))


def _duet_snapshot() -> Path:
    return _duet_dir() / "snapshots" / duet_revision()


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _writable(path: Path) -> bool:
    """Can we create/remove files here (or in the nearest existing parent)?"""
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    return os.access(p, os.W_OK)


def _mt3_ckpt(key: str) -> Path:
    exp, f = multi.CKPT[key].split("@")
    return multi._home() / "amt" / "logs" / "2024" / exp / "checkpoints" / f


def _mt3_code_ok() -> bool:
    home = multi._home()
    return (home / "amt" / "src" / "model" / "ymt3.py").is_file() and (home / "model_helper.py").is_file()


def _transkun_ckpt() -> Path | None:
    spec = importlib.util.find_spec("transkun")
    if not spec or not spec.origin:
        return None
    p = Path(spec.origin).parent / "pretrained" / "2.0.pt"
    return p if p.is_file() else None


# ----------------------------------------------------------------------------- GPU runtime (desktop CPU build)
def runtime_dir() -> Path | None:
    """<portable root>/runtime when running from the desktop build."""
    from . import store
    r = store.ROOT.parent / "runtime"
    return r if os.environ.get("SCORE_STUDIO_DESKTOP") and (r / "python").is_dir() else None


def cuda_site() -> Path | None:
    r = runtime_dir()
    return r / "cuda-site" if r else None


def cuda_installed() -> bool:
    d = cuda_site()
    return bool(d and (d / ".complete").is_file())


def _cpu_torch() -> str | None:
    """Version of the runtime's own torch if it is a CPU build (else None: nothing to offer)."""
    import importlib.metadata as md
    try:
        v = md.version("torch")
    except md.PackageNotFoundError:
        return None
    if cuda_installed():
        return v.split("+")[0]
    return v.split("+")[0] if v.endswith("+cpu") else None


def _cuda_entry() -> dict | None:
    if runtime_dir() is None or _cpu_torch() is None:
        return None
    from . import perf
    gpu = perf.gpu()
    nvidia = bool(gpu.get("name"))
    installed = cuda_installed()
    return dict(key="cuda", name="GPU acceleration (NVIDIA CUDA)",
                purpose="Runs transcription on the NVIDIA GPU, several times faster"
                        + (f" ({gpu['name']})" if nvidia else "; no NVIDIA GPU detected"),
                required=False, recommended=nvidia and not installed, installed=installed,
                managed=nvidia or installed, bytes=_size(cuda_site()) if installed else None,
                download_bytes=CUDA_BYTES, source="download.pytorch.org",
                restart_required=installed and not gpu.get("available"))


def activate_cuda():
    """Put runtime/cuda-site ahead of the CPU torch for child processes started from now on."""
    d = cuda_site()
    if d and cuda_installed():
        parts = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
        if str(d) not in parts:
            os.environ["PYTHONPATH"] = os.pathsep.join([str(d)] + parts)
        os.environ["SCORE_STUDIO_CUDA_SITE"] = str(d)


def _download_cuda(key: str):
    """pip-install CUDA torch/torchaudio (same version as the runtime's CPU build) into a temp dir, then swap it in."""
    import re
    import subprocess
    import sys
    version = _cpu_torch()
    target = cuda_site()
    tmp = target.with_name("cuda-site.partial")
    shutil.rmtree(tmp, ignore_errors=True)
    exe = Path(sys.executable)
    py = exe.parent / "python.exe" if exe.name.lower() == "pythonw.exe" else exe
    cmd = [str(py), "-m", "pip", "install", "--no-deps", "--no-cache-dir", "--disable-pip-version-check",
           "--progress-bar", "raw", "--target", str(tmp), "--index-url", CUDA_INDEX,
           f"torch=={version}+cu128", f"torchaudio=={version}+cu128"]
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    done_files, tail = 0, []
    for line in proc.stdout:
        m = re.search(r"Progress (\d+) of (\d+)", line)
        if m:
            cur, total = int(m.group(1)), int(m.group(2))
            # two wheels: torch (~95 % of the bytes) then torchaudio
            frac = (cur / total) * (0.95 if done_files == 0 else 0.04) + (0.95 if done_files else 0)
            if cur >= total:
                done_files += 1
            with _lock:
                if key in _jobs:
                    _jobs[key]["progress"] = round(min(0.99, frac), 4)
        else:
            tail = (tail + [line.strip()])[-6:]
    if proc.wait() != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("pip failed: " + " | ".join(t for t in tail if t))
    shutil.rmtree(target, ignore_errors=True)
    tmp.rename(target)
    (target / ".complete").write_text(version, encoding="utf-8")
    activate_cuda()


# ----------------------------------------------------------------------------- status
_duet_ok_cache: dict = {}


def _duet_loadable() -> bool:
    """True when DuET's own loader (snapshot_download with these patterns) resolves offline — that needs the
    weights *and* the cached file listing, so check it the same way (cached per snapshot mtime)."""
    snap = _duet_snapshot()
    if not all((snap / f).is_file() for f in DUET_FILES):
        return False
    stamp = (str(snap), snap.stat().st_mtime)
    if _duet_ok_cache.get("stamp") != stamp:
        from huggingface_hub import snapshot_download
        try:
            snapshot_download(DUET_REPO, revision=duet_revision(), allow_patterns=DUET_FILES, local_files_only=True)
            ok = True
        except Exception:
            ok = False
        _duet_ok_cache.update(stamp=stamp, ok=ok)
    return _duet_ok_cache["ok"]


def _entries() -> list[dict]:
    out = []
    duet_ok = _duet_loadable()
    out.append(dict(key="duet", name="DuET score model", purpose="Rhythm, bars, hands and key for every transcription",
                    required=True, recommended=True, installed=duet_ok,
                    managed=_writable(_hf_cache()), bytes=_size(_duet_dir()) if duet_ok else None,
                    download_bytes=SIZES["duet"], source=f"huggingface.co/{DUET_REPO}"))
    tk = _transkun_ckpt()
    out.append(dict(key="transkun", name="Transkun v2", purpose="Piano audio to notes",
                    required=True, recommended=True, installed=tk is not None, managed=False,
                    bytes=tk.stat().st_size if tk else None, download_bytes=None,
                    source="pypi.org/project/transkun"))
    runtime = multi.mt3_python() is not None
    home_ok = _writable(multi._home())
    for key, label in multi.MODELS.items():
        ck = _mt3_ckpt(key)
        ok = ck.is_file() and _mt3_code_ok()
        if not ok and not (runtime and home_ok):
            continue                    # e.g. Docker image without this checkpoint: nothing to show or do
        out.append(dict(key=key, name=f"YourMT3+ {label}",
                        purpose="Multiple instruments (beta)" + (", default" if key == multi.DEFAULT_MODEL else ""),
                        required=False, recommended=key == multi.DEFAULT_MODEL, installed=ok,
                        managed=runtime and home_ok, bytes=ck.stat().st_size if ck.is_file() else None,
                        download_bytes=SIZES[key] + (0 if _mt3_code_ok() else MT3_CODE_BYTES),
                        source=f"huggingface.co/{MT3_REPO}"))
    cuda = _cuda_entry()
    if cuda:
        out.append(cuda)
    with _lock:
        for e in out:
            j = _jobs.get(e["key"])
            e.update(state=j["state"] if j else "idle",
                     progress=j.get("progress") if j and j["state"] in ("queued", "downloading") else None,
                     error=j.get("error") if j and j["state"] == "error" else None)
    return out


def ready(entries: list[dict] | None = None) -> bool:
    return all(e["installed"] for e in (entries or _entries()) if e["required"])


def status() -> dict:
    entries = _entries()
    with _lock:
        busy = any(j["state"] in ("queued", "downloading") for j in _jobs.values())
    return dict(ready=ready(entries), downloading=busy, models=entries)


def require_ready():
    """Raise ValueError (→ 409) when a transcription can't run because required models are missing."""
    missing = [e["name"] for e in _entries() if e["required"] and not e["installed"]]
    if missing:
        raise ModelsMissing("Download the required models first (Settings › Storage): " + ", ".join(missing))


class ModelsMissing(ValueError):
    pass


# ----------------------------------------------------------------------------- downloads
def _online():
    """The app may run with HF_HUB_OFFLINE=1 (so transcription never touches the network); downloads must not."""
    from huggingface_hub import constants
    constants.HF_HUB_OFFLINE = False


def _watch(key: str, folder: Path, done_before: int, total: int, stop: threading.Event):
    """Progress = finished bytes + growing *.incomplete files under folder."""
    while not stop.wait(0.5):
        cur = 0
        for root, _, files in os.walk(folder):
            for f in files:
                if f.endswith(".incomplete"):
                    try:
                        cur += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
        with _lock:
            j = _jobs.get(key)
            if j:
                j["progress"] = round(min(0.99, (done_before + cur) / max(1, total)), 4)


def _download_duet(key: str):
    """Same call DuET's loader makes, so the snapshot *and* its cached file listing exist for offline loading."""
    from huggingface_hub import snapshot_download
    _online()
    stop = threading.Event()
    w = threading.Thread(target=_watch, args=(key, _duet_dir(), 0, SIZES["duet"], stop), daemon=True)
    w.start()
    try:
        snapshot_download(DUET_REPO, revision=duet_revision(), allow_patterns=DUET_FILES)
    finally:
        stop.set()
    _duet_ok_cache.clear()


def _download_mt3(key: str):
    from huggingface_hub import hf_hub_download, snapshot_download
    _online()
    home = multi._home()
    home.mkdir(parents=True, exist_ok=True)
    if not _mt3_code_ok():
        snapshot_download(MT3_REPO, repo_type="space", revision=MT3_SPACE_REVISION, local_dir=str(home),
                          allow_patterns=["amt/src/**/*.py", "model_helper.py"],
                          ignore_patterns=["amt/src/extras/*", "amt/src/tests/*"])
    exp, f = multi.CKPT[key].split("@")
    rel = f"logs/2024/{exp}/checkpoints/{f}"
    stop = threading.Event()
    w = threading.Thread(target=_watch, args=(key, home / "amt", 0, SIZES[key], stop), daemon=True)
    w.start()
    try:
        hf_hub_download(MT3_REPO, rel, revision=MT3_MODEL_REVISION, repo_type="model", local_dir=str(home / "amt"))
    finally:
        stop.set()


def _run():
    global _thread
    while True:
        with _lock:
            if not _queue:
                _thread = None
                return
            key = _queue.pop(0)
            _jobs[key].update(state="downloading", progress=0.0)
        try:
            {"duet": _download_duet, "cuda": _download_cuda}.get(key, _download_mt3)(key)
            with _lock:
                _jobs.pop(key, None)
        except Exception as exc:          # network errors, disk full, …
            with _lock:
                _jobs[key] = dict(state="error", progress=None,
                                  error=f"{type(exc).__name__}: {exc}"[:300])


def download(keys: list[str]) -> dict:
    entries = {e["key"]: e for e in _entries()}
    unknown = [k for k in keys if k not in entries]
    if unknown or not keys:
        raise ValueError("Unknown model: " + ", ".join(unknown) if unknown else "keys required")
    global _thread
    with _lock:
        for k in keys:
            e = entries[k]
            if not e["managed"]:
                raise ValueError(f"{e['name']} is built in and can't be downloaded here")
            if e["installed"] or k in _queue or (_jobs.get(k) or {}).get("state") == "downloading":
                continue
            _jobs[k] = dict(state="queued", progress=0.0, error=None)
            _queue.append(k)
        if _queue and _thread is None:
            _thread = threading.Thread(target=_run, name="model-download", daemon=True)
            _thread.start()
    return status()


def remove(key: str) -> dict:
    e = next((x for x in _entries() if x["key"] == key), None)
    if e is None:
        raise ValueError(f"Unknown model: {key}")
    if e["required"] or not e["managed"]:
        raise ValueError(f"{e['name']} can't be removed")
    with _lock:
        if key in _queue or (_jobs.get(key) or {}).get("state") == "downloading":
            raise ValueError(f"{e['name']} is downloading")
        _jobs.pop(key, None)
    if key == "cuda":
        d = cuda_site()
        (d / ".complete").unlink(missing_ok=True)       # the CPU runtime is used again from the next start
        os.environ["PYTHONPATH"] = os.pathsep.join(
            p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p and p != str(d))
        os.environ.pop("SCORE_STUDIO_CUDA_SITE", None)
        shutil.rmtree(d, ignore_errors=True)           # loaded DLLs may stay until restart; the rest goes now
        return status()
    ck = _mt3_ckpt(key)
    ck.unlink(missing_ok=True)
    shutil.rmtree(ck.parent.parent, ignore_errors=True)          # logs/2024/<exp>
    return status()


# ----------------------------------------------------------------------------- storage
_app_size: tuple[float, int | None] = (0.0, None)
_app_lock = threading.Lock()


def _app_dirs() -> list[Path]:
    """Code + Python runtime(s): dev repo (backend, web/dist, .venv[-mt3]), Docker (/app, /usr/local, /opt/venv-mt3)
    or the portable desktop folder (app, runtime)."""
    import sys
    from . import store
    portable = store.ROOT.parent / "runtime"           # desktop: <root>/app is store.ROOT
    if os.environ.get("SCORE_STUDIO_DESKTOP") and portable.is_dir():
        dirs = [store.ROOT, portable]
    else:
        dirs = [store.ROOT / "backend", store.ROOT / "web" / "dist", Path(sys.prefix)]
        mt3_py = multi.mt3_python()
        if mt3_py is not None:
            dirs.append(mt3_py.parent.parent)          # .venv-mt3 / /opt/venv-mt3
    dirs = [d.resolve() for d in dirs if d.is_dir()]
    return [d for d in dirs if not any(o != d and o in d.parents for o in dirs)]


def _compute_app():
    global _app_size
    total = sum(_size(d) for d in _app_dirs())
    _app_size = (time.monotonic(), total)


def app_bytes() -> int | None:
    """Install size (code + runtime), computed in the background and cached for 10 minutes."""
    with _app_lock:
        stamp, value = _app_size
        if value is None or time.monotonic() - stamp > 600:
            if not getattr(app_bytes, "_running", False):
                app_bytes._running = True

                def job():
                    try:
                        _compute_app()
                    finally:
                        app_bytes._running = False
                threading.Thread(target=job, name="app-size", daemon=True).start()
        return value


def storage() -> dict:
    from . import store
    items = []
    for p in store.all_projects():
        m = p.meta()
        items.append(dict(id=p.id, title=m["title"], source=m["source"], status=m["status"], created=m["created"],
                          bytes=_size(p.dir)))
    models_bytes = sum(e["bytes"] or 0 for e in _entries() if e["installed"] and e["key"] != "cuda")
    disk = shutil.disk_usage(store.DATA)
    return dict(data_dir=str(store.DATA), disk_free=disk.free, disk_total=disk.total,
                projects=dict(bytes=sum(i["bytes"] for i in items), count=len(items), items=items),
                models=dict(bytes=models_bytes), app=dict(bytes=app_bytes()))
