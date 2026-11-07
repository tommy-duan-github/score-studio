import { useEffect, useState } from 'react';
import { Music2, RotateCcw, Trash2 } from 'lucide-react';
import type { Op, ScoreDoc } from '../lib/types';
import { InfoTip, Label, Segmented, Switch } from './Controls';

export type Edit = (ops: Op[], label?: string) => Promise<boolean>;
const durations = [{ value: 4, label: '1' }, { value: 2, label: '1/2' }, { value: 1, label: '1/4' },
{ value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 0.125, label: '1/32' }];

export function NotePanel({ doc, selected, busy, edit }: { doc: ScoreDoc; selected: number[]; busy: boolean; edit: Edit }) {
  const notes = doc.notes.filter(note => selected.includes(note.id));
  const first = notes[0];
  const disabled = !notes.length || busy;
  const [dotted, setDotted] = useState(false);
  const [spelling, setSpelling] = useState<'auto' | 'sharp' | 'flat'>('auto');
  const selectionKey = selected.join(',');
  useEffect(() => {
    setDotted(durations.some(duration => Math.abs(duration.value * 1.5 - (first?.dur ?? 0)) < 0.001));
    setSpelling('auto');
  }, [selectionKey, first?.dur]);
  const apply = (op: Op, label: string) => void edit([op], label);
  const staff = notes.every(note => note.staff === first?.staff) ? first?.staff : undefined;
  const voice = notes.every(note => note.voice === first?.voice) ? first?.voice : undefined;

  return <div className="note-panel">
    <div className="panel-heading"><h2>Notes</h2><span className="count chip">{selected.length} selected</span></div>
    {first ? <div className="note-summary">
      <div className="note-name">{notes.length === 1 ? first.name : `${notes.length} notes`}
        <span>{notes.length === 1 ? `MIDI ${first.pitch}` : `${Math.min(...notes.map(note => note.pitch))}–${Math.max(...notes.map(note => note.pitch))}`}</span>
      </div>
      <dl className="note-details">
        <dt>Position</dt><dd>Bar {doc.measures[first.measure]?.number} · Beat {+(first.beat + 1).toFixed(3)}</dd>
        <dt>Hand / voice</dt><dd>{staff ? staff === 1 ? 'Right' : 'Left' : 'Mixed'} / {voice ?? 'Mixed'}</dd>
        <dt>Duration</dt><dd>{+first.dur.toFixed(3)} quarters</dd>
        <dt>Velocity</dt><dd>{first.velocity}</dd>
        <dt>Performance</dt><dd>{first.perf_on.toFixed(2)}–{first.perf_off.toFixed(2)}s</dd>
        <dt>Overrides</dt><dd>{first.edited.join(', ') || 'None'}</dd>
        {first.deleted && <><dt>Status</dt><dd className="danger">Deleted</dd></>}
      </dl>
    </div> : <div className="selection-empty"><Music2 size={26} /><span>Select notes</span>
      <InfoTip label="note selection">Click a note to select it. Shift-click adds notes. Drag a rectangle to select a passage. Ctrl/⌘-click a measure or click its bar number to select a bar. Esc clears the selection.</InfoTip>
    </div>}
    <div className="control-section">
      <Label tip="R assigns the right hand (upper staff); L assigns the left hand (lower staff).">Hand</Label>
      <Segmented label="Hand assignment" value={staff} disabled={disabled}
        options={[{ value: 1, label: 'Right hand' }, { value: 2, label: 'Left hand' }]}
        onChange={value => apply({ op: 'set_staff', ids: selected, staff: value as 1 | 2 }, value === 1 ? 'Move to right hand' : 'Move to left hand')} />
      <Label tip="Voices are numbered within each staff. v1: top, stems up. v2: bottom, stems down. v3: upper-middle, stems up. v4: lower-middle, stems down. Press 1–4 to assign.">Voice</Label>
      <Segmented label="Voice" value={voice} disabled={disabled} options={[1, 2, 3, 4].map(value => ({ value, label: `v${value}` }))}
        onChange={value => apply({ op: 'set_voice', ids: selected, voice: value }, `Assign voice ${value}`)} />
      <div className="duration-label"><Label tip="Sets written length without changing the original recording. Dotted adds half the base duration.">Duration</Label>
        <label className="dotted-toggle"><input type="checkbox" aria-label="Dotted duration" checked={dotted} disabled={disabled}
          onChange={event => {
            const next = event.target.checked;
            setDotted(next);
            if (first) apply({ op: 'set_duration', ids: selected, dur: first.dur * (next ? 1.5 : 2 / 3) }, 'Toggle dotted duration');
          }} />Dotted</label>
      </div>
      <div className="duration-options" role="group" aria-label="Written duration">
        {durations.map(duration => <button className="chip" key={duration.value} disabled={disabled}
          aria-pressed={!!first && Math.abs(first.dur - duration.value * (dotted ? 1.5 : 1)) < 0.001}
          onClick={() => apply({ op: 'set_duration', ids: selected, dur: duration.value * (dotted ? 1.5 : 1) }, 'Change written duration')}>{duration.label}</button>)}
      </div>
      <Label tip="Choose sharp or flat enharmonic spelling, or let the engraver decide automatically.">Spelling</Label>
      <Segmented label="Enharmonic spelling" value={spelling} disabled={disabled}
        options={[{ value: 'auto', label: 'Auto' }, { value: 'sharp', label: '♯ Sharp' }, { value: 'flat', label: '♭ Flat' }]}
        onChange={prefer => {
          setSpelling(prefer);
          apply({ op: 'respell', ids: selected, prefer }, 'Respell notes');
        }} />
      <Label tip="Move by a semitone (±1) or an octave (±12). Use ↑ / ↓ for semitones, Shift ↑ / ↓ for octaves.">Transpose</Label>
      <div className="transpose-options">{[-12, -1, 1, 12].map(semitones => <button className="button ghost small" key={semitones} disabled={disabled}
        onClick={() => apply({ op: 'transpose', ids: selected, semitones }, `Transpose ${semitones > 0 ? '+' : ''}${semitones}`)}>{semitones > 0 ? '+' : '−'}{Math.abs(semitones)}</button>)}</div>
    </div>
    <div className="control-section note-actions">
      <div className="setting-row"><Label tip="Write the selected notes as grace notes. Toggle off to restore regular notation.">Grace note</Label>
        <Switch label="Grace note" checked={first?.grace ?? false} disabled={disabled}
          onChange={grace => apply({ op: 'set_grace', ids: selected, grace }, 'Change grace notes')} />
      </div>
      <div className="setting-row"><Label tip="Align selected notes to their earliest onset and longest duration.">Chord</Label>
        <button className="button ghost small" disabled={disabled || notes.length < 2}
          onClick={() => apply({ op: 'merge_chord', ids: selected }, 'Merge into chord')}>Merge</button>
      </div>
      <div className="two-actions">
        <button className="button ghost small danger" disabled={disabled} onClick={() => apply({ op: 'delete', ids: selected }, 'Delete notes')}><Trash2 size={14} />Delete</button>
        <button className="button ghost small" disabled={disabled} onClick={() => apply({ op: 'restore', ids: selected }, 'Restore notes')}>Restore</button>
      </div>
      <div className="reset-row"><button className="text-button" disabled={disabled} onClick={() => apply({ op: 'reset', ids: selected }, 'Reset overrides')}><RotateCcw size={13} />Reset overrides</button>
        <InfoTip label="reset overrides">Remove user overrides on the selected notes and return to the automatic transcription. Deleted notes stay selected so Restore can bring them back. Delete or Backspace removes selected notes.</InfoTip>
      </div>
    </div>
  </div>;
}
