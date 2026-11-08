# Multi-instrument transcription (experimental)

Branch `experimental/multi-instrument`. After you drop or choose a file, an overlay asks **Piano** or **Multiple
instruments** (beta; audio files also get a YourMT3+ model picker). *Transcribe again…* in a project's menu switches
an existing project (this clears its edit history). API: `instruments=multi` (+ optional `model`) on
`POST /api/projects`, a JSON body on `POST /api/projects/{id}/retry`, or the MCP `create_project` tool. The score then has one part per
instrument, e.g. Violin above a Piano grand staff, instead of a single piano part.

```
audio ─► YourMT3+ (instrument-labelled notes, own venv) ─► parts ─┐
MIDI  ─► one part per track instrument (GM program) ──────────────┴─► multi-track performance MIDI
      ─► DuET on all notes together (one shared beat / bar / key grid) ─► engraver: one part per instrument ─► MusicXML
```

* **Parts:** notes are grouped by instrument class (Violin, Viola, Cello, Flute, Trumpet, Guitar, Piano, …). Drums
  are left out. A class with fewer than 3 % of the notes (min. 12) is treated as a misdetection and folded into the
  largest part of the same family (strings, keys, winds, …), else into the largest part. Notes below a melody
  instrument's range (violin < G3, viola < C3, cello < C2, …) go to the keyboard part. See `backend/app/multi.py`.
* **Engraving:** keyboard-type parts (piano, organ, harp, mallets, string ensemble) get a grand staff with the usual hand
  split; other parts get one staff with a fixed clef (G, alto C for viola, F for cello/bass/bassoon/trombone/tuba).
  Pitches are written at concert pitch (no transposition for clarinet, trumpet, horn, sax).
* **Rhythm:** DuET was trained on piano. It sees all instruments merged into one performance, which works well
  when the instruments play together (it provides the shared bar grid), but it's the main source of rhythm errors.
* **Playback:** *Original audio* is unchanged. *Score synth* uses the piano sampler for keyboard parts and a simple
  sustained synth for the rest. The score MIDI export has one track per staff with the part's GM program.

## Model comparison (violin + piano duet, 3:39, RTX 3060 Ti)

No reference score exists for this recording, so these are proxy measures: *agreement* is the mean share of a
model's notes (same pitch, onset within 50 ms) that the other models also found; *low violin* counts notes labelled
violin/viola/cello below G3, which a violin cannot play (no viola or cello in the recording).

| Checkpoint (`model` key) | Time | Notes | Strings found | Low "violin" | Agreement | Verdict |
|---|---|---|---|---|---|---|
| **YPTF+Multi (PS)** (`yptf-multi-ps`) | 64 s | 3635 | Violin 849 | **66** | **0.81** | **Default.** Cleanest instrument labels, no invented parts |
| YPTF.MoE+Multi (noPS) (`moe-nops`) | 55 s | 3876 | Violin 888, Viola 92, Cello 72 | 124 | 0.79 | Official demo default; invents viola/cello for low notes |
| YPTF+Single (noPS) (`yptf-single`) | 73 s | 3972 | Violin 908, Cello 119, Viola 70 | 133 | 0.78 | Most notes, most doubled notes |
| YMT3+ (`ymt3+`) | 67 s | 3702 | "String Ensemble" 846 | 82 | 0.78 | Coarse classes (no Violin label) |
| YPTF.MoE+Multi (PS) (`moe-ps`) | 62 s | 4094 | Violin 862, Cello 123, Viola 111 | 146 | 0.60 | Disagrees most with the others |

All checkpoints found the same two instruments, but none is perfect: expect some piano notes to land in the
violin part (and vice versa), especially where the violin doubles the piano's melody. The upload overlay lets you
pick the checkpoint per file.

## Setup (native, Windows)

YourMT3+ pins `transformers==4.45.1` and `numpy<2`, so it gets its own environment and runs as a subprocess:

```bash
py -3.12 -m venv .venv-mt3     # any Python 3.12 (Linux/macOS: python3.12 -m venv .venv-mt3, then .venv-mt3/bin/python)
.venv-mt3/Scripts/python -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
.venv-mt3/Scripts/python -m pip install -r backend/mt3/requirements.txt
.venv-mt3/Scripts/python backend/mt3/download.py                 # code + default checkpoint (add --all for all five)
```

The app finds `.venv-mt3` and `third_party/YourMT3` automatically (override with `SCORE_STUDIO_MT3_PYTHON` and
`YOURMT3_HOME`). `GET /api/health` reports `multi.available`; without it, uploads go straight to Piano with no overlay.

Docker: `docker build --build-arg WITH_MT3=1 .` (CPU; slow: several minutes per minute of audio).

Licences: YourMT3 code and weights are Apache-2.0 (`mimbres/YourMT3`). DuET weights remain CC BY-NC 4.0.

## Limitations / next steps

* Two parts of the same instrument (Violin I / II) merge into one part; MIDI tracks with the same instrument too.
* No per-instrument rhythm model; no transposing-instrument notation; drums are dropped.
* The editor's hand controls apply to keyboard parts only.
