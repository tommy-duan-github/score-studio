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
    base_parts: list | None = None        # parts.json as transcribed, before user overrides


PART_KEYS = ("name", "program", "clef")


def apply_part_overrides(L: Loaded, overrides: dict):
    """User renames / instrument changes (meta["part_overrides"]: {part id: {name, program, clef}}) on top of the
    transcribed parts. Clef applies to single-staff parts only; kind and staves never change."""
    from .engrave.parts import score_parts
    if L.inp.parts is not None:
        if L.base_parts is None:
            L.base_parts = [dict(p) for p in L.inp.parts]
        L.inp.parts = [dict(p, **{k: v for k, v in (overrides.get(p["id"]) or {}).items()
                                  if k in PART_KEYS and (k != "clef" or p["kind"] == "single")})
                       for p in L.base_parts]
    parts = score_parts(L.inp)
    if L.inp.parts is None:               # classic piano project: one grand part P1
        o = overrides.get("P1") or {}
        parts[0].update({k: o[k] for k in ("name", "program") if k in o})
    L.p1.ctx.parts = parts
    L.p1.ctx.part_overrides = overrides


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
    inp = Inputs.from_prediction(data, score, frames)
    if (a / "parts.json").is_file():
        parts = json.loads((a / "parts.json").read_text(encoding="utf-8"))
        inp.parts, inp.part_of = parts["parts"], parts["part_of"]
        from .engrave.parts import validate
        validate(inp)
    return inp


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
        overrides = meta.get("part_overrides") or {}
        key = hashlib.sha1(json.dumps([settings, edits, meta["title"], header, overrides], sort_keys=True).encode()).hexdigest()
        L = _loaded(project)
        if L.key == key and L.result is not None:
            return L.result
        apply_part_overrides(L, overrides)
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
