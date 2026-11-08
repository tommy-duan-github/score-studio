import { t } from '../lib/i18n';
import { useState } from 'react';
import { InlineName } from './InlineName';
import { downloadOriginal, renderAudio } from '../lib/exportAudio';
import { AudioLines, Check, Download, FileAudio, FileCode2, FileMusic, Menu, Pause, Play, Printer, Redo2, Undo2 } from 'lucide-react';
import { api, downloadScore } from '../lib/api';
import type { Project, ScoreDoc } from '../lib/types';
import type { Playback } from '../hooks/usePlayback';
import { Dropdown, InfoTip, Segmented } from './Controls';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

interface Props {
  doc: ScoreDoc | null;
  project: Project | null;
  busy: boolean;
  playback: Playback;
  onRename: (id: string, title: string) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onError: (message: string) => void;
  /** Opens the project library drawer (tablet / phone layouts). */
  onMenu: () => void;
  menuOpen: boolean;
}

export function Topbar({ doc, project, busy, playback, onRename, onUndo, onRedo, onError, onMenu, menuOpen }: Props) {
  const [rendering, setRendering] = useState<number | null>(null);
  const [originalFormat, setOriginalFormat] = useState<{ id: string; extension: string } | null>(null);
  function loadOriginalFormat() {
    if (!doc?.meta.has_audio || originalFormat?.id === doc.id) return;
    void api.originalFilename(doc).then(filename => {
      const extension = filename.match(/\.[^.]+$/)?.[0];
      if (extension) setOriginalFormat({ id: doc.id, extension });
    }).catch(() => {}); // Download reports actual errors; header discovery is optional.
  }
  async function wav() {
    if (!doc || rendering !== null) return;
    setRendering(0);
    try { await renderAudio(doc, setRendering); } catch (error) { onError((error as Error).message); }
    finally { setRendering(null); }
  }
  async function download(name: 'score.musicxml' | 'score.mid') {
    if (!doc) return;
    try {
      await downloadScore(doc, name);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  return <header className="topbar glass">
    <div className="topbar-row">
      <button type="button" className="icon-button menu-button" aria-label={t("Projects")} aria-controls="library"
        aria-expanded={menuOpen} onClick={onMenu}><Menu size={19} /></button>
      <div className="title-group">
        {project ? <InlineName key={project.id} value={project.title} label={t("Project title")} className="project-title"
          onSave={title => void onRename(project.id, title)} /> : <h1>{t("Score Studio")}</h1>}
        <span className="save-state" role="status">{busy ? t("Saving…") : doc ? <><Check size={12} />{t("Saved · v")}{doc.version}</> : t(project?.status ?? 'No project')}</span>
      </div>
      <div className="history-controls">
        <button className="icon-button" aria-label={t("Undo")} disabled={!doc?.history.can_undo || busy} onClick={onUndo}><Undo2 size={18} /></button>
        <button className="icon-button" aria-label={t("Redo")} disabled={!doc?.history.can_redo || busy} onClick={onRedo}><Redo2 size={18} /></button>
        <InfoTip label={t("history shortcuts")}>{t("Undo: Ctrl/⌘ Z. Redo: Ctrl/⌘ Shift Z or Ctrl Y.")}</InfoTip>
      </div>
      <div className="topbar-controls">
        <Dropdown label={t("Export")} icon={<Download size={16} />} disabled={!doc || rendering !== null} onOpen={loadOriginalFormat}>
          <div className="export-group">{t("Score")}</div>
          <button role="menuitem" onClick={() => void download('score.musicxml')}><FileCode2 size={16} /><span>{t("MusicXML")}</span><small>{t(".musicxml")}</small></button>
          <button role="menuitem" onClick={() => void download('score.mid')}><FileMusic size={16} /><span>{t("MIDI")}</span><small>{t(".mid")}</small></button>
          <button role="menuitem" onClick={() => window.print()}><Printer size={16} /><span>{t("Print / PDF")}</span><small>{t("PDF")}</small></button>
          <div className="export-group">{t("Audio")}</div>
          <button role="menuitem" onClick={() => void wav()}><AudioLines size={16} /><span>{t("Rendered audio")}</span><small>{t(".wav")}</small></button>
          {doc?.meta.has_audio && <button role="menuitem" onClick={() => void downloadOriginal(doc).catch(error => onError(error.message))}><FileAudio size={16} /><span>{t("Original audio")}</span><small>{originalFormat?.id === doc.id ? originalFormat.extension : t("Original format")}</small></button>}
        </Dropdown>
        {rendering !== null && <span role="status" className="export-progress">{t("Rendering audio…")}{Math.round(rendering)}%</span>}
      </div>
    </div>
    <div className="transport" aria-label={t("Playback controls")}>
      <button className="button primary play-button" aria-label={playback.playing || playback.loading ? t("Pause") : t("Play")}
        disabled={!doc} onClick={playback.toggle}>
        {playback.playing || playback.loading ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <Segmented label={t("Playback source")} value={playback.source} disabled={!doc || playback.loading}
        options={doc?.meta.has_audio ? [{ value: 'audio', label: 'Original audio' }, { value: 'synth', label: 'Score synth' }] : [{ value: 'synth', label: 'Score synth' }]}
        onChange={playback.changeSource} className="source-control" />
      <InfoTip label={t("playback")}>{t("Space plays or pauses; select a note while stopped to seek. Original audio follows the recording; Score synth plays edited notes with bundled local piano samples and sustained tones for other instruments.")}</InfoTip>
      <input className="seek-bar" aria-label={t("Playback position")} type="range" disabled={!doc || playback.loading} min="0"
        max={playback.duration || 1} step="0.05" value={Math.min(playback.seconds, playback.duration)}
        onChange={event => playback.seek(Number(event.target.value))} />
      <span className="transport-time">{clock(playback.seconds)}<span> / {clock(playback.duration)}</span></span>
      <span className="tempo">♩ = {doc?.meta.tempo ?? '—'}</span>
      {playback.loading && <span className="sample-status" role="status">{t("Loading piano…")}</span>}
    </div>
  </header>;
}
