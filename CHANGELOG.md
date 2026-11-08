# Changelog

Release notes per version; `tools/release.py` copies the current version's section into the release folder
as `CHANGES.md`.

## 1.2.0

- **Multiple instruments (beta):** after you drop a file, choose *Piano* or *Multiple instruments*. Multiple
  instruments uses YourMT3+ to detect the instruments in a recording and writes one part per instrument (e.g. Violin
  above a Piano grand staff); a multi-track MIDI file keeps its tracks as parts. *Transcribe again…* in a project's
  menu switches an existing project. Drums are left out; DuET (piano-trained) still provides the shared bar grid.
- Part names and instruments are editable: double-click a part name; pick another instrument for the selected
  notes' part in the Notes panel. The project title is edited by double-click too.
- **Settings** (bottom left) replaces the Workspace label, with sections on the left: General (theme, language
  English / 简体中文), Performance (now with the GPU: name, load and memory), Storage and About.
- **Storage:** one bar for the disk (projects, models, app, other files, free); the models grouped (core,
  YourMT3+ multiple instruments, acceleration) with a short description of what each is for, and download /
  remove; delete projects in bulk (select several or clear all).
- The editor panel's *Settings* tab is now *Engraving*.
- **Reading mode:** choose how pages advance from the bar: vertical scroll, sideways scroll, or tap to turn
  pages (one page at a time; tap the right side for the next page, the left side to go back; arrow keys and
  swipes work too). The bar is now clear liquid glass.
- About links to the GitHub repository for updates and releases; the multiple-instruments model picker
  explains each YourMT3+ checkpoint.
- **Export:** grouped into Score (MusicXML, MIDI, Print / PDF) and Audio (rendered audio .wav, original audio).
  Rendering a few minutes of music to WAV takes about 20 seconds.
- Info bubbles show above dialogs and overlays; every bubble has a real description.
- Piano samples are bundled (playback and audio rendering work offline).
- **Windows desktop app (portable, new):** `ScoreStudio.exe` in its own folder (1.7 GB, CPU). On first start it
  downloads its models with one click (DuET 0.4 GB; YourMT3+ 0.5 GB for multiple instruments). With an NVIDIA GPU,
  *GPU acceleration* in Settings › Storage downloads CUDA PyTorch (about 3 GB) and makes transcription several
  times faster.

Upgrade (Docker): import `score-studio-1.2.0-docker-amd64.tar.gz`, set the compose `image:` to `score-studio:1.2.0`
(the included `docker-compose.yml` already does), and redeploy. Data volumes are unchanged.

## 1.1.0

- New blue/purple app icon (favicon, home-screen icon, web manifest).
- Tablet and phone: the project library and the editor panel are slide-in drawers (☰ in the top bar, Edit in the
  score toolbar); toolbars collapse to icons instead of overlapping.
- Reading mode (Read in the score toolbar): full-screen pages with a compact bar — play/pause, progress, original
  audio vs synth, speed 0.5–1.5× and transpose ±12 semitones (notation and playback); extra controls fold into "…"
  on narrow screens.
- Title block: editable title, subtitle and composer with text sizes, engraved on page 1, printed to PDF and written
  to MusicXML exports (also via the MCP tool `scorestudio_set_score_header`).
- Fix: Print / PDF no longer inserts a blank page after every score page.

Upgrade: import `score-studio-1.1.0-docker-amd64.tar.gz`, change the compose `image:` to `score-studio:1.1.0`
(the included `docker-compose.yml` already does), and redeploy. Data volumes are unchanged.
