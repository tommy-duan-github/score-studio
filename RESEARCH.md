# MIDI / Audio → Readable Piano Sheet Music — Combined Research Report

*Compiled 2026-11-06. This report merges two independent passes: Claude's research and Codex (GPT-6.1-Sol, high effort). Where they agree, the point is stated plainly. Where only one found something, it's tagged **[Codex]** or **[Claude]**. Key new claims were re-checked against the primary page. No hands-on bake-off has been run yet.*

---

## TL;DR

1. **Why MuseScore's import looks bad:** MIDI records *what was played* (seconds, velocities, pedal). A score records *what should be written*: beats, note values, voices, hands, spelling. That information isn't in the file, so it has to be inferred. MuseScore does it with grid-rounding + heuristics, and each mistake compounds the next.
2. **Is it fully solvable?** No. The original score is **under-determined**: the same performance can be written many valid ways. But a *readable, playable* score with modest manual cleanup is achievable today for most solo piano music.
3. **What changed recently:** ML "performance-to-score" models now beat MuseScore's import by a large margin on benchmarks. The newest is **DuET** (Oct 2026, MIT code, CC BY-NC weights). It has a one-line CLI, `duet piano.wav` or `duet performance.mid`, that outputs `score.musicxml`. **Try this first.**
4. **Best stack:** Transkun v2 (audio→MIDI) → **DuET** (MIDI→score), with MIDI2ScoreTransformer as a comparison → rule-based readability cleanup → MusicXML → **MuseScore Studio** for human review.
5. **Where the project adds value:** not another transcription model. Instead, (a) readability rules on top of the model output, and (b) an editor that makes the ambiguous decisions fast to correct: meter/downbeat anchors, hand/voice overrides, merge-to-chord. An LLM fits as a *constrained editor*, not as a score generator.

---

## 1. The problem, precisely

Three linked representations **[Codex]**. A good tool keeps all three and never flattens back to MIDI:

| Representation | Contains |
|---|---|
| **Performance** | pitch, physical onset/release (s), velocity, pedal |
| **Musical score** | beat positions, rational durations, bars, voices, staves, spelling, ties, tuplets |
| **Engraved page** | beams, stems, spacing, collisions, system/page breaks |

| Score needs | MIDI gives | Why naive import fails |
|---|---|---|
| Beats, bars, meter, pickup | seconds / ticks at an often-meaningless tempo | Rubato looks like rhythmic complexity; half/double-tempo errors; bar grid shifted by a beat |
| Note values | *sounding* duration | Pedal/legato makes notes ring long → overlaps → extra voices, ties across barlines |
| Chords | onsets spread by 5–30 ms | Spread chords become 64th-note runs; rolled chords should be one chord + arpeggio mark |
| Voices | nothing | Every overlap forces another voice → rest clutter |
| Staff / hand | nothing (unless one track per hand) | Middle-C split fails on crossings, arpeggios, overlapping registers |
| Spelling (F♯ vs G♭), key | MIDI number only | Wrong accidentals |
| Rests, ties, beams, clefs, 8va | nothing | Defaults that ignore meter and voice |

Distinctions that matter for the design **[Codex]**:
- **Key release ≠ acoustic decay ≠ written duration.** A staccato quarter can be a short key press; pedal sustains well beyond the written value.
- **Voice ≠ staff ≠ hand.** One hand can play several voices, a voice can cross staves, and cross-staff notation doesn't mean a hand change.
- **Expressive asynchrony isn't counterpoint.**

**Two very different MIDI inputs [Claude]:**
- **Score-like MIDI** (exported from notation software or a sequencer, on-grid). The rhythm is already right; you only need duration, voice, hand and spelling cleanup. Much easier.
- **Performance MIDI** (played on a keyboard, or transcribed from audio). It needs beat tracking + quantization first, which is the hard part.

The tool should detect which one it has. A quick check is the fraction of onsets that land exactly on a 1/16 or 1/12 tick grid.

---

## 2. Pipeline and best tools per stage

```
audio ─► [0] isolate piano (only if mixed)    Demucs / YourMT3+
      ─► [1] audio → performance MIDI          Transkun v2
      ─► [2] beat / downbeat / meter           Beat This! (audio) · inside DuET/PM2S (MIDI)
      ─► [3] rhythm quantization  ┐
      ─► [4] voice + staff        ├─ DuET  (or MIDI2ScoreTransformer)  — joint models
      ─► [5] spelling + key       ┘   fallbacks: piano_svsep, partitura
      ─► [6] notation policy + MusicXML        music21 / partitura → MuseScore Studio / Verovio / LilyPond
      ─► [7] simplification (optional)         research only
```

### [1] Audio → MIDI: effectively solved for clean solo piano
| Tool | License | Notes |
|---|---|---|
| **Transkun v2** — [GitHub](https://github.com/Yujia-Yan/Transkun) · [paper](https://arxiv.org/abs/2404.09466) | MIT code; weights ship in the pip package (separate weight grant not explicit) | `pip install transkun` → `transkun in.mp3 out.mid --device cuda`. MAESTRO onset F1 **98.3%**, onset+offset 81–93% depending on the pedal convention. **First pick (both reports agree).** DuET uses it internally. |
| ByteDance / Kong high-res — [inference](https://github.com/qiuqiangkong/piano_transcription_inference) | training repo Apache-2.0 (archived Dec 2025); inference pkg has no license file | Long-time standard with pedal; "Windows not tested". |
| hFT-Transformer (Sony) — [GitHub](https://github.com/sony/hFT-Transformer) | code MIT, **weights CC BY-NC-SA** **[Codex]** | ~97.4 note F1; old dependency stack. |
| Aria-AMT (EleutherAI) — [GitHub](https://github.com/EleutherAI/aria-amt) **[Codex]** | Apache-2.0 code, preliminary weights | Worth comparing on your own recordings. |
| Basic Pitch (Spotify) — [GitHub](https://github.com/spotify/basic-pitch) | Apache-2.0 | Easy and Windows-friendly, but weaker on dense piano. Better for single-line instruments. |
| MT3 / YourMT3+ | Apache-2.0 / unverified | Multi-instrument. For mixed recordings where you want the actual piano part. |

Caveat: MAESTRO is clean studio audio. Phone recordings, reverb and uprights score noticeably worse, so compare frontends on **your own** audio.

### [2] Beat / downbeat / meter: good, but still the #1 source of whole-score errors
- **Beat This!** (CPJKU, ISMIR 2024) — [GitHub](https://github.com/CPJKU/beat_this) · [paper](https://arxiv.org/abs/2407.21658). MIT code and weights; the authors flag training-data restrictions. Best audio beat/downbeat tracker.
- madmom: older, and its models are CC BY-NC-SA.
- Both reports recommend that the **user confirms meter, pickup, tempo level and first downbeat**, with optional beat anchors through rubato. Fixing the bar grid first prevents most downstream errors.

### [3–5] Performance MIDI → score (quantize + voice + staff + spelling): the core open problem, with fast progress
| System | License / usability | Evidence |
|---|---|---|
| **DuET** (Zeng & Wang, NUS, arXiv Oct 2026) — [GitHub](https://github.com/wei-zeng98/DuET) · [paper](https://arxiv.org/abs/2610.21467) · [weights](https://huggingface.co/Wayne42/DuET) · [demo](https://huggingface.co/spaces/Wayne42/DuET-demo) **[Codex found; Claude verified]** | **MIT code, CC BY-NC 4.0 weights** (personal use fine; commercial use isn't). `pip install .` (Py 3.11+) → `duet performance.mid` or `duet piano.wav` (runs Transkun v2 first). Outputs `score.musicxml`, `review.json`, a listening `score.mid`, and per-note predictions. Works in 32 s windows. | Predicts onset, duration, staff, bar, meter, key, voice and grace notes **per input note**, so it never invents or drops pitches. MUSTER error: **ASAP 11.22% vs 11.30% (Beyer & Dai) vs 23.35% (MuseScore)**; **Gangqinpu (pop piano) 3.64% vs 6.56% best baseline vs 12.48% MuseScore**. Higher miss/extra-note errors than some baselines. New preprint, not independently replicated. *Per-column table values came from a summary of the arXiv HTML; the abstract numbers are verified.* |
| **MIDI2ScoreTransformer** (Beyer & Dai, ISMIR 2024) — [GitHub](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer) · [paper](https://arxiv.org/abs/2410.00210) | **No license file**; checkpoint "in Releases" (unverified); needs custom forks of music21 etc. | Seq2seq to score tokens: note values, ties, staff, voice, spelling, grace notes. It can rewrite a trill as an ornament, but can also add or drop notes. Was the state of the art before DuET. Trained on classical piano only (ASAP). |
| PM2S (Liu et al., ISMIR 2022) — [GitHub](https://github.com/cheriell/PM2S) | MIT, `demo.ipynb`, Py 3.8 / Torch 1.12 | CRNN beat tracking → quantization, time/key signature, hand. Beat commercial tools on MV2H in 2022, but **DuET's table shows it at 28% MUSTER on ASAP, worse than MuseScore**. Now a baseline only. |
| Nakamura / Shibata HMMs — [merged-output HMM](https://arxiv.org/abs/1701.08343) · [non-local statistics](https://arxiv.org/abs/2008.12710) | research code | Statistical baseline. Strong on pop piano (6.56%), still competitive. |
| **piano_svsep** "Cluster and Separate" (ISMIR 2024) — [GitHub](https://github.com/CPJKU/piano_svsep) | **MIT, pretrained, CLI** | Voice + staff GNN for an *already-quantized* score: `python launch_scripts/predict.py --model_path pretrained_models/model.ckpt --score_path in.musicxml --save_path out.mei`. **Best fix for score-like MIDI** whose only problem is voices and hands. |
| EngravingGNN (TENOR 2025) — [paper](https://arxiv.org/abs/2509.19412) **[Claude]** | code not confirmed | One model for voice, staff, spelling, key, stems, 8va and clefs. No ties or composite rhythms yet. |
| partitura — [docs](https://partitura.readthedocs.io/) | Apache-2.0 | ps13 spelling, key estimation, VoSA voice separation. Good inspectable fallbacks. |
| music21 — [GitHub](https://github.com/cuthbertLab/music21) | BSD-3 | MusicXML I/O, key analysis, enharmonic simplifier. Use as the orchestration/export layer. |
| ScoreTranscriber (KAIST) — [GitHub](https://github.com/NZX23/ScoreTranscriber) | no license, no weights | Not usable yet. |

### Direct audio → score (skips MIDI): research, worth watching
- **Rubato** (Tamer et al., NeurIPS 2026) — [paper](https://arxiv.org/abs/2605.24291). Beats cascades **even when the cascade gets perfect MIDI**, which suggests the bottleneck is the representation, not the acoustics. It ranked best on OMR-NED in an independent [Dual Evaluation](https://arxiv.org/abs/2608.04511) paper. **Code and weights not released yet.** This is the one to watch.
- piano-a2s (Zeng et al., IJCAI 2024) — [GitHub](https://github.com/wei-zeng98/piano-a2s), Apache-2.0. Limited to 5-bar / 12 s clips; the README says "not yet applicable in real-world scenarios".

### [6] Output and rendering: solved
- **MusicXML** for interchange. MEI is richer, but not needed as a second canonical format.
- **MuseScore Studio 4** (GPL): best free editor; CLI render with `MuseScore4.exe -o out.pdf in.musicxml`.
- **Verovio** (LGPL): MusicXML/MEI → SVG for an embedded preview.
- **LilyPond** (GPL): highest-quality automatic engraving as an optional final backend. `musicxml2ly` converts but doesn't repair.

### [7] Simplification / arrangement: open research
- [Difficulty-controlled score simplification](https://arxiv.org/abs/2511.16228) (Nov 2025; code "to be released"), Nakamura statistical reduction, Terao difficulty-aware arrangement.
- **Pop2Piano** generates a *new* piano cover from pop audio. That's arrangement, not transcription, and its MIDI still needs stages 2–6.

### Commercial / existing apps (useful baselines)
| App | Notes |
|---|---|
| **Sibelius** | Duration limits, voices, tuplet choices, fixed or auto staff split. "Re-notate performance" is well regarded. |
| **Dorico** | Quantize units, tuplets, gap filling, **contextual hand splitting since 4.1** **[Codex]**. |
| **MuseScore** | Grid quantize + heuristics. Scores 23% MUSTER error on ASAP in DuET's comparison. |
| Finale | **Discontinued** (development stopped 2024, support ended 2025) **[Codex]**. Avoid. |
| **AnthemScore** | Local Windows app, one-time purchase. Note/beat correction, tapped downbeats, MusicXML export (Pro). |
| **Klangio / Piano2Notes**, **Songscription** | Cloud audio → MusicXML. No independent benchmarks; most "comparisons" are vendor blogs. |

---

## 3. Solved vs open

| Stage | Status |
|---|---|
| MIDI / MusicXML I/O, engraving a well-formed score | ✅ mature |
| Clean solo-piano audio → notes | ✅ ~98% onset F1 (weaker on real-world recordings) |
| Spelling + key in tonal passages | ✅ mostly, with occasional fixes |
| Quantizing on-grid MIDI with known meter | ✅ tractable |
| Beat/downbeat through heavy rubato | 🟡 open in hard cases |
| Note values from expressive releases + pedal | 🟡 improving fast (DuET), still errors |
| Voices / staves in dense textures | 🟡 GNNs and joint models help, not solved |
| Tuplets, ornaments, cadenzas, meter changes, swing | 🔴 open |
| Consistently readable full scores with no human input | 🔴 open |
| Arranging to a specific player's level | 🔴 open and preference-dependent |

**Bottom line (both reports agree):** the unique "author's intended" score is unrecoverable in general. The realistic target is a *plausible, readable* score that is **fast to correct**. User-supplied meter and downbeat anchors, plus style preferences, close much of the gap.

---

## 4. Recommended stack (personal use, Windows)

| Layer | Choice | Why |
|---|---|---|
| Audio → MIDI | **Transkun v2** | Best practical piano frontend; native pip/CLI, CPU or CUDA |
| Beat proposal | **Beat This!** (audio), else model-predicted | Strong hypothesis for the user to confirm |
| Performance → score | **DuET** (primary), **MIDI2ScoreTransformer** (comparison) | Current best published results; DuET is the only polished one |
| Score-like MIDI | **piano_svsep** + partitura spelling | Rhythm is already right; fix voices, hands and spelling |
| Readability rules | **Your own code** (see below) | Where you add the most value fastest |
| Symbolic layer | **music21** (+ partitura for analysis) | Don't reimplement MusicXML or theory |
| Preview | **Verovio** | Embeddable |
| Edit / print | **MuseScore Studio 4** | Free, good editor, CLI PDF |
| Optional final engraving | LilyPond | Publication quality |

**Environment:** keep one isolated venv per model (DuET needs Py 3.11+, PM2S needs Py 3.8 / Torch 1.12, so don't mix them). Run natively where supported and use **WSL2** for research repos that assume Linux. An NVIDIA GPU helps but isn't required. **Licensing:** DuET weights and hFT weights are non-commercial, which is fine for personal use. Keep the backend swappable if this might ever become a product.

### Readability rules worth implementing (both reports, merged)
- **Chords:** group near-simultaneous onsets into chords when context supports it. Keep arpeggio and grace-note alternatives.
- **Durations:** written duration should be about min(sounding, next onset in the same voice), decided jointly with neighbouring notes. Don't let the pedal create long notes.
- **Gaps:** fill short articulation gaps instead of writing a rest after every release. Set a minimum note value and merge tiny rests.
- **Voices:** prefer fewer notation voices when chords share a rhythm. Keep separate layers only for sustained melody or bass lines. Aim for at most two voices per staff by default.
- **Ties:** split durations meter-aware, so ties show the beat structure.
- **Tuplets:** enable them only locally and on request. Don't "discover" exotic tuplets in rubato.
- **Staff assignment:** use contextual costs (continuity, register, hand span ≤ ~an octave) plus manual overrides, not a fixed split.
- **Spelling and tempo:** spell pitches per phrase or harmonic region. Don't print every tempo fluctuation; keep the alignment internal.
- **Ghost notes:** drop very short, very quiet notes (transcription false positives).

### Where an LLM fits (both reports agree)
- ❌ **Don't** let it generate or rewrite raw MusicXML or a whole score. It produces invalid XML, quietly drops or alters notes, and long scores overflow its context.
- ✅ **Do** use it as a **constrained editor**. It proposes **structured edits that reference note IDs** ("m.12: notes #341,#342 → RH", "respell #388 G♭→F♯", "m.20 LH: merge tie chain → half note"). Code validates them deterministically (pitches preserved, bar totals correct, ties consistent) and shows a diff with playback. You accept or reject.
- ✅ Turn plain intent ("keep the melody sustained, simplify the left hand, grade-4 level") into explicit settings for the rules above.
- ✅ Rank a few *valid* alternatives for an ambiguous passage, or explain why two notations differ.
- ✅ Visual QA: render a page to PNG and ask a vision model where it looks cluttered. It's good at spotting clutter, weak at exact rhythm.

**Human review order [Codex]:** meter/downbeats → wrong notes → rhythms → voices/staves → spelling → engraving. Fix the bar grid first.

---

## 5. MVP plan

**Phase 0: baseline in an afternoon (no code).** Install DuET and Transkun. Run `duet` on 3–5 pieces where you own the real score: one classical, one pop ballad, one rubato-heavy, one dense, one swing. Open the results in MuseScore next to MuseScore's raw MIDI import, and optionally next to a free trial of AnthemScore or Piano2Notes. This tells you how far off-the-shelf already gets you.

**Phase 1: CLI pipeline (MIDI-first, per Codex).**
`transcribe <input.(mid|wav|mp3)> -o out/` →
1. Classify the input (score-like MIDI / performance MIDI / solo audio / mixed audio).
2. Audio → Transkun → performance MIDI. Keep the original events with note IDs.
3. Performance MIDI → DuET. Score-like MIDI → piano_svsep + partitura.
4. Readability rules pass.
5. Write MusicXML via music21 → MuseScore CLI → PDF, plus a separate listening MIDI.
6. Optional `--meter 3/4 --pickup 1 --tempo 72` flags so you can supply anchors.

**Phase 2: assisted editor (the real differentiator).** A small local web UI (Verovio + piano roll + audio) with linked note selection. It should support:
- Confirm or adjust downbeats and beat anchors.
- Click a note → move to RH/LH, change voice, merge into chord, fix duration.
- Local tuplet toggle.
- An undoable log of decisions, after which dependent notation regenerates.
- Then the LLM edit-proposal panel.

**Phase 3:** swap in MIDI2ScoreTransformer, Rubato (when released) or EngravingGNN as alternative backends. Add a simplification/difficulty mode.

**Measure what matters:** editing effort, not symbol count. Track minutes to a playable page, structural corrections per bar, wrong voices or staves, unnecessary rests or ties, and blind pianist preference. Count missing and extra notes separately. Optional automatic metrics are MUSTER and MV2H.

---

## 6. Where the two reports agreed / differed

| Topic | Claude | Codex | Resolution |
|---|---|---|---|
| Audio frontend | Transkun v2 | Transkun v2 | ✅ agree |
| Core model | PM2S primary, MIDI2ScoreTransformer to try | **DuET** primary, MIDI2ScoreTransformer comparison | **Codex was right.** I missed DuET (Oct 2026). Verified: it beats both, and its table shows PM2S worse than MuseScore on ASAP |
| Voice/staff for on-grid MIDI | piano_svsep (MIT, CLI) | partitura voice separation; warns against over-splitting voices | Use piano_svsep, plus Codex's "fewer voices for shared-rhythm chords" rule |
| Direct audio→score | piano-a2s (not usable) | **Rubato** (NeurIPS 2026) | Rubato verified; best-in-class but unreleased. Watch it |
| Beat tracking | Beat This! (from memory) | Beat This!, licenses checked | ✅ agree |
| LLM role | Structured edit ops + vision QA | Structured edits with note IDs + deterministic validation | ✅ agree; merged |
| MVP shape | CLI pipeline first | MIDI-first, editor with user-confirmed anchors; measure editing effort | Merged: Phase 0 baseline → CLI → editor |
| Extra items | EngravingGNN, Gangqinpu-style pop data, difficulty simplification | hFT/madmom NC weight licenses, Finale discontinued, Dorico contextual split, Aria-AMT, "three representations" design | All included above |

---

## Sources
- Transkun: https://github.com/Yujia-Yan/Transkun · https://arxiv.org/abs/2404.09466
- ByteDance/Kong: https://github.com/bytedance/piano_transcription · https://github.com/qiuqiangkong/piano_transcription_inference · https://arxiv.org/abs/2010.01815
- hFT-Transformer: https://github.com/sony/hFT-Transformer · https://arxiv.org/abs/2307.04305
- Aria-AMT: https://github.com/EleutherAI/aria-amt
- Basic Pitch: https://github.com/spotify/basic-pitch
- MT3 / YourMT3+: https://github.com/magenta/mt3 · https://arxiv.org/abs/2407.04822
- Onsets and Frames: https://arxiv.org/abs/1710.11153
- Beat This!: https://github.com/CPJKU/beat_this · https://arxiv.org/abs/2407.21658
- **DuET**: https://github.com/wei-zeng98/DuET · https://arxiv.org/abs/2610.21467 · https://huggingface.co/Wayne42/DuET
- MIDI2ScoreTransformer: https://github.com/TimFelixBeyer/MIDI2ScoreTransformer · https://arxiv.org/abs/2410.00210
- PM2S: https://github.com/cheriell/PM2S · https://ismir2022program.ismir.net/poster_335.html
- Nakamura et al.: https://arxiv.org/abs/1701.08343 · Shibata et al.: https://arxiv.org/abs/2008.12710
- KIT beat-conditioned quantization (AES AIMLA 2025): https://publikationen.bibliothek.kit.edu/1000184109
- piano_svsep: https://github.com/CPJKU/piano_svsep · https://arxiv.org/abs/2407.21030
- EngravingGNN: https://arxiv.org/abs/2509.19412
- partitura: https://partitura.readthedocs.io/ · music21: https://github.com/cuthbertLab/music21
- **Rubato**: https://arxiv.org/abs/2605.24291 · Dual Evaluation: https://arxiv.org/abs/2608.04511
- piano-a2s: https://github.com/wei-zeng98/piano-a2s · https://arxiv.org/abs/2405.13527
- Liu et al. ICASSP 2021 A2S: https://github.com/cheriell/ICASSP2021-A2S
- Pop2Piano: https://github.com/sweetcocoa/pop2piano · Simplification: https://arxiv.org/abs/2511.16228
- Verovio: https://github.com/rism-digital/verovio · LilyPond: https://lilypond.org/ · MusicXML 4.0: https://www.w3.org/2021/06/musicxml40/
- MuseScore: https://handbook.musescore.org/ · Dorico quantize: https://www.steinberg.help/r/dorico-pro/6.2/en/dorico/topics/project_file_handling/project_file_handling_quantize_options_r.html · Finale sunset: https://makemusic.zendesk.com/hc/en-us/articles/25843888130839-Finale-Sunset-FAQ
- AnthemScore: https://lunaverus.com/ · Klangio: https://klang.io/products/
- Example cascade pipeline (Kong → PM2S → MuseScore): https://arxiv.org/abs/2609.28787
