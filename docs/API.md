# Score Studio — HTTP API contract

Backend: FastAPI on `http://127.0.0.1:8000`. All routes are under `/api`.
The web dev server (Vite, port 5173) proxies `/api` → `http://127.0.0.1:8000`.
In production the backend serves the built web app from `web/dist` at `/`.

All JSON. Times in the score are in **quarter notes** (floats; exact values are
multiples of 1/24). Performance times are in **seconds**.

---

## Health / config

### `GET /api/health`
```json
{ "ok": true, "version": "0.1.0", "cuda": true,
  "llm": { "configured": true, "model": "deepseek-flash", "base_url": "https://api.deepseek.com" } }
```

### `GET /api/config/llm` → `{ "configured": bool, "model": str, "base_url": str, "key_hint": "sk-…a1b2" | null }`
### `PUT /api/config/llm`
Body `{ "api_key"?: str, "model"?: str, "base_url"?: str }` → same shape as GET.
(Key is stored locally in `data/config.json`; env var `DEEPSEEK_API_KEY` also works.)

---

## Projects

### `GET /api/projects`
```json
[ { "id": "a1b2c3", "title": "Winter Wind", "created": "2026-11-06T22:10:00Z",
    "source": "audio" | "midi", "status": "ready", "bars": 120 } ]
```
Newest first.

### `POST /api/projects` (multipart/form-data)
Fields: `file` (required; `.mid .midi .mp3 .wav .flac .m4a .ogg`), `title` (optional).
→ `201 { "id": "a1b2c3", "status": "queued" }`. Processing runs in the background.

### `GET /api/projects/{id}`
```json
{ "id": "a1b2c3", "title": "Winter Wind", "source": "audio", "created": "…",
  "status": "queued" | "transcribing" | "analysing" | "engraving" | "ready" | "error",
  "progress": { "stage": "transcribing", "fraction": 0.42, "message": "Transcribing audio (Transkun)…" },
  "error": null | "message",
  "has_audio": true, "version": 3 }
```
Poll this every ~1 s while status is not `ready`/`error`.

### `DELETE /api/projects/{id}` → `204`

### `PATCH /api/projects/{id}` body `{ "title"?: str, "header"?: {…} }` → project (as GET)

`header` edits the title block engraved on page 1 and written to MusicXML exports (only the given fields change;
bumps `version`): `title` (empty = project title), `subtitle`, `composer` (strings), `title_size`, `subtitle_size`,
`composer_size` (40–600, percent of normal text; 100 ≈ 12 pt), `show` (bool). The document (`GET …/doc`) returns
the full `header`.

---

## The score document

### `GET /api/projects/{id}/doc`
Only valid when status is `ready` (else `409`).
```json
{
  "id": "a1b2c3", "title": "Winter Wind", "version": 3,
  "settings": { "max_voices": 3, "auto_keys": true, "auto_spelling": true, "auto_runs": true,
                "hand_span": 14, "show_pedal": false, "show_dynamics": true, "show_tempo": true },
  "meta": { "tempo": 130, "bars": 120, "pickup": 0.0, "notes": 2036, "has_audio": true },
  "measures": [
    { "index": 0, "number": 1, "start": 0.0, "length": 4.0, "time": [4, 4], "key": -1 }
  ],
  "notes": [
    { "id": 17, "pitch": 65, "name": "F4", "staff": 1, "voice": 2,
      "on": 12.5, "dur": 0.5, "measure": 3, "beat": 0.5,
      "grace": false, "deleted": false, "added": false,
      "perf_on": 5.231, "perf_off": 5.61, "velocity": 80,
      "edited": ["voice"] }
  ],
  "timemap": [[0.0, 0.12], [1.0, 0.58], [2.0, 1.04]],
  "review": [
    { "id": "key:1-37", "kind": "key", "priority": "high", "measures": [1, 37],
      "question": "Key signature F here, where the model wrote C: …",
      "options": [ { "index": 0, "label": "keep" }, { "index": 1, "label": "the model's key here" } ],
      "resolved": null | 0 | 1 }
  ],
  "history": { "can_undo": true, "can_redo": false, "edits": 4 }
}
```
- `staff`: 1 = upper (right hand), 2 = lower (left hand). `voice`: 1–4 *within the staff*
  (1 = top voice, stems up; 2 = stems down; 3 = up; 4 = down).
- `deleted` notes are kept in the list (so they can be restored) but not engraved.
- `timemap`: monotonic `[score_quarter, audio_seconds]` pairs (one per beat or better).
  Interpolate linearly to sync a cursor with the original audio / performance.
- `edited`: which fields the user has overridden on this note.

### `GET /api/projects/{id}/score.musicxml?v={version}`
The current engraved MusicXML 4.0. **Every `<note>` has an `id` attribute**:
- `n{noteId}` for a note's first written piece,
- `n{noteId}-t{k}` for tied continuation pieces (k = 1, 2, …).
Verovio preserves these as SVG element ids, so a click on an SVG `g.note` whose id
matches `/^n(\d+)(-t\d+)?$/` maps to doc note `noteId`. Rests have no such id.
Measures carry `number` = doc `measures[i].number`.

### `GET /api/projects/{id}/score.mid?v={version}`
MIDI of the current score (quantized, at the doc tempo, track 1 = RH, track 2 = LH).

### `GET /api/projects/{id}/performance.mid`
The performance MIDI (Transkun output, or the uploaded MIDI).

### `GET /api/projects/{id}/audio`
Original audio file (only if `has_audio`). Supports HTTP range requests.

### Downloads
`GET /api/projects/{id}/export/{name}` where name ∈ `score.musicxml`, `score.mid` —
same content as above but with `Content-Disposition: attachment; filename="<title>.<ext>"`.

---

## Settings

### `PUT /api/projects/{id}/settings`
Body: any subset of `settings` (see doc). Re-engraves (≈1–3 s). → full doc.
`max_voices` ∈ 1..4.

---

## Edits

### `POST /api/projects/{id}/edits`
Body `{ "ops": [Op, …], "label"?: "Move to left hand" }` → full doc (new `version`).
All ops in one request form **one undo step**. Invalid op → `422 { "detail": "…" }` and nothing applied.

Op types (`ids` are doc note ids):
| op | fields | effect |
|---|---|---|
| `set_staff` | `ids`, `staff` (1\|2) | move notes to RH/LH staff |
| `set_voice` | `ids`, `voice` (1..4) | pin notes to a voice within their staff |
| `set_duration` | `ids`, `dur` (quarters > 0) | written duration |
| `shift` | `ids`, `delta` (quarters, ±) | move onsets |
| `transpose` | `ids`, `semitones` (±) | fix wrong pitch |
| `respell` | `ids`, `prefer` ("sharp"\|"flat"\|"auto") | enharmonic spelling |
| `set_grace` | `ids`, `grace` (bool) | grace note on/off |
| `merge_chord` | `ids` | align onsets to the earliest and durations to the longest |
| `delete` | `ids` | mark deleted |
| `restore` | `ids` | undelete |
| `add_note` | `pitch`, `on`, `dur`, `staff`, `voice`? | new note (gets a new id ≥ 100000) |
| `reset` | `ids` | drop all user overrides on these notes |
| `set_key` | `measure` (doc measure index), `fifths` (-7..7) | key signature from this measure until the next key change |
| `resolve_review` | `review_id`, `option` (index) | apply one of the engraver's suggested answers |

### `POST /api/projects/{id}/undo` → full doc
### `POST /api/projects/{id}/redo` → full doc
### `GET /api/projects/{id}/history` → `[{ "index": 0, "label": "Move to left hand", "ops": [...], "time": "…" }]`

---

## Assistant (DeepSeek)

### `POST /api/projects/{id}/assistant`
Body:
```json
{ "message": "Bars 12-16: the left hand has too many voices, simplify",
  "note_ids": [17, 18], "measures": [12, 16],
  "history": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ] }
```
(`note_ids` / `measures` = current selection context, both optional; `measures` are doc measure *numbers*, inclusive.)
→
```json
{ "reply": "In bars 12–16 the inner E–G dyads are held under the bass …",
  "proposals": [
    { "title": "Merge LH inner voice into voice 1", "explanation": "…",
      "ops": [ { "op": "set_voice", "ids": [301, 302], "voice": 1 } ],
      "valid": true, "error": null }
  ] }
```
Proposals are **not applied**; the UI previews and applies them via `POST /edits`.
`503` if no API key configured.

---

## Errors
`404` unknown project · `409` project not ready · `422` invalid input · `500` internal (with `detail`).
