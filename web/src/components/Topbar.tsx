import { Check, Download, Menu, Monitor, Moon, Pause, Play, Printer, Redo2, Sun, Undo2 } from 'lucide-react';
import { downloadScore } from '../lib/api';
import type { Project, ScoreDoc } from '../lib/types';
import type { Playback } from '../hooks/usePlayback';
import type { Theme } from '../hooks/useTheme';
import { Dropdown, InfoTip, Segmented } from './Controls';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

interface Props {
  doc: ScoreDoc | null;
  project: Project | null;
  busy: boolean;
  playback: Playback;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onError: (message: string) => void;
  /** Opens the project library drawer (tablet / phone layouts). */
  onMenu: () => void;
  menuOpen: boolean;
}

export function Topbar({ doc, project, busy, playback, theme, onTheme, onRename, onUndo, onRedo, onError, onMenu, menuOpen }: Props) {
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
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
      <button type="button" className="icon-button menu-button" aria-label="Projects" aria-controls="library"
        aria-expanded={menuOpen} onClick={onMenu}><Menu size={19} /></button>
      <div className="title-group">
        {project ? <input key={`${project.id}:${project.title}`} className="project-title" aria-label="Project title"
          defaultValue={project.title} onBlur={event => {
            if (event.target.value.trim() && event.target.value.trim() !== project.title) void onRename(project.id, event.target.value);
            else event.target.value = project.title;
          }} onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.currentTarget.value = project.title;
              event.currentTarget.blur();
            }
          }} /> : <h1>Score Studio</h1>}
        <span className="save-state" role="status">{busy ? 'Saving…' : doc ? <><Check size={12} />Saved · v{doc.version}</> : project?.status ?? 'No project'}</span>
      </div>
      <div className="history-controls">
        <button className="icon-button" aria-label="Undo" disabled={!doc?.history.can_undo || busy} onClick={onUndo}><Undo2 size={18} /></button>
        <button className="icon-button" aria-label="Redo" disabled={!doc?.history.can_redo || busy} onClick={onRedo}><Redo2 size={18} /></button>
        <InfoTip label="history shortcuts">Undo: Ctrl/⌘ Z. Redo: Ctrl/⌘ Shift Z or Ctrl Y.</InfoTip>
      </div>
      <div className="topbar-controls">
        <Dropdown label="Export" icon={<Download size={16} />} disabled={!doc}>
          <button role="menuitem" onClick={() => void download('score.musicxml')}><FileFormat label="XML" /><span>MusicXML</span></button>
          <button role="menuitem" onClick={() => void download('score.mid')}><FileFormat label="MID" /><span>MIDI</span></button>
          <button role="menuitem" onClick={() => window.print()}><Printer size={16} /><span>Print / PDF</span></button>
        </Dropdown>
        <Dropdown label={theme[0].toUpperCase() + theme.slice(1)} icon={<ThemeIcon size={16} />} className="theme-menu">
          {(['light', 'dark', 'system'] as const).map(value => {
            const Icon = value === 'light' ? Sun : value === 'dark' ? Moon : Monitor;
            return <button key={value} role="menuitemradio" aria-checked={theme === value} onClick={() => onTheme(value)}>
              <Icon size={16} /><span>{value[0].toUpperCase() + value.slice(1)}</span><Check className="dropdown-check" size={15} />
            </button>;
          })}
        </Dropdown>
      </div>
    </div>
    <div className="transport" aria-label="Playback controls">
      <button className="button primary play-button" aria-label={playback.playing || playback.loading ? 'Pause' : 'Play'}
        disabled={!doc} onClick={playback.toggle}>
        {playback.playing || playback.loading ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <Segmented label="Playback source" value={playback.source} disabled={!doc || playback.loading}
        options={doc?.meta.has_audio ? [{ value: 'audio', label: 'Original audio' }, { value: 'synth', label: 'Score synth' }] : [{ value: 'synth', label: 'Score synth' }]}
        onChange={playback.changeSource} className="source-control" />
      <InfoTip label="playback">Space: play or pause. Original audio follows performance timing. Score synth plays the edited MIDI using a piano sampler. Samples load from Salamander on first play; select a note while stopped to seek.</InfoTip>
      <input className="seek-bar" aria-label="Playback position" type="range" disabled={!doc || playback.loading} min="0"
        max={playback.duration || 1} step="0.05" value={Math.min(playback.seconds, playback.duration)}
        onChange={event => playback.seek(Number(event.target.value))} />
      <span className="transport-time">{clock(playback.seconds)}<span> / {clock(playback.duration)}</span></span>
      <span className="tempo">♩ = {doc?.meta.tempo ?? '—'}</span>
      {playback.loading && <span className="sample-status" role="status">Loading piano…</span>}
    </div>
  </header>;
}

function FileFormat({ label }: { label: string }) {
  return <span className="file-format">{label}</span>;
}
