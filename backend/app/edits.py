"""Edit operations (docs/API.md) -> cumulative edit state (engrave/studio.py format).

``apply_ops(state, ops, doc, raw_review)`` returns a new state; it never mutates its inputs and
raises ``EditError`` for invalid ops (nothing is applied).
"""
from __future__ import annotations

import copy
from fractions import Fraction as F

from .engrave.studio import ADDED_BASE, prefer_spelling, STEP_PC


class EditError(ValueError):
    pass


def _f(v) -> str:
    try:
        x = F(v).limit_denominator(48) if not isinstance(v, str) else F(v)
    except (ValueError, ZeroDivisionError, TypeError):
        raise EditError(f"bad number {v!r}")
    return str(x)


OPS = {"set_staff", "set_voice", "set_duration", "shift", "transpose", "respell", "set_grace", "merge_chord",
       "delete", "restore", "add_note", "reset", "set_key", "resolve_review"}


def _parse_name(name: str):
    step = name[0].upper()
    rest = name[1:]
    alt = rest.count('#') - rest.count('b') + 2 * rest.count('x')
    return step, alt


def apply_ops(state: dict, ops: list, doc: dict, raw_review: dict | None = None) -> dict:
    if not isinstance(ops, list) or not ops:
        raise EditError("ops must be a non-empty list")
    st = copy.deepcopy(state) if state else {}
    st.setdefault("notes", {})
    st.setdefault("added", [])
    st.setdefault("keys", {})
    st.setdefault("resolved", {})
    notes = {n["id"]: dict(n) for n in doc["notes"]}
    parts = doc.get("parts") or [dict(id="P1", kind="grand", staves=[1, 2])]
    staff_part = {s: p for p in parts for s in p["staves"]}
    measures = doc["measures"]
    pickup = doc["meta"].get("pickup", 0) > 0

    def ids_of(op, need=True):
        ids = op.get("ids")
        if not isinstance(ids, list) or (need and not ids):
            raise EditError(f"{op.get('op')}: ids must be a non-empty list")
        out = []
        for i in ids:
            try:
                i = int(i)
            except (TypeError, ValueError):
                raise EditError(f"bad note id {i!r}")
            if i not in notes:
                raise EditError(f"unknown note id {i}")
            out.append(i)
        return out

    def ov(i):
        return st["notes"].setdefault(str(i), {})

    for op in ops:
        if not isinstance(op, dict) or op.get("op") not in OPS:
            raise EditError(f"unknown op {op!r}"[:200])
        kind = op["op"]
        if kind == "set_staff":
            s = op.get("staff")
            if s not in staff_part:
                raise EditError("staff must belong to a score part")
            for i in ids_of(op):
                p = staff_part[notes[i]["staff"]]
                if p["kind"] != "grand" or s not in p["staves"]:
                    continue
                ov(i)["staff"] = s - 1
                notes[i]["staff"] = s
        elif kind == "set_voice":
            v = op.get("voice")
            if v not in (1, 2, 3, 4):
                raise EditError("voice must be 1..4")
            for i in ids_of(op):
                ov(i)["vpin"] = v
        elif kind == "set_duration":
            d = F(_f(op.get("dur")))
            if d <= 0 or d > 32:
                raise EditError("dur must be > 0")
            for i in ids_of(op):
                ov(i)["dur"] = str(d)
                notes[i]["dur"] = float(d)
        elif kind == "shift":
            delta = F(_f(op.get("delta")))
            for i in ids_of(op):
                on = F(_f(notes[i]["on"])) + delta
                if on < 0:
                    raise EditError("note would move before the start")
                ov(i)["on"] = str(on)
                notes[i]["on"] = float(on)
        elif kind == "transpose":
            k = op.get("semitones")
            if not isinstance(k, int) or not -48 <= k <= 48:
                raise EditError("semitones must be an integer")
            for i in ids_of(op):
                p = notes[i]["pitch"] + k
                if not 21 <= p <= 108:
                    raise EditError("pitch out of piano range")
                o = ov(i)
                o["pitch"] = p
                o.pop("spell", None)
                notes[i]["pitch"] = p
        elif kind == "respell":
            pref = op.get("prefer")
            if pref not in ("sharp", "flat", "auto"):
                raise EditError("prefer must be sharp, flat or auto")
            for i in ids_of(op):
                o = ov(i)
                if pref == "auto":
                    o.pop("spell", None)
                else:
                    o["spell"] = prefer_spelling(notes[i]["pitch"], pref)
        elif kind == "set_grace":
            g = bool(op.get("grace"))
            for i in ids_of(op):
                ov(i)["grace"] = g
        elif kind == "merge_chord":
            ids = ids_of(op)
            on = min(F(_f(notes[i]["on"])) for i in ids)
            d = max(F(_f(notes[i]["dur"])) for i in ids)
            for i in ids:
                o = ov(i)
                o["on"], o["dur"] = str(on), str(d)
                notes[i]["on"], notes[i]["dur"] = float(on), float(d)
        elif kind == "delete":
            for i in ids_of(op):
                ov(i)["deleted"] = True
        elif kind == "restore":
            for i in ids_of(op):
                ov(i).pop("deleted", None)
        elif kind == "reset":
            for i in ids_of(op):
                st["notes"].pop(str(i), None)
        elif kind == "add_note":
            p, s = op.get("pitch"), op.get("staff", 1)
            if not isinstance(p, int) or not 21 <= p <= 108:
                raise EditError("pitch must be a MIDI number 21..108")
            if s not in staff_part:
                raise EditError("staff must belong to a score part")
            on, d = F(_f(op.get("on"))), F(_f(op.get("dur", 1)))
            if on < 0 or d <= 0:
                raise EditError("bad onset/duration")
            nid = max([a["id"] for a in st["added"]] + [ADDED_BASE - 1]) + 1
            v = op.get("voice")
            st["added"].append(dict(id=nid, pitch=p, on=str(on), dur=str(d), staff=s - 1,
                                    vpin=v if v in (1, 2, 3, 4) else None))
            notes[nid] = dict(id=nid, pitch=p, on=float(on), dur=float(d), staff=s,
                              part=staff_part[s]["id"], measure=None)
        elif kind == "set_key":
            m, f = op.get("measure"), op.get("fifths")
            if not isinstance(m, int) or not 0 <= m < len(measures):
                raise EditError("measure must be a measure index")
            if not isinstance(f, int) or not -7 <= f <= 7:
                raise EditError("fifths must be -7..7")
            cur = measures[m]["key"]
            j = m
            while j < len(measures) and measures[j]["key"] == cur:
                st["keys"][str(j)] = f
                j += 1
        elif kind == "resolve_review":
            rid, k = op.get("review_id"), op.get("option")
            item = (raw_review or {}).get(rid)
            if item is None:
                raise EditError(f"unknown review item {rid!r}")
            if not isinstance(k, int) or not 0 <= k < len(item["options"]):
                raise EditError("bad option index")
            edit = item["options"][k].get("edit") or {}
            _apply_review_edit(st, edit, notes, measures, pickup)
            st["resolved"][rid] = k
    return st


def _apply_review_edit(st, edit, notes, measures, pickup):
    off = 0 if pickup else 1
    if "keys" in edit:
        changes = sorted((int(num) - off, int(f)) for num, f in edit["keys"])
        keys = [m["key"] for m in measures]
        for idx, (m0, f) in enumerate(changes):
            m1 = changes[idx + 1][0] if idx + 1 < len(changes) else len(keys)
            for m in range(max(0, m0), min(m1, len(keys))):
                if keys[m] != f:
                    st["keys"][str(m)] = f
    for sp in edit.get("spell") or []:
        bars = set()
        for part in str(sp["bars"]).split(","):
            a, _, b = part.partition("-")
            a = int(a); b = int(b) if b else a
            bars.update(range(a - off, b - off + 1))
        frm, to = _parse_name(sp["from"]), _parse_name(sp["to"])
        for n in notes.values():
            if n.get("measure") in bars and tuple(n.get("spell") or ()) == frm:
                st["notes"].setdefault(str(n["id"]), {})["spell"] = list(to)
    for ne in edit.get("notes") or []:
        t, _, p = str(ne["id"]).partition(":")
        t, p = float(t), int(p)
        match = [n for n in notes.values() if n.get("pitch") == p and abs(n.get("perf_on", -9) - t) < 0.0015
                 and (ne.get("part") is None or n.get("part", "P1") == ne["part"])]
        for n in match:
            o = st["notes"].setdefault(str(n["id"]), {})
            if "grace" in ne:
                o["grace"] = bool(ne["grace"])
            if "bar" in ne and "beat" in ne:
                m = int(ne["bar"]) - off
                if 0 <= m < len(measures):
                    o["on"] = str(F(str(measures[m]["start"])).limit_denominator(48) + F(ne["beat"]))
