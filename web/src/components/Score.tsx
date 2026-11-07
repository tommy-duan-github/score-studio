import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { DEFAULT_HEADER, engrave, noteId } from '../lib/verovio';
import type { ScoreDoc } from '../lib/types';
import { PAGE_BASE_WIDTH, ZOOM_MAX, ZOOM_MIN, clamp, type ViewPrefs } from '../lib/view';

interface Props {
  doc: ScoreDoc;
  selection: number[];
  onSelect: (ids: number[]) => void;
  quarter: number;
  playing: boolean;
  preview: number[];
  view: ViewPrefs;
  onZoom: (zoom: number) => void;
  onSeek: (quarter: number) => void;
  onError: (message: string) => void;
  /** Display transposition in semitones (reading mode). */
  transpose?: number;
  /** Called when the engraved title block on page 1 is clicked. */
  onEditHeader?: () => void;
}

interface Rectangle { x: number; y: number; width: number; height: number }

export function Score({ doc, selection, onSelect, quarter, playing, preview, view, onZoom, onSeek, onError, transpose = 0, onEditHeader }: Props) {
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [rectangle, setRectangle] = useState<Rectangle | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const scroll = useRef({ top: 0, left: 0 });
  const drag = useRef<{ x: number; y: number; shift: boolean; rect?: Rectangle } | null>(null);
  const renderedProject = useRef(doc.id);
  const groups = useRef(new Map<number, SVGGElement[]>());
  const soundingIds = useRef(new Set<number>());
  const notesById = useMemo(() => new Map(doc.notes.map(note => [note.id, note])), [doc.notes]);

  const pageWidth = Math.round(PAGE_BASE_WIDTH * view.zoom / 100);
  const headerKey = JSON.stringify(doc.header ?? null);
  const zoomRef = useRef(view.zoom);
  zoomRef.current = view.zoom;

  // Side-scroll mode: the mouse wheel scrolls sideways. Ctrl/⌘ + wheel zooms in both modes.
  useEffect(() => {
    const canvas = root.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const step = event.deltaY < 0 ? 10 : -10;
        onZoom(clamp(Math.round((zoomRef.current + step) / 10) * 10, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (view.layout === 'strip' && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        canvas.scrollLeft += event.deltaY;
      }
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [view.layout, onZoom]);

  useEffect(() => {
    let live = true;
    scroll.current = { top: root.current?.scrollTop ?? 0, left: root.current?.scrollLeft ?? 0 };
    if (renderedProject.current !== doc.id) {
      setPages([]);
      scroll.current = { top: 0, left: 0 };
      renderedProject.current = doc.id;
    }
    setLoading(true);
    setFailed(false);
    void api.xml(doc.id, doc.version).then(xml => engrave(xml, {
      staffSize: view.staffSize, barsPerLine: view.barsPerLine, transpose,
      header: doc.header ?? DEFAULT_HEADER, fallbackTitle: doc.title,
    })).then(output => {
      if (live) setPages(output);
    }).catch(error => {
      if (live) {
        setFailed(true);
        onError(error.message);
      }
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- header is compared by value (headerKey)
  }, [doc.id, doc.version, doc.title, headerKey, transpose, attempt, onError, view.staffSize, view.barsPerLine]);

  useLayoutEffect(() => {
    groups.current.clear();
    soundingIds.current.clear();
    root.current?.querySelectorAll<SVGGElement>('g.note').forEach(group => {
      const id = noteId(group);
      if (id !== undefined) groups.current.set(id, [...groups.current.get(id) ?? [], group]);
    });
    root.current?.querySelectorAll<SVGGElement>('g.measure').forEach((group, index) => {
      group.dataset.measure = String(doc.measures[index]?.number ?? index + 1);
    });
    if (root.current) {
      root.current.scrollTop = scroll.current.top;
      root.current.scrollLeft = scroll.current.left;
    }
  }, [pages]);

  useEffect(() => {
    const selected = new Set(selection);
    const proposed = new Set(preview);
    groups.current.forEach((pieces, id) => {
      for (const piece of pieces) {
        piece.classList.toggle('selected', selected.has(id));
        piece.classList.toggle('preview-note', proposed.has(id));
      }
    });
  }, [selection, preview, pages]);

  useEffect(() => {
    const canvas = root.current;
    if (!canvas) return;
    const sounding = new Set(playing ? doc.notes.filter(note => !note.deleted
      && quarter >= note.on && quarter < note.on + Math.max(0.12, note.dur)).map(note => note.id) : []);
    for (const id of soundingIds.current) {
      if (!sounding.has(id)) groups.current.get(id)?.forEach(piece => piece.classList.remove('sounding'));
    }
    for (const id of sounding) {
      if (!soundingIds.current.has(id)) groups.current.get(id)?.forEach(piece => piece.classList.add('sounding'));
    }
    soundingIds.current = sounding;
    if (!cursor.current) return;
    const measure = doc.measures.find(m => quarter >= m.start && quarter < m.start + m.length);
    const group = measure && canvas.querySelector<SVGGElement>(`g.measure[data-measure="${measure.number}"]`);
    cursor.current.hidden = !playing || !group;
    if (!playing || !group || !measure) return;
    const box = group.getBoundingClientRect();
    const parent = canvas.getBoundingClientRect();
    // Interpolate between engraved noteheads, so clefs and unequal rhythmic
    // spacing do not make a linear, whole-measure cursor drift off the beat.
    const anchors = Array.from(group.querySelectorAll<SVGGElement>('g.note')).flatMap(piece => {
      const note = notesById.get(noteId(piece) ?? -1);
      const head = piece.querySelector('.notehead')?.getBoundingClientRect();
      return note && head ? [{ quarter: Math.max(measure.start, note.on), x: head.left + head.width / 2 }] : [];
    }).sort((a, b) => a.quarter - b.quarter);
    if (!anchors.length) anchors.push({ quarter: measure.start, x: box.left });
    anchors.push({ quarter: measure.start + measure.length, x: box.right });
    const next = anchors.findIndex(anchor => anchor.quarter > quarter);
    const right = anchors[next] ?? anchors[anchors.length - 1];
    const left = anchors[Math.max(0, next - 1)] ?? { quarter: measure.start, x: box.left };
    const fraction = Math.max(0, Math.min(1, (quarter - left.quarter) / (right.quarter - left.quarter || 1)));
    const x = left.x + fraction * (right.x - left.x) - parent.left;
    const y = box.top - parent.top;
    cursor.current.style.left = `${x + canvas.scrollLeft}px`;
    cursor.current.style.top = `${y + canvas.scrollTop}px`;
    cursor.current.style.height = `${box.height}px`;
    // Keep the playhead in view: page sideways in side-scroll mode, down in page mode.
    if (x < 40 || x > canvas.clientWidth - 80) canvas.scrollLeft += x - canvas.clientWidth * 0.3;
    if (y < 0 || y + box.height > canvas.clientHeight) canvas.scrollTop += y - canvas.clientHeight * 0.25;
  }, [quarter, playing, doc, pages, view.zoom, view.layout]);

  function click(element: Element | null, shift: boolean, measureSelect: boolean) {
    if (!element) return;
    const group = element.closest('g.note');
    const bar = element.closest<SVGGElement>('g.measure');
    const numberLabel = element.closest('.mNum');
    if (element.closest('.pgHead') && onEditHeader) {
      onEditHeader();
      return;
    }
    if (measureSelect || numberLabel) {
      const number = bar ? Number(bar.dataset.measure) : Number(numberLabel?.textContent);
      const ids = doc.notes.filter(note => !note.deleted && doc.measures[note.measure]?.number === number).map(note => note.id);
      onSelect(Array.from(new Set([...(shift ? selection : []), ...ids])));
      return;
    }
    const id = group ? noteId(group) : undefined;
    if (id === undefined) {
      if (!shift) onSelect([]);
      return;
    }
    onSelect(shift ? Array.from(new Set([...selection, id])) : [id]);
    const note = doc.notes.find(note => note.id === id);
    if (note && !playing) onSeek(note.on);
  }

  return <div className={`score-canvas layout-${view.layout}`} ref={root} data-project-id={doc.id} aria-label="Score pages" tabIndex={-1}
    onScroll={() => {
      scroll.current = { top: root.current?.scrollTop ?? 0, left: root.current?.scrollLeft ?? 0 };
    }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { x: event.clientX, y: event.clientY, shift: event.shiftKey };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      start.rect = {
        x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY),
        width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y),
      };
      setRectangle(start.rect);
    }}
    onPointerUp={event => {
      const start = drag.current;
      drag.current = null;
      if (!start) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!start.rect) {
        click(document.elementFromPoint(event.clientX, event.clientY), event.shiftKey, event.ctrlKey || event.metaKey);
        return;
      }
      const rect = start.rect;
      const ids = Array.from(root.current!.querySelectorAll('g.note')).flatMap(group => {
        const box = group.getBoundingClientRect();
        const id = noteId(group);
        const inside = box.right >= rect.x && box.left <= rect.x + rect.width
          && box.bottom >= rect.y && box.top <= rect.y + rect.height;
        return inside && id !== undefined ? [id] : [];
      });
      onSelect(Array.from(new Set([...(start.shift ? selection : []), ...ids])));
      setRectangle(null);
    }}
    onPointerCancel={() => {
      drag.current = null;
      setRectangle(null);
    }}>
    {loading && <div className="render-status glass glass-pill" role="status"><span className="spinner" />Engraving…</div>}
    {failed && <div className="score-error"><span>Score rendering failed</span><button className="button ghost small" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
    <div className="score-pages">
      {pages.map((svg, index) => <article className="paper" key={index} aria-label={`Score page ${index + 1}`}
        style={{ width: pageWidth }}>
        <div className="paper-heading"><span>{doc.header?.title || doc.title}</span><span>Piano</span></div>
        <div className="engraving" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="paper-footer"><span>{index + 1}</span><span>{pages.length}</span></div>
      </article>)}
    </div>
    <div ref={cursor} className="playhead" hidden />
    {rectangle && <div className="marquee" style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }} />}
  </div>;
}
