"""Per-project engraving cache: inputs + phase 1 are loaded once, renders are memoised
by (settings, edit state)."""
from __future__ import annotations

import hashlib
import json
import threading
import types
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .engrave import studio
from .engrave.config import Config
from .engrave.inputs import Inputs
from .store import Project, DEFAULT_HEADER, DEFAULT_SETTINGS


@dataclass
class Loaded:
    inp: Inputs
    p1: studio.Phase1
    key: str = ""
    result: studio.Result | None = None


_cache: dict[str, Loaded] = {}
_locks: dict[str, threading.RLock] = {}
_glock = threading.Lock()


def lock_for(pid: str) -> threading.RLock:
    with _glock:
        return _locks.setdefault(pid, threading.RLock())


def make_config(settings: dict) -> Config:
    s = dict(DEFAULT_SETTINGS)
    s.update(settings or {})
    return Config(max_voices=int(s["max_voices"]), auto_keys=bool(s["auto_keys"]),
                  auto_spelling=bool(s["auto_spelling"]), auto_runs=bool(s["auto_runs"]),
                  hand_span=int(s["hand_span"]), show_pedal=bool(s["show_pedal"]),
                  show_dynamics=bool(s["show_dynamics"]), show_tempo=bool(s["show_tempo"]))


def load_inputs(project: Project) -> Inputs:
    from duet.midi import read_performance_midi
    a = project.analysis
    z = np.load(a / "score.npz", allow_pickle=False)
    score = types.SimpleNamespace(**{k: z[k] for k in ("notes", "bar_starts", "bar_lengths", "meters", "voices", "keys")})
    data = read_performance_midi(project.performance)
    frames = pd.read_csv(a / "frames.csv")
    return Inputs.from_prediction(data, score, frames)


def _loaded(project: Project) -> Loaded:
    L = _cache.get(project.id)
    if L is None:
        inp = load_inputs(project)
        meta = project.meta()
        p1 = studio.phase1(inp, make_config(meta["settings"]), meta["title"])
        L = Loaded(inp=inp, p1=p1)
        _cache[project.id] = L
    return L


def forget(pid: str):
    _cache.pop(pid, None)


def render(project: Project, edits: dict | None = None, settings: dict | None = None) -> studio.Result:
    """Render the current (or given) edit state; memoised. State is read under the project lock."""
    with lock_for(project.id):
        meta = project.meta()
        settings = settings if settings is not None else meta["settings"]
        edits = edits if edits is not None else project.edit_state()
        header = dict(DEFAULT_HEADER, **(meta.get("header") or {}))
        key = hashlib.sha1(json.dumps([settings, edits, meta["title"], header], sort_keys=True).encode()).hexdigest()
        L = _loaded(project)
        if L.key == key and L.result is not None:
            return L.result
        cfg = make_config(settings)
        L.p1.ctx.title = meta["title"]
        L.p1.ctx.header = header
        res = studio.render(L.inp, L.p1, cfg, edits)
        L.key, L.result = key, res
        (project.dir / "score.musicxml").write_text(res.xml, encoding="utf-8")
        return res


def public_doc(project: Project, res: studio.Result) -> dict:
    meta = project.meta()
    h = project.history()
    doc = {k: v for k, v in res.doc.items() if not k.startswith("_")}
    doc["meta"] = dict(doc["meta"], has_audio=meta["source"] == "audio")
    doc.update(id=project.id, title=meta["title"], version=meta.get("version", 0),
               header=dict(DEFAULT_HEADER, **(meta.get("header") or {})),
               settings=dict(DEFAULT_SETTINGS, **meta["settings"]),
               history=dict(can_undo=h["pos"] > 0, can_redo=h["pos"] < len(h["states"]) - 1, edits=h["pos"]))
    return doc
