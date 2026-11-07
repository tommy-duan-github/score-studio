import { useEffect, useState } from 'react';

/** How the score pages are arranged in the score area. */
export type ScoreLayout = 'pages' | 'strip';

export interface ViewPrefs {
  /** 'pages': as many pages per row as fit, scrolling vertically; 'strip': one row, scrolling sideways. */
  layout: ScoreLayout;
  /** Page size in percent of PAGE_BASE_WIDTH. Independent of the window size. */
  zoom: number;
  /** Verovio staff size (scale). Smaller = denser: more bars per line and more lines per page. */
  staffSize: number;
  /** Fixed number of bars per line, or 0 for automatic line breaks. */
  barsPerLine: number;
}

export const DEFAULT_VIEW: ViewPrefs = { layout: 'pages', zoom: 100, staffSize: 40, barsPerLine: 0 };
/** Width of one page at 100% zoom, in CSS pixels (A4 proportions). */
export const PAGE_BASE_WIDTH = 760;
export const PAGE_ASPECT = 2970 / 2100;
export const ZOOM_MIN = 40;
export const ZOOM_MAX = 250;
export const STAFF_MIN = 24;
export const STAFF_MAX = 60;

const KEY = 'score-studio.view';

function load(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_VIEW;
    const value = { ...DEFAULT_VIEW, ...JSON.parse(raw) } as ViewPrefs;
    return {
      layout: value.layout === 'strip' ? 'strip' : 'pages',
      zoom: clamp(Number(value.zoom) || 100, ZOOM_MIN, ZOOM_MAX),
      staffSize: clamp(Number(value.staffSize) || 40, STAFF_MIN, STAFF_MAX),
      barsPerLine: clamp(Math.round(Number(value.barsPerLine) || 0), 0, 16),
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** View preferences shared by all projects and remembered in this browser. */
export function useViewPrefs() {
  const [view, setView] = useState<ViewPrefs>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(view));
    } catch {
      // Storage unavailable (private window): preferences last for this session only.
    }
  }, [view]);
  const update = (patch: Partial<ViewPrefs>) => setView(current => ({ ...current, ...patch }));
  return { view, update };
}
