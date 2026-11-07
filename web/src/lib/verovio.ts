import type { VerovioToolkit } from 'verovio/esm';
import type { ScoreHeader } from './types';

let toolkit: Promise<VerovioToolkit> | undefined;

export const DEFAULT_HEADER: ScoreHeader = {
  title: '', subtitle: '', composer: '', title_size: 250, subtitle_size: 120, composer_size: 110, show: true,
};

export interface EngraveOptions {
  /** Verovio scale (staff size). */
  staffSize: number;
  /** Fixed bars per line, or 0 for automatic line breaks. */
  barsPerLine: number;
  /** Display transposition in semitones (0 = as written). */
  transpose?: number;
  /** Title block for page 1; `title` falls back to `fallbackTitle`. Omit or `show: false` for none. */
  header?: ScoreHeader | null;
  fallbackTitle?: string;
}

/** Adds a MusicXML system break before every `perLine`-th measure. */
function withLineBreaks(xml: string, perLine: number): string {
  let index = 0;
  return xml.replace(/<measure\b[^>]*>/g, tag => {
    const breakHere = index > 0 && index % perLine === 0;
    index += 1;
    return breakHere ? `${tag}<print new-system="yes"/>` : tag;
  });
}

const escapeXml = (text: string) => text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`);
const percent = (value: number) => Math.round(Math.max(40, Math.min(600, Number(value) || 100)));
const size = (value: number) => `${percent(value)}%`;

/** Verovio's normal text size in page units (at 100%), and its default left + right page margins. */
const TEXT_UNITS = 405;
const MARGINS = 1000;
let measurer: CanvasRenderingContext2D | null | undefined;

/** Width of `text` in em, as engraved (Verovio draws page-header text in Times). */
function textWidth(text: string, bold: boolean) {
  measurer ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measurer) return text.length * (bold ? .55 : .5);
  measurer.font = `${bold ? 'bold ' : ''}100px "Times New Roman", Times, serif`;
  return measurer.measureText(text).width / 100;
}

/** Verovio does not wrap page-header text: break it at word boundaries to fit `width` page units. */
function wrap(text: string, sizePercent: number, bold: boolean, width: number): string[] {
  const em = TEXT_UNITS * percent(sizePercent) / 100;
  const fits = (line: string) => textWidth(line, bold) * em <= width;
  return text.split(/\r?\n/).flatMap(paragraph => {
    const lines: string[] = [];
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // A single word wider than the page is broken by characters.
      for (const char of word) {
        if (line && !fits(line + char)) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    if (line) lines.push(line);
    return lines;
  });
}

/** MEI page header: centred title + subtitle, composer on the right. Verovio reserves its height on page 1.
 *  `pageWidth` is the Verovio page width option (page units / 10). */
export function pageHeader(header: ScoreHeader | null | undefined, fallbackTitle = '', pageWidth = 2100): string {
  if (!header || !header.show) return '';
  const title = (header.title || fallbackTitle).trim();
  const subtitle = header.subtitle.trim();
  const composer = header.composer.trim();
  if (!title && !subtitle && !composer) return '';
  const usable = pageWidth * 10 - MARGINS;
  const lines = (text: string, sizePercent: number, bold = false, share = 1) =>
    wrap(text, sizePercent, bold, usable * share).map(escapeXml).join('<lb/>');
  // Title and subtitle are separate blocks: inside one block Verovio spaces a line break by the smaller
  // font, so a large title would collide with the subtitle.
  const centre = (text: string) => `<rend halign="center" valign="top">${text}</rend>`;
  return '<pgHead func="first">'
    + (title ? centre(`<rend fontsize="${size(header.title_size)}" fontweight="bold">${lines(title, header.title_size, true)}</rend>`) : '')
    + (subtitle ? centre(`<rend fontsize="${size(header.subtitle_size)}">${lines(subtitle, header.subtitle_size)}</rend>`) : '')
    + (composer ? `<rend halign="right" valign="bottom"><rend fontsize="${size(header.composer_size)}">${lines(composer, header.composer_size, false, .45)}</rend></rend>` : '')
    + '</pgHead>';
}

export async function engrave(xml: string, options: EngraveOptions): Promise<string[]> {
  toolkit ??= Promise.all([import('verovio/wasm'), import('verovio/esm')])
    .then(async ([{ default: createModule }, { VerovioToolkit }]) => new VerovioToolkit(await createModule()));
  const renderer = await toolkit;
  const fixed = options.barsPerLine > 0;
  const semitones = Math.round(options.transpose ?? 0);
  const transpose = semitones ? `${semitones > 0 ? '+' : ''}${semitones}` : '';
  // Verovio's `scale` only resizes its output; layout depends on the page size in staff units.
  // So density is set by enlarging the logical page (A4 proportions kept) at a constant scale;
  // the SVG is then drawn at the fixed on-screen page width, which makes the staves smaller.
  const density = 40 / options.staffSize;
  const pageWidth = Math.round(2100 * density);
  // Keep toolkit access synchronous after initialization: its document is mutable.
  renderer.setOptions({
    pageWidth,
    pageHeight: Math.round(2970 * density),
    scale: 40,
    adjustPageHeight: false,
    breaks: fixed ? 'line' : 'auto',
    header: 'none',
    footer: 'none',
    svgViewBox: true,
    transpose,
  });
  const data = fixed ? withLineBreaks(xml, options.barsPerLine) : xml;
  if (!renderer.loadData(data)) throw new Error('Could not engrave the score');
  const head = pageHeader(options.header, options.fallbackTitle, pageWidth);
  if (head) {
    // MusicXML credits lose their font sizes in Verovio, so the title block is injected as an MEI
    // <pgHead>. The exported MEI is already transposed: reload it without transposing again.
    const mei = renderer.getMEI({}).replace(/<pgHead\b[\s\S]*?<\/pgHead>/g, '').replace(/<scoreDef\b[^>]*>/, tag => tag + head);
    renderer.setOptions({ header: 'auto', transpose: '' });
    if (!renderer.loadData(mei)) throw new Error('Could not engrave the score');
  }
  return Array.from({ length: renderer.getPageCount() }, (_, index) => renderer.renderToSVG(index + 1));
}

export function noteId(element: Element): number | undefined {
  const match = element.id.match(/^n(\d+)(-t\d+)?$/);
  return match ? Number(match[1]) : undefined;
}

export function scrollToMeasure(number: number) {
  document.querySelector(`[data-measure="${number}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
}
