# Score Studio — instructions for Hermes

You have access to **Score Studio** through MCP (tools prefixed `scorestudio_`). It turns piano audio
(mp3, wav, flac, m4a, ogg) or MIDI into an editable piano score, and exports MusicXML or MIDI.
`scorestudio_create_project` also takes `instruments: "multi"` (beta): one part per detected instrument; `read_score` then labels
lines with the part name (e.g. `Violin (staff 3) v1:`, `Piano RH (staff 1) v1:`).
It runs on the user's NAS on the CPU, so audio takes several minutes per minute of music. MIDI takes 1–3 minutes.

## Standard workflow
1. `scorestudio_status`: check that it's up, see the queue, and find the import/export folders.
2. `scorestudio_create_project` with exactly one source:
   - `import_path`: a file in the shared import folder (find it with `scorestudio_list_import_files`). Prefer this for files on the NAS.
   - `url`: a public http(s) link (max 100 MB). LAN/private addresses are refused unless the user enabled them.
   - `file_base64` + `filename`: for small files you hold in memory.
   - Optional `title`. The tool returns the project `id`.
3. `scorestudio_wait_for_project` with `ids: [id]`, `timeoutSeconds: 110`. If `timedOut` is true, call it again
   until `settled` is true. If the status is `error`, report the `error` text, and offer `scorestudio_retry_project`.
4. `scorestudio_read_score` with `bars: [first, last]` (max 32 bars per call; the default is the first 8). It returns:
   - `summary`: bars, notes, meter, tempo, settings, open_review count
   - `view`: one block per bar. Lines `RH v1:` / `LH v2:` list events as `[id name, …]@beat~dur`
     (beat and dur in quarter notes; `g` = grace note). The numbers are the note ids that edits use.
   - `review`: the engraver's open questions for those bars, each with an `id` and `options`.
5. Fix things with `scorestudio_edit_score` (see below). Then **re-read the affected bars** to confirm the result.
6. `scorestudio_export_score` with `format: "musicxml"` or `"midi"`. It saves to the export folder by default
   (`saved_to` gives the path). Add `inline: true` to get the content back (max 2 MB).

## Editing (`scorestudio_edit_score`)
`{ "id": "<project>", "ops": [ … ], "label": "short description" }`. All ops in one call are **one undoable step**.
If any op is invalid, nothing changes and you get an error.

| Op | Fields | Use for |
|---|---|---|
| `set_staff` | `ids`, `staff` 1 (RH) / 2 (LH) | move notes to the other hand |
| `set_voice` | `ids`, `voice` 1–4 | 1 top (stems up), 2 bottom (down), 3 upper-middle, 4 lower-middle |
| `set_duration` | `ids`, `dur` (quarters: 0.25, 0.5, 1, 1.5, 2, 3, 4…) | fix written length |
| `shift` | `ids`, `delta` (quarters, negative = earlier) | fix onset |
| `transpose` | `ids`, `semitones` | wrong pitch (only clear transcription errors) |
| `respell` | `ids`, `prefer` `"sharp"`/`"flat"`/`"auto"` | enharmonic spelling |
| `set_grace` | `ids`, `grace` true/false | grace notes |
| `merge_chord` | `ids` | near-simultaneous notes → one chord |
| `delete` / `restore` | `ids` | remove a ghost note / bring it back |
| `reset` | `ids` | drop all manual changes on those notes |
| `add_note` | `pitch` (MIDI 21–108), `on` (absolute quarters from start), `dur`, `staff`, `voice` | missing note; bar start positions are in the view (`starts at …`) |
| `set_key` | `measure` (INDEX = bar number − offset given in the view's first line), `fifths` −7..7 | key signature from that bar |
| `resolve_review` | `review_id`, `option` (index) | answer a review question from `read_score` |

Undo or redo with `scorestudio_history` (`action`: `"undo"`, `"redo"` or `"list"`).

## Engraving settings
`scorestudio_update_settings` with `settings`: `max_voices` 1–4 (default 3), `hand_span` 7–24 semitones (default 14),
`auto_keys`, `auto_spelling`, `auto_runs`, `show_pedal`, `show_dynamics`, `show_tempo` (booleans). It re-engraves the
whole score.

## Rules
- Readability for a pianist comes first. Keep what was played, and don't invent music. Prefer fewer voices unless the lines
  are really independent, and keep each hand within a playable span.
- Make small, targeted edits with a clear `label`, and explain what you changed.
- **Ask the user before** `scorestudio_delete_project` (it can't be undone) and before changing performance limits.
- Performance: `scorestudio_get_performance` shows CPU use. `scorestudio_set_performance` (`preset`: `eco` / `balanced` /
  `full`, or `custom` with `cores`; `priority`: `normal` / `low` / `background`) controls how hard the NAS works.
  Only change it when the user asks, or after suggesting it (e.g. Eco while the NAS is busy).
- Large batches: queue several files, then wait on all ids together (`wait_for_project` accepts up to 20 ids).
  Jobs run one at a time.
- If a tool returns "Project is not ready", it's still transcribing: wait first.
