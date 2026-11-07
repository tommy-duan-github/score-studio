import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Minimize2, Minus, MoreHorizontal, Pause, Play, Plus } from 'lucide-react';
import type { ScoreDoc } from '../lib/types';
import type { Playback } from '../hooks/usePlayback';
import { PAGE_ASPECT, PAGE_BASE_WIDTH, ZOOM_MAX, ZOOM_MIN, clamp, type ViewPrefs } from '../lib/view';
import { InfoTip, Popover, Segmented } from './Controls';
import { Score } from './Score';
import '../styles/reading.css';

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5];
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function fitZoom() {
  const width = window.visualViewport?.width ?? window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  const pageWidth = width <= 640 || height > width
    ? width - 16
    : Math.min(width - 16, (height - 70 - 16) / PAGE_ASPECT);
  return clamp(Math.floor(pageWidth / PAGE_BASE_WIDTH * 100), ZOOM_MIN, ZOOM_MAX);
}

function SourceControl({ playback }: { playback: Playback }) {
  return <Segmented label="Playback source" value={playback.source}
    options={[{ value: 'audio', label: 'Original' }, { value: 'synth', label: 'Synth' }]}
    onChange={playback.changeSource} className="reading-source" />;
}

function SpeedControl({ playback }: { playback: Playback }) {
  return <div className="reading-speed-panel">
    <div className="reading-control-label"><span>Speed</span>
      <InfoTip label="reading speed">Speed changes playback rate while preserving pitch. Space plays or pauses. Ctrl/⌘ + mouse wheel zooms the pages.</InfoTip>
    </div>
    <div className="reading-speed-chips" role="radiogroup" aria-label="Playback speed">
      {SPEEDS.map(speed => <button key={speed} type="button" className="chip" role="radio"
        aria-checked={playback.speed === speed} onClick={() => playback.setSpeed(speed)}>{speed}x</button>)}
    </div>
    <input type="range" aria-label="Playback speed" min="0.5" max="1.5" step="0.05"
      value={playback.speed} onChange={event => playback.setSpeed(Number(event.target.value))} />
  </div>;
}

function TransposeControl({ playback }: { playback: Playback }) {
  return <div className="reading-transpose" role="group" aria-label="Transpose in semitones">
    <button type="button" className="icon-button" aria-label="Transpose down one semitone"
      disabled={playback.transpose <= -12} onClick={() => playback.setTranspose(playback.transpose - 1)}><Minus size={14} /></button>
    <button type="button" className="reading-transpose-value" aria-label={`Transpose ${playback.transpose} semitones; reset to zero`}
      onClick={() => playback.setTranspose(0)}>{playback.transpose > 0 ? '+' : ''}{playback.transpose}</button>
    <button type="button" className="icon-button" aria-label="Transpose up one semitone"
      disabled={playback.transpose >= 12} onClick={() => playback.setTranspose(playback.transpose + 1)}><Plus size={14} /></button>
  </div>;
}

export function ReadingMode({ doc, playback, view, onExit, onError }: {
  doc: ScoreDoc;
  playback: Playback;
  view: ViewPrefs;
  onExit: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [zoom, setZoom] = useState(fitZoom);
  const manualZoom = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ playback, onExit });
  latest.current = { playback, onExit };
  // Shared across StrictMode effect replays, so a pending request is only made once.
  const fullscreen = useRef({ mounted: false, owned: false, pending: null as Promise<void> | null });
  const onZoom = useCallback((value: number) => {
    manualZoom.current = true;
    setZoom(clamp(value, ZOOM_MIN, ZOOM_MAX));
  }, []);

  useEffect(() => {
    const resize = () => {
      if (!manualZoom.current) setZoom(fitZoom());
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const state = fullscreen.current;
    const element = document.documentElement;
    const previousFocus = document.activeElement as HTMLElement | null;
    state.mounted = true;
    root.current?.querySelector<HTMLElement>('.score-canvas')?.focus({ preventScroll: true });
    const exitFullscreen = () => {
      if (!state.owned || document.fullscreenElement !== element) return;
      state.owned = false;
      try {
        void document.exitFullscreen().catch(() => {});
      } catch {
        // The fixed overlay also works without the Fullscreen API.
      }
    };
    if (!document.fullscreenElement && !state.pending && element.requestFullscreen) {
      try {
        state.pending = element.requestFullscreen().then(() => {
          state.owned = document.fullscreenElement === element;
          if (!state.mounted) exitFullscreen();
        }).catch(() => {}).finally(() => { state.pending = null; });
      } catch {
        // Fullscreen can be unavailable, or rejected outside a user activation.
      }
    }
    const fullscreenChange = () => {
      if (document.fullscreenElement !== element) state.owned = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture before the editor's window listener, including when focus is outside a panel.
      const triggers = root.current?.querySelectorAll<HTMLButtonElement>('.popover > button[aria-expanded="true"]');
      const trigger = triggers?.length ? triggers[triggers.length - 1] : undefined;
      event.stopImmediatePropagation();
      if (trigger) {
        event.preventDefault();
        trigger.click();
        trigger.focus();
      } else if (!document.fullscreenElement) {
        event.preventDefault();
        latest.current.onExit();
      }
    };
    document.addEventListener('fullscreenchange', fullscreenChange);
    window.addEventListener('keydown', escape, true);
    return () => {
      state.mounted = false;
      document.removeEventListener('fullscreenchange', fullscreenChange);
      window.removeEventListener('keydown', escape, true);
      exitFullscreen();
      latest.current.playback.setTranspose(0);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div ref={root} className="reading-mode" role="dialog" aria-modal="true" aria-label="Reading mode">
    <Score doc={doc} selection={[]} onSelect={() => {}} preview={[]} quarter={playback.quarter} playing={playback.playing}
      view={{ ...view, layout: 'pages', zoom }} onZoom={onZoom} onSeek={playback.seekQuarter} onError={onError}
      transpose={playback.transpose} />
    <div className="reading-transport glass glass-pill" role="group" aria-label="Reading playback controls">
      <button type="button" className="button primary play-button" aria-label={playback.playing || playback.loading ? 'Pause' : 'Play'}
        aria-busy={playback.loading} onClick={playback.toggle}>
        {playback.playing || playback.loading ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <input className="seek-bar" aria-label="Playback position" type="range" min="0" max={playback.duration || 1}
        step="0.05" value={Math.max(0, Math.min(playback.seconds, playback.duration))} disabled={!playback.duration}
        onChange={event => playback.seek(Number(event.target.value))} />
      <span className="reading-time">{clock(playback.seconds)}<span> / {clock(playback.duration)}</span></span>
      <div className="reading-desktop-controls">
        {doc.meta.has_audio && <SourceControl playback={playback} />}
        <Popover label={`${playback.speed}x`} icon={<Gauge size={14} />} className="reading-speed">
          <SpeedControl playback={playback} />
        </Popover>
        <TransposeControl playback={playback} />
        <button type="button" className="icon-button" aria-label="Exit reading mode" onClick={onExit}><Minimize2 size={17} /></button>
      </div>
      <Popover label="Reading controls" icon={<MoreHorizontal size={19} />} className="reading-more">
        <div className="reading-options">
          {doc.meta.has_audio && <SourceControl playback={playback} />}
          <SpeedControl playback={playback} />
          <div className="reading-control-row">
            <div className="reading-control-label"><span>Transpose</span>
              <InfoTip label="reading transpose">Shift notation and playback by up to an octave. Tap the number to reset. Transpose resets when you leave reading mode; speed is retained.</InfoTip>
            </div>
            <TransposeControl playback={playback} />
          </div>
          <button type="button" className="button ghost small reading-exit" onClick={onExit}><Minimize2 size={16} />Exit reading mode</button>
        </div>
      </Popover>
    </div>
  </div>, document.body);
}
