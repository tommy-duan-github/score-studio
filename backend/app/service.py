"""Score operations shared by the HTTP API (main.py) and the MCP server (mcp.py). All functions are blocking."""
from __future__ import annotations

import io
import re

import mido

from . import engine, store, worker
from .edits import EditError, apply_ops


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def project(pid: str) -> store.Project:
    p = store.get(pid) if isinstance(pid, str) else None
    if p is None:
        raise ServiceError(404, "Unknown project")
    return p


def ready(pid: str) -> store.Project:
    p = project(pid)
    if p.meta()["status"] != "ready":
        raise ServiceError(409, "Project is not ready")
    return p


def bump(p: store.Project):
    p.update(version=p.meta().get("version", 0) + 1)


def _txn(p: store.Project):
    """Per-project transaction: edits, settings changes and document reads don't interleave."""
    return engine.lock_for(p.id + ":edit")


def doc(p: store.Project) -> dict:
    with _txn(p):
        return engine.public_doc(p, engine.render(p))


def xml(p: store.Project) -> str:
    with _txn(p):
        return engine.render(p).xml


# Characters XML 1.0 cannot carry (control characters, lone surrogates, U+FFFE/U+FFFF): they would break
# the MusicXML export and the engraver, so titles and header text reject them.
_XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


def _check_title(title) -> str:
    title = str(title or "").strip()
    if not title:
        raise ServiceError(422, "title required")
    if _XML_INVALID.search(title):
        raise ServiceError(422, "title contains characters that cannot be stored")
    return title[:200]


def rename(p: store.Project, title) -> store.Project:
    return update_project(p, title=title)


HEADER_TEXT = dict(title=200, subtitle=300, composer=200)
HEADER_SIZE = (40, 600)


def _check_header(body) -> dict:
    """Validate a partial title-block update; returns the cleaned fields."""
    if not isinstance(body, dict) or not body:
        raise ServiceError(422, "header object required")
    out = {}
    for k, v in body.items():
        if k not in store.DEFAULT_HEADER:
            raise ServiceError(422, f"unknown header field {k}")
        if k in HEADER_TEXT:
            if not isinstance(v, str):
                raise ServiceError(422, f"{k} must be a string")
            if len(v) > HEADER_TEXT[k]:
                raise ServiceError(422, f"{k} is longer than {HEADER_TEXT[k]} characters")
            if _XML_INVALID.search(v):
                raise ServiceError(422, f"{k} contains characters that cannot be stored")
            out[k] = v.strip()
        elif k == "show":
            if not isinstance(v, bool):
                raise ServiceError(422, "show must be true/false")
            out[k] = v
        elif not isinstance(v, (int, float)) or isinstance(v, bool) or not HEADER_SIZE[0] <= v <= HEADER_SIZE[1]:
            raise ServiceError(422, f"{k} must be {HEADER_SIZE[0]}..{HEADER_SIZE[1]}")
        else:
            out[k] = round(v)
    return out


def set_header(p: store.Project, body) -> store.Project:
    """Merge a partial title-block update (title/subtitle/composer text, *_size percentages, show)."""
    return update_project(p, header=body)


_UNSET = object()


def update_project(p: store.Project, title=_UNSET, header=_UNSET) -> store.Project:
    """Rename and/or edit the title block: everything is validated first, then saved with one version bump."""
    changes = {}
    if title is not _UNSET:
        changes["title"] = _check_title(title)
    if header is not _UNSET:
        patch = _check_header(header)
    if not changes and header is _UNSET:
        raise ServiceError(422, "title or header required")
    with _txn(p):
        if header is not _UNSET:
            changes["header"] = {**store.DEFAULT_HEADER, **(p.meta().get("header") or {}), **patch}
        p.update(**changes)
        if p.meta()["status"] == "ready":
            bump(p)
    return p


def retry(p: store.Project):
    worker.cancel(p.id)
    p.update(status="queued", error=None, progress=dict(stage="queued", fraction=0, message="Waiting in queue…"))
    worker.submit(p.id)


def delete(p: store.Project):
    worker.cancel(p.id)
    engine.forget(p.id)
    store.delete(p)


def update_settings(p: store.Project, body) -> dict:
    if not isinstance(body, dict) or not body:
        raise ServiceError(422, "settings object required")
    for k, v in body.items():
        if k not in store.DEFAULT_SETTINGS:
            raise ServiceError(422, f"unknown setting {k}")
        if isinstance(store.DEFAULT_SETTINGS[k], bool):
            if not isinstance(v, bool):
                raise ServiceError(422, f"{k} must be true/false")
        elif not isinstance(v, int) or isinstance(v, bool):
            raise ServiceError(422, f"{k} must be an integer")
        if k == "max_voices" and v not in (1, 2, 3, 4):
            raise ServiceError(422, "max_voices must be 1..4")
        if k == "hand_span" and not 7 <= v <= 24:
            raise ServiceError(422, "hand_span must be 7..24")
    with _txn(p):
        s = dict(p.meta()["settings"], **body)       # merge under the lock: concurrent changes don't undo each other
        p.update(settings=s)
        bump(p)
        return doc(p)


def edit(p: store.Project, ops, label=None) -> dict:
    if not isinstance(ops, list) or not ops:
        raise ServiceError(422, "ops must be a non-empty list")
    with _txn(p):
        res = engine.render(p)
        d = engine.public_doc(p, res)
        try:
            new_state = apply_ops(p.edit_state(), ops, d, res.doc.get("_review_raw"))
        except (EditError, KeyError, TypeError, ValueError) as e:
            raise ServiceError(422, str(e))
        try:                                   # validate by rendering before committing
            engine.render(p, new_state)
        except Exception as e:
            raise ServiceError(422, f"edit could not be engraved: {e}")
        h = p.history()
        pos = h["pos"]
        for k in ("states", "labels", "ops", "times"):
            h[k] = h[k][:pos + 1]
        h["states"].append(new_state)
        h["labels"].append(str(label or ", ".join(str(o.get("op", "?")) if isinstance(o, dict) else "?" for o in ops))[:120])
        h["ops"].append(ops)
        h["times"].append(store.now())
        h["pos"] = pos + 1
        p.save_history(h)
        bump(p)
        return doc(p)


def move(p: store.Project, step: int) -> dict:
    with _txn(p):
        h = p.history()
        pos = h["pos"] + step
        if not 0 <= pos < len(h["states"]):
            raise ServiceError(409, "Nothing to " + ("undo" if step < 0 else "redo"))
        h["pos"] = pos
        p.save_history(h)
        bump(p)
        return doc(p)


def history(p: store.Project) -> list[dict]:
    h = p.history()
    return [dict(index=i, label=h["labels"][i], ops=h["ops"][i], time=h["times"][i], current=i == h["pos"])
            for i in range(len(h["states"]))]


def score_midi_bytes(d: dict) -> bytes:
    tpq = 480
    tempo = d["meta"].get("tempo") or 120
    mf = mido.MidiFile(ticks_per_beat=tpq)
    for staff in (1, 2):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name="Right hand" if staff == 1 else "Left hand", time=0))
        if staff == 1:
            tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(tempo), time=0))
        ev = []
        for n in d["notes"]:
            if n["deleted"] or n["staff"] != staff:
                continue
            on = n["on"] - (0.12 if n["grace"] else 0)
            dur = 0.12 if n["grace"] else n["dur"]
            a, b = max(0, round(on * tpq)), max(1, round((on + dur) * tpq))
            vel = max(1, min(127, n["velocity"] or 64))
            ev.append((a, 1, mido.Message("note_on", note=n["pitch"], velocity=vel, channel=0)))
            ev.append((b, 0, mido.Message("note_off", note=n["pitch"], velocity=0, channel=0)))
        ev.sort(key=lambda e: (e[0], e[1]))
        t = 0
        for at, _, msg in ev:
            tr.append(msg.copy(time=at - t)); t = at
        mf.tracks.append(tr)
    buf = io.BytesIO()
    mf.save(file=buf)
    return buf.getvalue()
