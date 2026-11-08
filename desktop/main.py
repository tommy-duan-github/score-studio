"""Score Studio desktop app: the backend in-process plus a native window (WebView2 via pywebview).

Run by ScoreStudio.exe with the bundled runtime (``runtime\\python\\pythonw.exe app\\desktop\\main.py``), or in
development with ``.venv\\Scripts\\python desktop\\main.py`` (needs ``pip install pywebview``).

Portable layout (everything next to ScoreStudio.exe; nothing is written outside it)::

    ScoreStudio.exe
    runtime\\python\\        Python 3.12 + backend packages (torch, DuET, Transkun, pywebview)
    runtime\\mt3-site\\      YourMT3+ packages layered over it (optional)
    runtime\\bin\\           ffmpeg.exe, ffprobe.exe
    app\\backend\\, app\\web\\dist\\, app\\desktop\\
    models\\hf\\             DuET weights (Hugging Face cache layout), downloaded on first start
    models\\YourMT3\\        YourMT3+ code + checkpoints (optional), downloaded on demand
    data\\                   projects, settings, logs, WebView profile
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORTABLE = (HERE.parent / "backend").is_dir() and (HERE.parents[1] / "runtime").is_dir()
ROOT = HERE.parents[1] if PORTABLE else HERE.parent          # portable root / repo root
APP = HERE.parent                                            # holds backend/ and web/dist
DATA = Path(os.environ.get("SCORE_STUDIO_DATA") or (ROOT / "data"))
TITLE = "Score Studio"


def _setup_env():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "logs").mkdir(exist_ok=True)
    env = os.environ
    env.setdefault("SCORE_STUDIO_DATA", str(DATA))
    env.setdefault("SCORE_STUDIO_DESKTOP", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    if PORTABLE:
        env["HF_HOME"] = str(ROOT / "models" / "hf")
        env["HF_HUB_OFFLINE"] = "1"
        env["YOURMT3_HOME"] = str(ROOT / "models" / "YourMT3")      # checkpoints are downloaded here on demand
        if (ROOT / "runtime" / "mt3-site").is_dir():
            env["SCORE_STUDIO_MT3_PYTHON"] = str(ROOT / "runtime" / "python" / "python.exe")
            env["SCORE_STUDIO_MT3_PATH"] = str(ROOT / "runtime" / "mt3-site")
        bin_dir = ROOT / "runtime" / "bin"
        if bin_dir.is_dir():
            env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
        cuda = ROOT / "runtime" / "cuda-site"
        if (cuda / ".complete").is_file():            # optional GPU runtime (Settings > Storage)
            sys.path.insert(0, str(cuda))
            env["PYTHONPATH"] = str(cuda) + os.pathsep + env.get("PYTHONPATH", "")
            env["SCORE_STUDIO_CUDA_SITE"] = str(cuda)
        rev = ROOT / "models" / "duet-revision.txt"
        if rev.is_file():
            env.setdefault("SCORE_STUDIO_DUET_REVISION", rev.read_text().strip())
    # pythonw has no console: send output to a log file (tqdm & uvicorn write to stderr)
    if sys.stdout is None or sys.stderr is None or PORTABLE:
        log = open(DATA / "logs" / "desktop.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
    print(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} start (portable={PORTABLE}, root={ROOT})", flush=True)


def _free_port(preferred: int = 19288) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port")


def _single_instance():
    """Second launch: focus is not possible across processes cheaply, so show a message and exit."""
    lock = DATA / ".desktop.lock"
    try:
        import msvcrt
        f = open(lock, "a+")
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        return f
    except (ImportError, OSError):
        if sys.platform == "win32":
            _message("Score Studio is already running.")
            sys.exit(0)
        return None


def _message(text: str):
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, TITLE, 0x40)
    else:
        print(text)


def main():
    _setup_env()
    lock = _single_instance()
    sys.path.insert(0, str(APP / "backend"))
    os.chdir(APP / "backend")
    import uvicorn
    from app.main import app

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False))
    thread = threading.Thread(target=server.run, name="uvicorn", daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}/"
    for _ in range(600):                          # importing torch can take a while on first start
        if not thread.is_alive():
            raise RuntimeError("The backend stopped while starting; see data\\logs\\desktop.log")
        try:
            urllib.request.urlopen(url + "healthz", timeout=1)
            break
        except OSError:
            time.sleep(0.1)

    import webview
    if sys.platform == "win32":                   # own taskbar group + icon instead of Python's
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("TommyDuan.ScoreStudio")
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False
    window = webview.create_window(TITLE, url, width=1480, height=920, min_size=(980, 640),
                                   background_color="#100d15", text_select=True)
    icon = APP / "desktop" / "icon.ico"

    def set_icon():
        """pywebview's WinForms window takes the icon of python(w).exe; use ours."""
        if sys.platform != "win32" or not icon.is_file():
            return
        try:
            from System import Action
            from System.Drawing import Icon
            form = window.native
            form.Invoke(Action(lambda: setattr(form, "Icon", Icon(str(icon)))))
        except Exception:
            traceback.print_exc()

    window.events.shown += set_icon
    try:
        webview.start(private_mode=False, storage_path=str(DATA / "webview"),
                      debug=bool(os.environ.get("SCORE_STUDIO_DEBUG")))
    finally:
        server.should_exit = True                 # runs the app's shutdown: stops the transcription worker
        thread.join(timeout=20)
        if lock:
            lock.close()
    del window


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        _message("Score Studio could not start:\n\n" + traceback.format_exc(limit=3)
                 + f"\nLog: {DATA / 'logs' / 'desktop.log'}")
        sys.exit(1)
