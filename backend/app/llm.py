"""DeepSeek-backed engraving assistant (OpenAI-compatible chat completions API).

The model never writes MusicXML. It sees a compact text view of the selected bars and
answers with structured edit proposals (the same ops as POST /edits), which are validated
by dry-running them before they reach the UI.
"""
from __future__ import annotations

import json
import os
import re

import httpx

from . import store
from .edits import apply_ops, EditError

DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE = "https://api.deepseek.com"
KEY_NAMES = {-7: "Cb/Abm", -6: "Gb/Ebm", -5: "Db/Bbm", -4: "Ab/Fm", -3: "Eb/Cm", -2: "Bb/Gm", -1: "F/Dm", 0: "C/Am",
             1: "G/Em", 2: "D/Bm", 3: "A/F#m", 4: "E/C#m", 5: "B/G#m", 6: "F#/D#m", 7: "C#/A#m"}


def settings() -> dict:
    c = store.app_config().get("llm", {})
    key = c.get("api_key") or os.environ.get("DEEPSEEK_API_KEY")
    return dict(api_key=key, model=c.get("model") or DEFAULT_MODEL, base_url=(c.get("base_url") or DEFAULT_BASE).rstrip("/"))


def public_settings() -> dict:
    s = settings()
    k = s["api_key"]
    return dict(configured=bool(k), model=s["model"], base_url=s["base_url"],
                key_hint=(k[:3] + "…" + k[-4:]) if k and len(k) > 10 else None)


def save_settings(api_key=None, model=None, base_url=None):
    def change(llm: dict) -> dict:
        if api_key is not None:
            llm["api_key"] = api_key.strip() or None
        if model:
            llm["model"] = model.strip()
        if base_url:
            llm["base_url"] = base_url.strip()
        return llm
    store.update_app_config("llm", change)


SYSTEM = """You are an expert piano engraver helping a pianist clean up an automatically transcribed piano score.
You see a compact text view of some bars and answer with concrete, minimal edit proposals.

Score view format:
- One block per bar: `bar N (time, key)`, then one line per staff+voice: `RH v1:` / `LH v2:` …
- Each event is `[id name, id name, …]@beat~dur` (beat = position in the bar in quarter notes from 0,
  dur = written length in quarter notes; a chord lists all its notes). `g` marks grace notes.
- RH = upper staff (staff 1), LH = lower staff (staff 2). Voices per staff: v1 top (stems up), v2 bottom
  (stems down), v3 upper-middle (up), v4 lower-middle (down). Up to 4 voices per staff are allowed.

Edit ops you may propose (JSON objects; `ids` are the numeric note ids shown in the view):
  {"op":"set_staff","ids":[..],"staff":1|2}          move notes to the right-hand / left-hand staff
  {"op":"set_voice","ids":[..],"voice":1|2|3|4}      put notes in a voice of their staff
  {"op":"set_duration","ids":[..],"dur":Q}           written length in quarter notes (0.25=16th, 0.5=8th, 1=quarter, 1.5, 2, 3, 4…)
  {"op":"shift","ids":[..],"delta":Q}                move onsets by Q quarters (negative = earlier)
  {"op":"transpose","ids":[..],"semitones":K}        fix a wrong pitch (only if clearly a transcription error)
  {"op":"respell","ids":[..],"prefer":"sharp"|"flat"|"auto"}
  {"op":"set_grace","ids":[..],"grace":true|false}
  {"op":"merge_chord","ids":[..]}                    make near-simultaneous notes one chord
  {"op":"delete","ids":[..]}                         remove a spurious/ghost note
  {"op":"add_note","pitch":MIDI,"on":Q,"dur":Q,"staff":1|2,"voice":1..4}   (on = absolute position in quarters from the start of the piece; bar start positions are given)
  {"op":"set_key","measure":INDEX,"fifths":-7..7}   (measure INDEX = bar number shown minus the offset given)

Principles: readability for a pianist first; keep what was played; prefer fewer voices when notes share
rhythm, separate voices only for genuinely independent lines (held melody/bass under moving notes);
keep each hand within a playable span; respect the user's request precisely; do not invent music.

Reply ONLY with a JSON object:
{"reply": "short explanation for the pianist (plain text, may be a few sentences)",
 "proposals": [{"title": "short imperative title", "explanation": "why", "ops": [ ... ]}]}
Give 0–4 proposals. If the request is only a question, answer it and return an empty proposals list."""


def staff_label(doc: dict, staff: int) -> str:
    """RH / LH for a piano score; multi-instrument scores: the part name (+ RH/LH on keyboard parts)."""
    parts = doc.get("parts") or []
    if len(parts) <= 1 and (not parts or parts[0].get("kind") == "grand"):
        return "RH" if staff == 1 else "LH"
    for p in parts:
        if staff in p["staves"]:
            if len(p["staves"]) == 2:
                return f"{p['name']} {'RH' if staff == p['staves'][0] else 'LH'} (staff {staff})"
            return f"{p['name']} (staff {staff})"
    return f"staff {staff}"


def score_view(doc: dict, measures: list[int]) -> str:
    by_m = {m["index"]: m for m in doc["measures"]}
    lines = []
    off = doc["measures"][0]["number"] - doc["measures"][0]["index"] if doc["measures"] else 1
    lines.append(f"Bar number = measure INDEX + {off}. Main meter {doc['meta'].get('meter')}, tempo ♩={doc['meta'].get('tempo')}.")
    for mi in measures:
        m = by_m.get(mi)
        if m is None:
            continue
        ns = [n for n in doc["notes"] if n["measure"] == mi and not n["deleted"]]
        lines.append(f"bar {m['number']} ({m['time'][0]}/{m['time'][1]}, key {KEY_NAMES.get(m['key'], m['key'])}, starts at {m['start']:g})")
        groups = {}
        for n in ns:
            groups.setdefault((n["staff"], n["voice"]), {}).setdefault((n["beat"], n["dur"], n["grace"]), []).append(n)
        for (staff, voice) in sorted(groups):
            evs = []
            for (beat, dur, grace), grp in sorted(groups[(staff, voice)].items(), key=lambda kv: (kv[0][0], not kv[0][2])):
                names = ", ".join(f"{n['id']} {n['name']}" for n in sorted(grp, key=lambda n: -n["pitch"]))
                evs.append(f"[{names}]@{beat:g}~{dur:g}{' g' if grace else ''}")
            lines.append(f"  {staff_label(doc, staff)} v{voice}: " + "  ".join(evs))
        if not ns:
            lines.append("  (empty)")
    return "\n".join(lines)


def pick_measures(doc: dict, note_ids, measure_numbers) -> list[int]:
    nmeas = len(doc["measures"])
    num_to_idx = {m["number"]: m["index"] for m in doc["measures"]}
    if measure_numbers and len(measure_numbers) == 2:
        a, b = sorted(measure_numbers)
        idx = [num_to_idx[k] for k in range(a, b + 1) if k in num_to_idx]
    elif note_ids:
        ids = set(int(i) for i in note_ids)
        ms = sorted({n["measure"] for n in doc["notes"] if n["id"] in ids and n["measure"] is not None})
        idx = list(range(max(0, ms[0] - 1), min(nmeas, ms[-1] + 2))) if ms else []
    else:
        idx = []
    if not idx:
        idx = list(range(min(8, nmeas)))
    return idx[:16]


def _extract_json(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def ask(doc: dict, raw_review: dict, state: dict, message: str, note_ids=None, measures=None, history=None) -> dict:
    s = settings()
    if not s["api_key"]:
        raise PermissionError("No DeepSeek API key configured")
    midx = pick_measures(doc, note_ids, measures)
    view = score_view(doc, midx)
    sel = ""
    if note_ids:
        names = {n["id"]: n["name"] for n in doc["notes"]}
        sel = "Currently selected notes: " + ", ".join(f"{i} {names.get(int(i), '?')}" for i in note_ids[:60]) + "\n"
    rv = [r for r in doc.get("review", []) if r.get("measures") and any(
        doc["measures"][i]["number"] in range(r["measures"][0], r["measures"][1] + 1) for i in midx)]
    rv_txt = ("Engraver's own doubts in these bars:\n" + "\n".join(f"- {r['question']}" for r in rv[:6]) + "\n") if rv else ""
    user = f"{sel}{rv_txt}Score view:\n{view}\n\nPianist's request: {message}"
    msgs = [{"role": "system", "content": SYSTEM}]
    for h in (history or [])[-6:]:
        if h.get("role") in ("user", "assistant") and isinstance(h.get("content"), str):
            msgs.append({"role": h["role"], "content": h["content"][:4000]})
    msgs.append({"role": "user", "content": user})
    # Current DeepSeek models reason before answering; the budget covers reasoning + answer.
    body = dict(model=s["model"], messages=msgs, temperature=0.2, response_format={"type": "json_object"}, max_tokens=16000)
    content, finish = "", None
    for attempt in range(2):          # one retry: an empty answer is usually a transient hiccup
        r = httpx.post(f"{s['base_url']}/chat/completions", json=body, timeout=240,
                       headers={"Authorization": f"Bearer {s['api_key']}", "Content-Type": "application/json"})
        if r.status_code >= 400:
            raise RuntimeError(f"DeepSeek API error {r.status_code}: {r.text[:300]}")
        choice = r.json()["choices"][0]
        content, finish = (choice["message"].get("content") or "").strip(), choice.get("finish_reason")
        if content:
            break
    if not content:
        raise RuntimeError("the model ran out of tokens while thinking; try a smaller bar range" if finish == "length"
                           else "the model returned an empty answer; please try again")
    try:
        out = _extract_json(content)
    except json.JSONDecodeError:
        raise RuntimeError("the model's answer was not valid JSON" + (" (cut off)" if finish == "length" else ""))
    proposals = []
    for p in (out.get("proposals") or [])[:4]:
        ops = p.get("ops") or []
        valid, err = True, None
        try:
            apply_ops(state, ops, doc, raw_review)
        except (EditError, KeyError, TypeError, ValueError) as e:
            valid, err = False, str(e)
        proposals.append(dict(title=str(p.get("title", "Proposal"))[:120], explanation=str(p.get("explanation", ""))[:1500],
                              ops=ops, valid=valid, error=err))
    return dict(reply=str(out.get("reply", "")), proposals=proposals,
                context=dict(measures=[doc["measures"][i]["number"] for i in midx]))
