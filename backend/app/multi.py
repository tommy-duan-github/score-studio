"""Multi-instrument transcription (experimental): audio -> YourMT3+ -> instrument parts.

YourMT3+ lives in its own environment (.venv-mt3) and is run as a subprocess (backend/mt3/ymt3_runner.py).
Its notes are grouped into score parts, drums are dropped, and the rest is written as a type-1 performance
MIDI with one track per part. ``analysis/parts.json`` (written next to DuET's analysis) records the parts
in score order and the part of every performance row, in the row order DuET's reader uses.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from collections import Counter, defaultdict, deque
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "backend" / "mt3" / "ymt3_runner.py"

# Checkpoints the runner knows (see ymt3_runner.MODELS); labels for the UI.
# Default: YPTF+Multi (PS) agreed best with the other checkpoints on a violin+piano test and invented no extra
# string parts (the MoE checkpoints added viola/cello parts for low notes); see docs/MULTI_INSTRUMENT.md.
MODELS = {
    "yptf-multi-ps": "YPTF+Multi (PS)",
    "moe-nops": "YPTF.MoE+Multi (noPS)",
    "moe-ps": "YPTF.MoE+Multi (PS)",
    "yptf-single": "YPTF+Single (noPS)",
    "ymt3+": "YMT3+",
}
DEFAULT_MODEL = "yptf-multi-ps"

# Lowest playable MIDI pitch: a note below it was really another instrument (usually the piano's bass).
LOWEST = {"Violin": 55, "Viola": 48, "Cello": 36, "Flute": 59, "Oboe": 58, "Clarinet": 50, "Trumpet": 52,
          "Alto Saxophone": 49, "Horn": 34, "Voice": 36}

# GM program -> instrument class (YourMT3's MT3_FULL_PLUS classes). name, kind, clef, score order
# kind: "grand" = two-staff keyboard part, "single" = one staff. Lower order = higher in the score.
_CLASSES = [
    # (programs, name, kind, clef, order)
    (range(100, 102), "Voice", "single", "G", 10),
    (range(72, 80), "Flute", "single", "G", 20),
    ([68, 69], "Oboe", "single", "G", 21),
    ([71], "Clarinet", "single", "G", 22),
    ([64, 65], "Alto Saxophone", "single", "G", 23),
    ([66], "Tenor Saxophone", "single", "G", 24),
    ([67], "Baritone Saxophone", "single", "F", 25),
    ([70], "Bassoon", "single", "F", 26),
    ([60], "Horn", "single", "G", 30),
    ([56, 59], "Trumpet", "single", "G", 31),
    ([57], "Trombone", "single", "F", 32),
    ([58], "Tuba", "single", "F", 33),
    ([61, 62, 63], "Brass", "single", "G", 34),
    ([47], "Timpani", "single", "F", 40),
    ([52, 53, 54], "Choir", "single", "G", 45),
    (range(80, 88), "Synth Lead", "single", "G", 50),
    ([40], "Violin", "single", "G", 60),
    ([41], "Viola", "single", "C", 61),
    ([42], "Cello", "single", "F", 62),
    ([43], "Contrabass", "single", "F", 63),
    ([44, 45, 48, 49], "Strings", "grand", "G", 64),
    ([50, 51], "Synth Strings", "grand", "G", 65),
    ([55], "Orchestra Hit", "single", "G", 66),
    ([46], "Harp", "grand", "G", 70),
    (range(24, 26), "Acoustic Guitar", "single", "G", 75),
    (range(26, 32), "Electric Guitar", "single", "G", 76),
    (range(8, 16), "Mallets", "grand", "G", 80),
    ([0, 1, 3, 6, 7], "Piano", "grand", "G", 90),
    ([2, 4, 5], "Electric Piano", "grand", "G", 91),
    (range(16, 24), "Organ", "grand", "G", 92),
    (range(88, 96), "Synth Pad", "grand", "G", 93),
    ([32, 35], "Bass", "single", "F", 98),
    (range(33, 40), "Electric Bass", "single", "F", 99),
]
_BY_PROGRAM = {}
for progs, name, kind, clef, order in _CLASSES:
    for pr in progs:
        _BY_PROGRAM.setdefault(int(pr), (name, kind, clef, order, int(list(progs)[0])))


def _family(order: int) -> str:
    return ("voice" if order < 20 else "wind" if order < 30 else "brass" if order < 40 else "other" if order < 60
            else "strings" if order < 70 else "guitar" if order < 80 else "keys" if order < 95 else "bass")


def catalog() -> list[dict]:
    """One entry per instrument class (the score order), for the part instrument picker."""
    return [dict(name=name, program=int(list(progs)[0]), clef=clef, kind=kind)
            for progs, name, kind, clef, order in sorted(_CLASSES, key=lambda c: c[4])]


def instrument(program: int) -> dict:
    name, kind, clef, order, prog = _BY_PROGRAM.get(int(program), ("Instrument", "single", "G", 55, int(program)))
    return dict(name=name, kind=kind, clef=clef, order=order, program=prog, family=_family(order))


# ----------------------------------------------------------------------------- YourMT3+ subprocess
def mt3_python() -> Path | None:
    env = os.environ.get("SCORE_STUDIO_MT3_PYTHON")
    if env:
        return Path(env)
    for p in (ROOT / ".venv-mt3" / "Scripts" / "python.exe", ROOT / ".venv-mt3" / "bin" / "python",
              Path("/opt/venv-mt3/bin/python")):
        if p.is_file():
            return p
    return None


# checkpoint of each model key, as "experiment@file" under amt/logs/2024 (mirrors backend/mt3/ymt3_runner.py)
CKPT = {
    "yptf-multi-ps": "mc13_256_all_cross_v6_xk5_amp0811_edr005_attend_c_full_plus_2psn_nl26_sb_b26r_800k@model.ckpt",
    "moe-nops": "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt",
    "moe-ps": "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b80_ps2@model.ckpt",
    "yptf-single": "ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100@model.ckpt",
    "ymt3+": "notask_all_cross_v6_xk2_amp0811_gm_ext_plus_nops_b72@model.ckpt",
}


def _home() -> Path:
    return Path(os.environ.get("YOURMT3_HOME", ROOT / "third_party" / "YourMT3"))


def installed_models() -> list[str]:
    """Model keys whose checkpoint is present (Docker / desktop builds ship only some)."""
    home = _home()
    out = []
    for key in MODELS:
        exp, f = CKPT[key].split("@")
        if (home / "amt" / "logs" / "2024" / exp / "checkpoints" / f).is_file():
            out.append(key)
    return out


def default_model() -> str:
    inst = installed_models()
    return DEFAULT_MODEL if DEFAULT_MODEL in inst or not inst else inst[0]


def available() -> bool:
    return mt3_python() is not None and (_home() / "amt" / "src").is_dir() and bool(installed_models())


def run_yourmt3(audio: Path, out_json: Path, model: str, progress=None) -> dict:
    """Run the runner in .venv-mt3; ``progress(fraction, message)`` gets its PROGRESS lines."""
    py = mt3_python()
    if py is None:
        raise RuntimeError("YourMT3+ is not installed (.venv-mt3 missing). See README, 'Multi-instrument'.")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    layers = [os.environ.get("SCORE_STUDIO_MT3_PATH"), os.environ.get("SCORE_STUDIO_CUDA_SITE")]
    if any(layers):                                     # desktop: YourMT3+ packages (+ CUDA torch) over the runtime
        env["PYTHONPATH"] = os.pathsep.join(p for p in layers if p)
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [str(py), str(RUNNER), str(audio), str(out_json), "--model", model]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True,
                            encoding="utf-8", errors="replace", cwd=str(ROOT),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    tail = deque(maxlen=40)
    for line in proc.stdout:
        line = line.rstrip()
        if line.startswith("PROGRESS ") and progress:
            _, frac, msg = (line.split(" ", 2) + [""])[:3]
            try:
                progress(float(frac), msg)
            except ValueError:
                pass
        else:
            tail.append(line)
    code = proc.wait()
    if code != 0 or not out_json.is_file():
        raise RuntimeError(f"YourMT3+ failed (exit {code}): " + "\n".join(list(tail)[-8:]))
    return json.loads(out_json.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------------- parts
def group_parts(notes: list, min_share: float = 0.03, min_notes: int = 12) -> tuple[list[dict], list[list]]:
    """Group YourMT3 notes into score parts.

    Drums are dropped. An instrument class with fewer than ``max(min_notes, min_share * total)`` notes is
    treated as a misdetection and folded into the largest kept part of the same family (strings, keys, …), else
    into the largest part (usually the accompaniment). Notes below a melody instrument's range go to the largest
    keyboard part. Returns (parts in score order, [[onset, offset, pitch, vel, part_index], ...]).
    """
    pitched = [n for n in notes if not n[5]]
    if not pitched:
        raise ValueError("No pitched instruments were found in the audio.")
    by_name = defaultdict(list)
    info = {}
    for n in pitched:
        ins = instrument(n[4])
        by_name[ins["name"]].append(n)
        info[ins["name"]] = ins
    total = len(pitched)
    thresh = max(min_notes, min_share * total)
    keep = [k for k, v in by_name.items() if len(v) >= thresh] or [max(by_name, key=lambda k: len(by_name[k]))]
    merged_into = {}
    for k in by_name:
        if k in keep:
            continue
        fam = [c for c in keep if info[c]["family"] == info[k]["family"]]
        target = max(fam or keep, key=lambda c: len(by_name[c]))
        merged_into[k] = target
    parts = sorted(keep, key=lambda k: (info[k]["order"], k))
    index = {k: i for i, k in enumerate(parts)}
    out_parts = []
    for i, k in enumerate(parts):
        ins = info[k]
        folded = {m: len(by_name[m]) for m, t in merged_into.items() if t == k}
        out_parts.append(dict(id=f"P{i + 1}", name=k, program=ins["program"], kind=ins["kind"], clef=ins["clef"],
                              notes=len(by_name[k]) + sum(folded.values()), merged=folded))
    keys = [i for i, k in enumerate(parts) if info[k]["kind"] == "grand"]
    host = max(keys, key=lambda i: out_parts[i]["notes"]) if keys else None
    rows = []
    for n in pitched:
        name = instrument(n[4])["name"]
        pi = index[merged_into.get(name, name)]
        if host is not None and n[2] < LOWEST.get(parts[pi], 0):
            pi = host                    # out of the instrument's range: give it to the keyboard part
        rows.append([n[0], n[1], n[2], n[3], pi])
    rows = _clean_overlaps(rows)
    for p in out_parts:
        p["notes"] = sum(1 for r in rows if out_parts[r[4]] is p)
    return out_parts, rows


def _clean_overlaps(rows: list, same_onset: float = 0.03) -> list:
    """Within a part, a repeated pitch whose onset is within ``same_onset`` s of the previous one is a duplicate
    (often a folded-in misdetection) and is dropped; an earlier note still sounding when the same pitch starts
    again is cut at the new onset (MIDI cannot hold two same-pitch notes on one channel)."""
    rows = sorted(rows, key=lambda r: (r[0], r[2]))
    last = {}
    out = []
    for r in rows:
        key = (r[4], r[2])
        prev = last.get(key)
        if prev is not None:
            if r[0] - prev[0] < same_onset:
                prev[1] = max(prev[1], r[1])
                continue
            if prev[1] > r[0]:
                prev[1] = r[0]
        r = list(r)
        last[key] = r
        out.append(r)
    return [r for r in out if r[1] - r[0] > 0.01]


def write_performance(parts: list[dict], rows: list, out_mid: Path, tpb: int = 960, bpm: float = 120.0):
    """Type-1 MIDI: a tempo track, then one track per part (program change, notes)."""
    tempo = mido.bpm2tempo(bpm)
    sec2tick = lambda s: int(round(s * tpb * 1e6 / tempo))
    mid = mido.MidiFile(type=1, ticks_per_beat=tpb)
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    mid.tracks.append(t0)
    for pi, part in enumerate(parts):
        ch = pi if pi < 9 else pi + 1          # skip channel 10 (drums)
        ch = min(ch, 15)
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=part["name"], time=0))
        tr.append(mido.Message("program_change", program=int(part["program"]) % 128, channel=ch, time=0))
        ev = []
        for on, off, pitch, vel, p in rows:
            if p != pi:
                continue
            a, b = sec2tick(on), sec2tick(off)
            if b <= a:
                b = a + 1
            ev.append((a, 1, pitch, vel))
            ev.append((b, 0, pitch, 0))
        ev.sort(key=lambda e: (e[0], e[1]))      # note-offs before note-ons at the same tick
        last = 0
        for tick, is_on, pitch, vel in ev:
            tr.append(mido.Message("note_on" if is_on else "note_off", note=int(pitch),
                                   velocity=int(max(1, min(127, vel))) if is_on else 0, channel=ch, time=tick - last))
            last = tick
        mid.tracks.append(tr)
    mid.save(str(out_mid))


def part_of_rows(path: Path, n_tracks_before: int = 1) -> list[int]:
    """Part index of every note DuET's ``read_performance_midi`` returns, in its row order.

    Mirrors its event ordering (tick, track, order) and FIFO note pairing; tracks before the first part
    track (the tempo track) carry no notes.
    """
    mid = mido.MidiFile(str(path))
    events = []
    for track_id, track in enumerate(mid.tracks):
        tick = 0
        for order, msg in enumerate(track):
            tick += msg.time
            events.append((tick, track_id, order, msg))
    events.sort(key=lambda e: e[:3])
    active = defaultdict(deque)
    notes = []           # [track_id, closed]
    for tick, track_id, _, msg in events:
        if msg.type not in ("note_on", "note_off"):
            continue
        key = (track_id, msg.channel, msg.note)
        if msg.type == "note_on" and msg.velocity > 0:
            active[key].append(len(notes))
            notes.append([track_id, False, tick])
        elif active[key]:
            i = active[key].popleft()
            if tick > notes[i][2]:
                notes[i][1] = True
    return [t - n_tracks_before for t, closed, _ in notes if closed]


def prepare(audio: Path, analysis_tmp: Path, performance: Path, model: str, progress=None) -> dict:
    """audio -> YourMT3+ -> performance.mid + parts dict (parts, part_of, model)."""
    analysis_tmp.mkdir(parents=True, exist_ok=True)
    raw = run_yourmt3(audio, analysis_tmp / "yourmt3.json", model, progress)
    parts, rows = group_parts(raw["notes"])
    write_performance(parts, rows, performance)
    part_of = part_of_rows(performance)
    detected = Counter(instrument(n[4])["name"] for n in raw["notes"] if not n[5])
    drums = sum(1 for n in raw["notes"] if n[5])
    return dict(model=model, parts=parts, part_of=part_of, detected=dict(detected.most_common()), drum_notes=drums)


def midi_notes(path: Path) -> list:
    """Notes of a (multi-track) MIDI file as [onset, offset, pitch, velocity, program, is_drum] in seconds.
    The program is the channel's last program change before the note; channel 10 is drums."""
    mid = mido.MidiFile(str(path))
    events = []
    for track_id, track in enumerate(mid.tracks):
        tick = 0
        for order, msg in enumerate(track):
            tick += msg.time
            events.append((tick, track_id, order, msg))
    events.sort(key=lambda e: e[:3])
    tempo, prev, sec = 500000, 0, 0.0
    program = defaultdict(int)
    active = defaultdict(deque)
    out = []
    for tick, track_id, _, msg in events:
        sec += mido.tick2second(tick - prev, mid.ticks_per_beat, tempo)
        prev = tick
        if msg.type == "set_tempo":
            tempo = msg.tempo
        elif msg.type == "program_change":
            program[(track_id, msg.channel)] = msg.program
        elif msg.type in ("note_on", "note_off"):
            key = (track_id, msg.channel, msg.note)
            if msg.type == "note_on" and msg.velocity > 0:
                active[key].append(len(out))
                out.append([sec, None, msg.note, msg.velocity, program[(track_id, msg.channel)], msg.channel == 9])
            elif active[key]:
                out[active[key].popleft()][1] = sec
    return [n for n in out if n[1] is not None and n[1] > n[0]]


def from_midi(src: Path, performance: Path) -> dict:
    """Multi-track MIDI -> parts by instrument (every instrument with notes becomes a part; drums are dropped)."""
    notes = midi_notes(src)
    parts, rows = group_parts(notes, min_share=0.0, min_notes=1)
    write_performance(parts, rows, performance)
    return dict(model=None, parts=parts, part_of=part_of_rows(performance),
                detected=dict(Counter(p["name"] for p in parts)), drum_notes=sum(1 for n in notes if n[5]))


def save_parts(analysis: Path, parts: dict):
    analysis.mkdir(parents=True, exist_ok=True)
    (analysis / "parts.json").write_text(json.dumps(parts), encoding="utf-8")


def load_parts(analysis: Path) -> dict | None:
    p = analysis / "parts.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


if __name__ == "__main__":       # quick manual check: python -m app.multi IN_AUDIO OUT_DIR [model]
    a, o = Path(sys.argv[1]), Path(sys.argv[2])
    m = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_MODEL
    o.mkdir(parents=True, exist_ok=True)
    res = prepare(a, o, o / "performance.mid", m, lambda f, s: print(f"{f:.2f} {s}"))
    save_parts(o, res)
    print(json.dumps({k: v for k, v in res.items() if k != "part_of"}, indent=1))
