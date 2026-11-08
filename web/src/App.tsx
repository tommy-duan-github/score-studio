import { t, useT } from './lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Keyboard, Music2, PanelRight, X } from 'lucide-react';
import { AppSettings } from './components/AppSettings';
import { ModelDownload } from './components/ModelDownload';
import { useModels } from './hooks/useModels';
import { PartNames } from './components/PartNames';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Inspector } from './components/Inspector';
import { Score } from './components/Score';
import { InfoTip } from './components/Controls';
import { ScoreViewControls } from './components/ScoreViewControls';
import { ScoreHeaderControls } from './components/ScoreHeaderControls';
import { ReadingMode } from './components/ReadingMode';
import { useViewPrefs } from './lib/view';
import { useStudio } from './hooks/useStudio';
import { usePlayback } from './hooks/usePlayback';
import { useTheme } from './hooks/useTheme';
import { useGlass } from './hooks/useGlass';
import { useShortcuts } from './hooks/useShortcuts';
import { scrollToMeasure } from './lib/verovio';

export default function App() {
  useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'General' | 'Storage'>('General');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const prompted = useRef(false);
  const [toast, setToast] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<number[]>([]);
  // Tablet / phone layouts: the library and the inspector are drawers.
  const [drawer, setDrawer] = useState<'library' | 'inspector' | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const { view, update: updateView } = useViewPrefs();
  const setZoom = useCallback((zoom: number) => updateView({ zoom }), []);
  const error = useCallback((message: string) => setToast(message), []);
  const studio = useStudio(error);
  const models = useModels(studio.setModelsReady, studio.refreshHealth);
  const closeDownload = useCallback(() => setDownloadOpen(false), []);
  useEffect(() => {
    if (studio.modelsReady !== null && !prompted.current) {
      prompted.current = true;
      if (!studio.modelsReady) setDownloadOpen(true);
    }
  }, [studio.modelsReady]);
  const playback = usePlayback(studio.doc, error);
  const { theme, setTheme } = useTheme();
  const { doc, project } = studio;
  useGlass();

  useEffect(() => {
    setSelected([]);
    setPreview([]);
    setReading(false);
  }, [studio.active]);

  // Reading mode covers the editor: take it out of the tab order and the accessibility tree.
  useEffect(() => {
    if (shell.current) shell.current.inert = reading;
  }, [reading]);

  useEffect(() => {
    if (!drawer) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [drawer]);

  function openReading() {
    // Reading mode is view-only: drop the selection so editing shortcuts (Delete, arrows) have no target.
    setSelected([]);
    setPreview([]);
    setDrawer(null);
    setReading(true);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 8000);
    return () => clearTimeout(timer);
  }, [toast]);

  useShortcuts({
    doc, selected, busy: studio.busy, edit: studio.edit,
    undo: () => void studio.undo(), redo: () => void studio.redo(),
    toggle: playback.toggle,
    clear: () => {
      setSelected([]);
      setPreview([]);
    },
  });

  function showPreview(ids: number[]) {
    setPreview(ids);
    const first = doc?.notes.find(note => ids.includes(note.id));
    if (first && doc) scrollToMeasure(doc.measures[first.measure]?.number);
  }

  return <>
    <div className="ambient" aria-hidden="true"><span className="blob b3" /><span className="blob b4" /></div>
    <div ref={shell} className={`app-shell ${drawer ? `${drawer}-open` : ''}`}>
      <Sidebar projects={studio.projects} active={studio.active} loading={studio.loading} onSelect={studio.setActive}
        modelsMissing={studio.modelsReady === false} onStorage={() => { setDrawer(null); setSettingsSection('Storage'); setSettingsOpen(true); }}
        multi={studio.multi} onUpload={studio.upload} onRetranscribe={studio.retranscribe} onRename={studio.rename} onRemove={studio.remove} onError={error} onClose={() => setDrawer(null)} onSettings={() => { setDrawer(null); setSettingsSection('General'); setSettingsOpen(true); }} />
      <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawer(null)} />
      <main className="main-content">
        <Topbar doc={doc} project={project} busy={studio.busy} playback={playback}
          onRename={studio.rename} onUndo={() => void studio.undo()} onRedo={() => void studio.redo()} onError={error}
          menuOpen={drawer === 'library'} onMenu={() => setDrawer(current => current === 'library' ? null : 'library')} />
        {doc ? <div className="editor">
          <section className="score-area" aria-label={t("Score editor")}>
            <div className="score-toolbar">
              <div className="score-meta"><Music2 size={15} /><PartNames parts={doc.parts} onChange={studio.setParts} busy={studio.busy} /><span>{t("{0} bars", [doc.meta.bars])}</span><span>{t("{0} notes", [doc.meta.notes.toLocaleString()])}</span></div>
              <div className="score-actions">
                <ScoreViewControls view={view} onChange={updateView} />
                <ScoreHeaderControls key={doc.id} doc={doc} onChange={patch => void studio.setHeader(patch)} open={headerOpen} onOpenChange={setHeaderOpen} />
                <button type="button" className="dropdown-trigger glass glass-pill read-button" aria-label={t("Reading mode")} onClick={openReading}>
                  <BookOpen size={14} /><span>{t("Read")}</span>
                </button>
                <button type="button" className="dropdown-trigger glass glass-pill inspector-button" aria-label={t("Editor panel")}
                  aria-controls="inspector" aria-expanded={drawer === 'inspector'}
                  onClick={() => setDrawer(current => current === 'inspector' ? null : 'inspector')}>
                  <PanelRight size={14} /><span>{t("Edit")}</span>
                </button>
              </div>
            </div>
            {preview.length > 0 && <div className="preview-banner"><span>{t("Preview ·")} {t("{0} notes", [preview.length])}</span><button className="text-button" onClick={() => setPreview([])}>{t("Dismiss")}</button></div>}
            <Score doc={doc} selection={selected} onSelect={setSelected} quarter={playback.quarter} playing={playback.playing}
              preview={preview} view={view} onZoom={setZoom} onSeek={playback.seekQuarter} onError={error}
              onEditHeader={() => setHeaderOpen(true)} onParts={studio.setParts} />
            <footer className="score-status"><span>{selected.length ? t("{0} notes selected", [selected.length]) : t("No selection")}</span>
              <InfoTip label={t("score selection")}>{t("Click a note, Shift-click to add notes, or drag to select a passage. Ctrl/⌘-click or click a bar number selects a measure; Esc clears selection and preview.")}</InfoTip>
              <div className="shortcut-help"><Keyboard size={14} /><span>{t("Shortcuts")}</span><InfoTip label={t("keyboard shortcuts")}>{t("Space: play/pause; R/L: hands; 1–4: voice; ↑/↓: semitone; Shift ↑/↓: octave; Delete: remove; Ctrl/⌘ Z: undo; Ctrl/⌘ Shift Z or Ctrl Y: redo; Esc: clear selection. Shortcuts pause while typing.")}</InfoTip></div>
            </footer>
          </section>
          <Inspector key={doc.id} doc={doc} selected={selected} edit={studio.edit} busy={studio.busy}
            changeSettings={settings => void studio.settings(settings)} config={studio.config} onConfig={studio.setConfig}
            onPreview={showPreview} onError={error} onClose={() => setDrawer(null)} onParts={studio.setParts} />
        </div> : <div className="workspace-state">
          {project && project.status === 'error' ? <><AlertCircle size={32} /><h2>{t("Processing failed")}</h2><p>{t(project.error ?? "Upload the file again to retry.")}</p></>
            : project && project.status !== 'ready' ? <><Music2 size={32} /><h2>{t(project.status[0].toUpperCase() + project.status.slice(1))}</h2><p>{t(project.progress?.message ?? "Queued")}</p><progress max="1" value={project.progress?.fraction ?? 0} /></>
              : studio.loading || studio.active ? <h2>{t("Opening project…")}</h2> : <><Music2 size={32} /><h2>{t("No project selected")}</h2></>}
        </div>}
      </main>
    </div>
    <AppSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onTheme={setTheme} projects={studio.projects} onError={error}
      models={models} onDelete={studio.removeBatch} initialSection={settingsSection} />
    {downloadOpen && <ModelDownload models={models} onClose={closeDownload} />}
    {reading && doc && <ReadingMode doc={doc} playback={playback} view={view} onExit={() => setReading(false)} onError={error} />}
    {toast && <div className="toast glass" role="alert"><AlertCircle size={17} /><span>{t(toast)}</span><button className="icon-button" aria-label={t("Dismiss error")} onClick={() => setToast('')}><X size={16} /></button></div>}
  </>;
}
