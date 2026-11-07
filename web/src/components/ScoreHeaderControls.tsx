import { useEffect, useRef, useState } from 'react';
import { Heading, RotateCcw } from 'lucide-react';
import { Label, Popover, Switch } from './Controls';
import { DEFAULT_HEADER } from '../lib/verovio';
import type { ScoreDoc, ScoreHeader } from '../lib/types';

type TextField = 'title' | 'subtitle' | 'composer';
type SizeField = 'title_size' | 'subtitle_size' | 'composer_size';

const FIELDS: { text: TextField; size: SizeField; label: string; max: number; min: number }[] = [
  { text: 'title', size: 'title_size', label: 'Title', min: 100, max: 500 },
  { text: 'subtitle', size: 'subtitle_size', label: 'Subtitle', min: 60, max: 300 },
  { text: 'composer', size: 'composer_size', label: 'Composer', min: 60, max: 300 },
];

interface Props {
  doc: ScoreDoc;
  onChange: (patch: Partial<ScoreHeader>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Title block editor: text and size of the title, subtitle and composer engraved on page 1. */
export function ScoreHeaderControls({ doc, onChange, open, onOpenChange }: Props) {
  const header = { ...DEFAULT_HEADER, ...doc.header };
  const [draft, setDraft] = useState(header);
  const key = JSON.stringify(header);
  useEffect(() => setDraft(header), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitText = (field: TextField) => {
    const value = draft[field].trim();
    if (value !== header[field]) onChange({ [field]: value });
  };
  const commitSize = (field: SizeField, value: number) => {
    if (value !== header[field]) onChange({ [field]: value });
  };
  // Closing the panel (outside click) can unmount a focused field before its blur fires: save typed text then.
  const latest = useRef({ draft, header, onChange });
  latest.current = { draft, header, onChange };
  useEffect(() => {
    if (open) return;
    const { draft: typed, header: saved, onChange: save } = latest.current;
    const patch: Partial<ScoreHeader> = {};
    for (const { text } of FIELDS) if (typed[text].trim() !== saved[text]) patch[text] = typed[text].trim();
    if (Object.keys(patch).length) save(patch);
  }, [open]);
  const changed = FIELDS.some(({ size }) => header[size] !== DEFAULT_HEADER[size]);

  return <Popover label="Title" icon={<Heading size={14} />} className="header-control" open={open} onOpenChange={onOpenChange}>
    <div className="density-panel header-panel">
      <div className="density-row">
        <Label tip="Title block engraved at the top of page 1, printed to PDF and written to MusicXML exports. An empty title uses the project name. Sizes are relative to normal text (100% ≈ 12 pt).">
          Title block
        </Label>
        <Switch label="Show title block" checked={header.show} onChange={show => onChange({ show })} />
      </div>
      {FIELDS.map(({ text, size, label, min, max }) => <div className="header-field" key={text}>
        <label className="field">
          <span className="header-field-label"><span>{label}</span><span className="density-value">{draft[size]}%</span></span>
          <input
            aria-label={label}
            value={draft[text]}
            placeholder={text === 'title' ? doc.title : ''}
            maxLength={text === 'subtitle' ? 300 : 200}
            disabled={!header.show}
            onChange={event => setDraft(current => ({ ...current, [text]: event.target.value }))}
            onBlur={() => commitText(text)}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setDraft(current => ({ ...current, [text]: header[text] }));
            }}
          />
        </label>
        <input
          aria-label={`${label} size`}
          type="range"
          min={min}
          max={max}
          step={10}
          value={draft[size]}
          disabled={!header.show}
          onChange={event => setDraft(current => ({ ...current, [size]: Number(event.target.value) }))}
          onPointerUp={event => commitSize(size, Number(event.currentTarget.value))}
          onKeyUp={event => commitSize(size, Number(event.currentTarget.value))}
          onBlur={event => commitSize(size, Number(event.currentTarget.value))}
        />
      </div>)}
      <button
        type="button"
        className="button ghost small density-reset"
        disabled={!changed || !header.show}
        onClick={() => onChange({ title_size: DEFAULT_HEADER.title_size, subtitle_size: DEFAULT_HEADER.subtitle_size, composer_size: DEFAULT_HEADER.composer_size })}
      ><RotateCcw size={13} />Default sizes</button>
    </div>
  </Popover>;
}
