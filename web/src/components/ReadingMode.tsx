import { t } from '../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownUp, ArrowLeftRight, BookOpen, Check, ChevronLeft, ChevronRight, Gauge, Minimize2, Minus, MoreHorizontal, Pause, Play, Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useClearGlass } from '../hooks/useLens';
import type { ScoreDoc } from '../lib/types';
import type { Playback } from '../hooks/usePlayback';
import { PAGE_ASPECT, PAGE_BASE_WIDTH, ZOOM_MAX, ZOOM_MIN, clamp, type ViewPrefs } from '../lib/view';
import { InfoTip, Popover, Segmented } from './Controls';
import { Score } from './Score';
import '../styles/reading.css';

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5];
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** How pages advance: scroll down, scroll sideways, or one page at a time turned by tapping the screen edges. */
type Flow = 'vertical' | 'horizontal' | 'flip';
const FLOWS: { value: Flow; label: string; icon: typeof BookOpen }[] = [
  { value: 'vertical', label: 'Vertical scroll', icon: ArrowDownUp },
  { value: 'horizontal', label: 'Sideways scroll', icon: ArrowLeftRight },
  { value: 'flip', label: 'Tap to turn pages', icon: BookOpen },
];
const FLOW_KEY = 'score-studio.reading-flow';
/** The reading bar is a thick lens: a wide, deep rim that visibly bends the page, with a faint specular edge. */
const BAR_LENS = { bezel: 20, depth: 3.2, rim: .16 };
function loadFlow(): Flow {
  try {
    const value = localStorage.getItem(FLOW_KEY);
    return value === 'horizontal' || value === 'flip' ? value : 'vertical';
  } catch {
    return 'vertical';
  }
}

/** Vertical fills the width on portrait screens; sideways and page turning fit a whole page to the height. */
function fitZoom(flow: Flow) {
  const width = window.visualViewport?.width ?? window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  // A paper is the engraving (PAGE_ASPECT) plus ~52px of padding, title and page-number rows;
  // 80px leaves the top inset and the playback bar clear.
  const byHeight = Math.min(width - 16, (height - 80 - (flow === 'vertical' ? 6 : 52)) / PAGE_ASPECT);
  const pageWidth = flow === 'vertical' && (width <= 640 || height > width) ? width - 16 : byHeight;
  return clamp(Math.floor(pageWidth / PAGE_BASE_WIDTH * 100), ZOOM_MIN, ZOOM_MAX);
}

function FlowOptions({ flow, onChange }: { flow: Flow; onChange: (flow: Flow) => void }) {
  return <div className="reading-flow-options" role="radiogroup" aria-label={t("Page turning")}>
    {FLOWS.map(item => <button key={item.value} type="button" role="radio" aria-checked={flow === item.value}
      className="reading-flow-option" onClick={() => onChange(item.value)}>
      <item.icon size={16} /><span>{t(item.label)}</span>{flow === item.value && <Check size={15} className="reading-flow-check" />}
    </button>)}
  </div>;
}

function SourceControl({ playback }: { playback: Playback }) {
  return <Segmented label={t("Playback source")} value={playback.source}
    options={[{ value: 'audio', label: 'Original' }, { value: 'synth', label: 'Synth' }]}
    onChange={playback.changeSource} className="reading-source" />;
}

function SpeedControl({ playback }: { playback: Playback }) {
  return <div className="reading-speed-panel">
    <div className="reading-control-label"><span>{t("Speed")}</span>
      <InfoTip label={t("reading speed")}>{t("Change playback speed while preserving pitch; Space plays or pauses. Ctrl/⌘ + mouse wheel zooms the pages.")}</InfoTip>
    </div>
    <div className="reading-speed-chips" role="radiogroup" aria-label={t("Playback speed")}>
      {SPEEDS.map(speed => <button key={speed} type="button" className="chip" role="radio"
        aria-checked={playback.speed === speed} onClick={() => playback.setSpeed(speed)}>{speed}{t("x")}</button>)}
    </div>
    <input type="range" aria-label={t("Playback speed")} min="0.5" max="1.5" step="0.05"
      value={playback.speed} onChange={event => playback.setSpeed(Number(event.target.value))} />
  </div>;
}

function TransposeControl({ playback }: { playback: Playback }) {
  return <div className="reading-transpose" role="group" aria-label={t("Transpose in semitones")}>
    <button type="button" className="icon-button" aria-label={t("Transpose down one semitone")}
      disabled={playback.transpose <= -12} onClick={() => playback.setTranspose(playback.transpose - 1)}><Minus size={14} /></button>
    <button type="button" className="reading-transpose-value" aria-label={t("Transpose {0} semitones; reset to zero", [playback.transpose])}
      onClick={() => playback.setTranspose(0)}>{playback.transpose > 0 ? '+' : ''}{playback.transpose}</button>
    <button type="button" className="icon-button" aria-label={t("Transpose up one semitone")}
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
  const [flow, setFlow] = useState<Flow>(loadFlow);
  const [zoom, setZoom] = useState(() => fitZoom(flow));
  const [flowOpen, setFlowOpen] = useState(false);
  const manualZoom = useRef(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const root = useRef<HTMLDivElement>(null);
  const bar = useClearGlass<HTMLDivElement>(BAR_LENS);
  const changeFlow = useCallback((next: Flow) => {
    setFlow(next);
    setFlowOpen(false);
    manualZoom.current = false;
    setZoom(fitZoom(next));
    try {
      localStorage.setItem(FLOW_KEY, next);
    } catch {
      // Private window: the choice lasts for this session.
    }
    requestAnimationFrame(() => root.current?.querySelector('.score-canvas')?.scrollTo({ left: 0, top: 0 }));
  }, []);
  /** Page turning: one viewport-wide step; scroll snapping centres the page. */
  const turn = useCallback((direction: 1 | -1) => {
    const canvas = root.current?.querySelector<HTMLElement>('.score-canvas');
    canvas?.scrollBy({ left: direction * canvas.clientWidth, behavior: 'smooth' });
  }, []);
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
      if (!manualZoom.current) setZoom(fitZoom(flowRef.current));
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
      const target = event.target as Element | null;
      if (flowRef.current === 'flip' && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)
        && !target?.closest?.('input, select, textarea, [role=radiogroup], .popover-panel')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        turn(event.key === 'ArrowRight' || event.key === 'PageDown' ? 1 : -1);
        return;
      }
      if (event.key !== 'Escape' || document.querySelector('.tip-bubble')) return;
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
  }, [turn]);

  const current = FLOWS.find(item => item.value === flow)!;
  const pageWidth = Math.round(PAGE_BASE_WIDTH * zoom / 100);
  return createPortal(<div ref={root} className={`reading-mode flow-${flow}`} role="dialog" aria-modal="true" aria-label={t("Reading mode")}
    style={{ '--reading-page': `${pageWidth}px` } as CSSProperties}>
    <Score doc={doc} selection={[]} onSelect={() => {}} preview={[]} quarter={playback.quarter} playing={playback.playing}
      view={{ ...view, layout: flow === 'vertical' ? 'pages' : 'strip', zoom }} onZoom={onZoom} onSeek={playback.seekQuarter} onError={onError}
      transpose={playback.transpose} />
    {flow === 'flip' && <>
      <button type="button" className="reading-turn previous" aria-label={t("Previous page")} onClick={() => turn(-1)}><ChevronLeft size={22} /></button>
      <button type="button" className="reading-turn next" aria-label={t("Next page")} onClick={() => turn(1)}><ChevronRight size={22} /></button>
    </>}
    <div ref={bar} className="reading-transport glass glass-pill clear" role="group" aria-label={t("Reading playback controls")}>
      <button type="button" className="button primary play-button" aria-label={playback.playing || playback.loading ? t("Pause") : t("Play")}
        aria-busy={playback.loading} onClick={playback.toggle}>
        {playback.playing || playback.loading ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <input className="seek-bar" aria-label={t("Playback position")} type="range" min="0" max={playback.duration || 1}
        step="0.05" value={Math.max(0, Math.min(playback.seconds, playback.duration))} disabled={!playback.duration}
        onChange={event => playback.seek(Number(event.target.value))} />
      <span className="reading-time">{clock(playback.seconds)}<span> / {clock(playback.duration)}</span></span>
      <div className="reading-desktop-controls">
        {doc.meta.has_audio && <SourceControl playback={playback} />}
        <Popover label={t("{0}x", [playback.speed])} icon={<Gauge size={14} />} className="reading-speed">
          <SpeedControl playback={playback} />
        </Popover>
        <TransposeControl playback={playback} />
        <Popover label={t(current.label)} icon={<current.icon size={15} />} className="reading-flow" open={flowOpen} onOpenChange={setFlowOpen}>
          <FlowOptions flow={flow} onChange={changeFlow} />
        </Popover>
        <button type="button" className="icon-button" aria-label={t("Exit reading mode")} onClick={onExit}><Minimize2 size={17} /></button>
      </div>
      <Popover label={t("Reading controls")} icon={<MoreHorizontal size={19} />} className="reading-more">
        <div className="reading-options">
          {doc.meta.has_audio && <SourceControl playback={playback} />}
          <SpeedControl playback={playback} />
          <div className="reading-control-label"><span>{t("Page turning")}</span></div>
          <FlowOptions flow={flow} onChange={changeFlow} />
          <div className="reading-control-row">
            <div className="reading-control-label"><span>{t("Transpose")}</span>
              <InfoTip label={t("reading transpose")}>{t("Shift notation and playback by up to an octave; tap the number to reset. Leaving reading mode resets transposition and keeps the speed.")}</InfoTip>
            </div>
            <TransposeControl playback={playback} />
          </div>
          <button type="button" className="button ghost small reading-exit" onClick={onExit}><Minimize2 size={16} />{t("Exit reading mode")}</button>
        </div>
      </Popover>
    </div>
  </div>, document.body);
}
