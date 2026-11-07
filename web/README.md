# Score Studio

React 18, TypeScript and Vite frontend for piano transcription and score editing. Uses Verovio WASM, Tone.js, @tonejs/midi and lucide-react. No additional dependencies or remote fonts.

## Run

Run from `web/` with Node 20.19+ (Node 24 recommended). Use `npm.cmd` on Windows if PowerShell blocks `npm`.

```sh
npm run dev
npm run dev:mock
npm run build
npm run preview
```

Development runs at http://127.0.0.1:5173 and proxies `/api` to http://127.0.0.1:8000. Preview uses port 4173. Pass `-- --port 5174` to choose another development port. The backend serves the production `dist/` build.

`scripts/vite.mjs` uses Vite's JavaScript API to load `vite.config.mjs` directly. This avoids native esbuild config bundling, which cannot traverse parent folders in restricted Windows workspaces. The frontend still uses Vite's normal React plugin, TypeScript transforms and production bundling.

Mock mode is enabled by `dev:mock`, `VITE_MOCK=1`, or `?mock=1`. A regular production build supports `?mock=1`; otherwise it uses the real API. A dedicated mock build can be created with `npm run build -- --mode mock`.

## Source tree

```text
src/
  App.tsx
  main.tsx
  env.d.ts
  components/
    Controls.tsx        # Info tips, lens segments, switches and menus
    Sidebar.tsx         # Upload, project library, rename/delete dialogs
    Topbar.tsx          # Title, history, transport, export, appearance
    Score.tsx           # Pages, selection, zoom, highlights and cursor
    Inspector.tsx       # Note / Review / Assistant / Settings tabs
    NotePanel.tsx
    ReviewPanel.tsx
    AssistantPanel.tsx
    SettingsPanel.tsx
  hooks/
    useStudio.ts        # Project loading, polling and serialized mutations
    usePlayback.ts      # Transport state and cancellation
    useShortcuts.ts
    useTheme.ts
    useGlass.ts         # Pointer-tracked glints
    useLens.ts          # Lens placement, dragging, resize/theme updates
  lib/
    types.ts            # HTTP contract types
    api.ts              # Typed client and exports
    mock.ts             # In-memory projects, edits, history and MIDI
    verovio.ts          # Lazy WASM initialization and engraving
    playback.ts         # Audio, sampler, MIDI and timemap conversion
    lens.ts             # SVG displacement/specular optics
  styles/
    tokens.css          # Light/dark palette and local Rubik fonts
    glass.css           # Glass material and controls
    components.css      # Studio layout, score paper, responsive and print
public/
  fonts/
  fixtures/score.musicxml
scripts/
  vite.mjs
  verify-live.mjs
tests/
  studio.spec.ts
  playback.spec.ts
```

`design-ref/` is reference material only. It is excluded from TypeScript's source set, is never imported into the app, and is denied by the dev server. Production output contains only the application, fonts and score fixture.

## Behavior

The API follows [docs/API.md](../docs/API.md). Editing and settings requests are serialized and use the returned document version to fetch fresh MusicXML. Engraving preserves scroll position and selected document note IDs. SVG IDs `n{id}` and `n{id}-t{k}` share selection, preview and playback highlights. Deleted notes retain their selection for Restore or Undo.

Score pages fit the available panel width by default. Zoom controls can enlarge the pages deliberately. Print/PDF uses the browser print dialog, with only the score pages visible and black notation on white paper.

The interface uses blue/purple light and dark tokens, local Rubik fonts, ambient blobs, glass material, glints and spring motion. Chromium uses SVG displacement lenses; other browsers get a clear pane fallback. Appearance follows the system by default. Info points support hover, keyboard focus, click/tap and Escape, and stay within the viewport. Reduced motion preferences disable animation.

Shortcuts are documented in the interface's info points. Click selects a note, Shift-click adds notes, dragging selects a passage, and Ctrl/Command-click or a bar number selects a measure. R/L assigns a hand, 1–4 assigns a voice, Delete removes notes, arrows transpose (Shift for octaves), Space plays/pauses, Escape clears selection, and Ctrl/Command Z / Shift Z or Ctrl Y navigates history. Typing in fields does not trigger score shortcuts.

Original audio follows the document timemap. Score synthesis fetches versioned score MIDI and loads Salamander piano samples on first play from `https://tonejs.github.io/audio/salamander/`. Sample failures and timeouts produce recoverable error toasts. Changing project, editing, seeking or cancelling a pending load stops stale playback.

## Mock limits

Mock projects, uploads, edits, history, reviews, settings and assistant configuration are kept in memory and reset on refresh. Uploads simulate processing stages using the same fixture. Edits change the document and generated MIDI; mock MusicXML and its engraving remain the fixture. Mock projects have no original audio. The mock assistant returns a deterministic proposal and never contacts DeepSeek or retains the supplied key.

## Verification

```sh
npm run build
npm run test:smoke
```

Browser checks use installed Chrome and start mock mode on port 5174. No browser download is required if Chrome is installed. Seven tests cover rendering, selection, edits, history, review, settings, assistant, upload polling, library actions, exports, print, themes, responsive fit, sampler playback and errors. Sampler tests fulfill the public sample URLs with a local PCM sample, exercising real Tone decoding/scheduling without a network dependency.

To repeat the read-only checks against the supplied backend projects, run a real development server on port 5175, then:

```sh
node scripts/verify-live.mjs
```

Override `STUDIO_LIVE_URL` to use another frontend address. Screenshots and a print PDF are written to ignored `test-results/`. See [VERIFICATION.md](VERIFICATION.md) for the latest checks and limits.
