"""On-disk project storage.

data/
  config.json                      (LLM settings)
  projects/<id>/
    meta.json                      (title, status, progress, settings, version, …)
    source.<ext>                   (uploaded file)
    analysis/                      (DuET run: score.npz, frames.csv, …; parts.json for multi-instrument projects)
    performance.mid                (the performance MIDI that DuET read)
    history.json                   (edit states for undo/redo)
    score.musicxml                 (last engraving)
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("SCORE_STUDIO_DATA", ROOT / "data"))
PROJECTS = DATA / "projects"
PROJECTS.mkdir(parents=True, exist_ok=True)

AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".ogg"}
MIDI_EXT = {".mid", ".midi"}

DEFAULT_SETTINGS = dict(max_voices=3, auto_keys=True, auto_spelling=True, auto_runs=True, hand_span=14,
                        show_pedal=False, show_dynamics=True, show_tempo=True)
# Title block on page 1 / in MusicXML exports. Empty title = the project title. Sizes: percent of normal text.
DEFAULT_HEADER = dict(title="", subtitle="", composer="", title_size=250, subtitle_size=120, composer_size=110, show=True)

INSTRUMENTS = ("piano", "multi")     # piano: Transkun + one piano part; multi: YourMT3+ (audio) / MIDI tracks -> parts

_lock = threading.RLock()


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write(path: Path, text: str):
    # Unique temp name: the server and a transcription subprocess may write the same file.
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(3)}.tmp")
    tmp.write_text(text, encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:          # Windows: a reader has the target open for a moment
            if attempt == 19:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def _flock(path: Path) -> FileLock:
    """Cross-process lock (server + transcription subprocess) for read-modify-write of one file."""
    return FileLock(str(path.with_name("." + path.name + ".lock")), timeout=30)


class Project:
    def __init__(self, pid: str):
        self.id = pid
        self.dir = PROJECTS / pid

    # ---- meta
    @property
    def meta_path(self):
        return self.dir / "meta.json"

    def meta(self) -> dict:
        with _lock:
            return json.loads(self.meta_path.read_text(encoding="utf-8"))

    def update(self, **kw) -> dict:
        with _lock, _flock(self.meta_path):
            m = self.meta()
            m.update(kw)
            _atomic_write(self.meta_path, json.dumps(m, indent=1))
            return m

    def exists(self):
        return self.meta_path.is_file()

    # ---- files
    @property
    def source(self) -> Path:
        return self.dir / self.meta()["source_file"]

    @property
    def analysis(self) -> Path:
        return self.dir / "analysis"

    @property
    def performance(self) -> Path:
        return self.dir / "performance.mid"

    # ---- edit history
    @property
    def history_path(self):
        return self.dir / "history.json"

    def history(self) -> dict:
        with _lock:
            if not self.history_path.is_file():
                return dict(states=[{}], labels=["original"], ops=[[]], times=[now()], pos=0)
            return json.loads(self.history_path.read_text(encoding="utf-8"))

    def save_history(self, h: dict):
        with _lock, _flock(self.history_path):
            _atomic_write(self.history_path, json.dumps(h))

    def edit_state(self) -> dict:
        h = self.history()
        return h["states"][h["pos"]]

    def public(self) -> dict:
        m = self.meta()
        return dict(id=self.id, title=m["title"], source=m["source"], created=m["created"], status=m["status"],
                    progress=m.get("progress"), error=m.get("error"), has_audio=m["source"] == "audio",
                    version=m.get("version", 0), bars=m.get("bars"), instruments=m.get("instruments", "piano"),
                    mt3_model=m.get("mt3_model"), parts=m.get("parts"))


def create(filename: str, data_stream, title: str | None, instruments: str = "piano", mt3_model: str | None = None) -> Project:
    ext = Path(filename).suffix.lower()
    if ext not in AUDIO_EXT | MIDI_EXT:
        raise ValueError(f"Unsupported file type {ext!r}")
    if instruments not in INSTRUMENTS:
        raise ValueError(f"instruments must be one of {', '.join(INSTRUMENTS)}")
    pid = secrets.token_hex(4)
    p = Project(pid)
    p.dir.mkdir(parents=True)
    src = p.dir / f"source{ext}"
    with src.open("wb") as f:
        shutil.copyfileobj(data_stream, f)
    meta = dict(id=pid, title=title or Path(filename).stem, created=now(), source="audio" if ext in AUDIO_EXT else "midi",
                source_file=src.name, original_name=filename, status="queued",
                progress=dict(stage="queued", fraction=0.0, message="Waiting in queue…"), error=None,
                settings=dict(DEFAULT_SETTINGS), version=0, bars=None, instruments=instruments,
                mt3_model=mt3_model if instruments == "multi" else None)
    _atomic_write(p.meta_path, json.dumps(meta, indent=1))
    return p


def get(pid: str) -> Project | None:
    if not pid.isalnum():
        return None
    p = Project(pid)
    return p if p.exists() else None


def all_projects() -> list[Project]:
    out = []
    for d in PROJECTS.iterdir():
        if (d / "meta.json").is_file():
            out.append(Project(d.name))
    out.sort(key=lambda p: p.meta()["created"], reverse=True)
    return out


def delete(p: Project):
    shutil.rmtree(p.dir, ignore_errors=True)


# ---- app config (LLM)
CONFIG = DATA / "config.json"


def app_config() -> dict:
    if CONFIG.is_file():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {}


def save_app_config(cfg: dict):
    with _lock, _flock(CONFIG):
        _atomic_write(CONFIG, json.dumps(cfg, indent=1))


def update_app_config(section: str, fn) -> dict:
    """Locked read-modify-write of one section of config.json; fn(old_section) -> new_section."""
    with _lock, _flock(CONFIG):
        cfg = app_config()
        cfg[section] = fn(dict(cfg.get(section) or {}))
        _atomic_write(CONFIG, json.dumps(cfg, indent=1))
        return cfg[section]
