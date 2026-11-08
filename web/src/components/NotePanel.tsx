import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { Music2, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { Instrument, Op, PartOverrides, ScoreDoc } from '../lib/types';
import { InfoTip, Label, Segmented, Switch } from './Controls';

export type Edit = (ops: Op[], label?: string) => Promise<boolean>;
const durations = [{ value: 4, label: '1' }, { value: 2, label: '1/2' }, { value: 1, label: '1/4' },
{ value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 0.125, label: '1/32' }];

export function NotePanel({ doc, selected, busy, edit, onParts, onError }: { doc: ScoreDoc; selected: number[]; busy: boolean; edit: Edit; onParts: (patch: PartOverrides) => unknown; onError: (message: string) => void }) {
  const [catalog, setCatalog] = useState<Instrument[]>([]);
  useEffect(() => {
    let live = true;
    api.instruments().then(items => { if (live) setCatalog(items); }).catch(error => { if (live) onError(error.message); });
    return () => { live = false; };
  }, [onError]);
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
  // Multi-instrument scores: hands apply to keyboard (grand-staff) parts only; staves are global numbers.
  const multi = (doc.parts?.length ?? 0) > 1 || (doc.parts?.[0] && doc.parts[0].kind !== 'grand');
  const partOf = (id?: string) => doc.parts?.find(part => part.id === id);
  const part = !!notes.length && notes.every(note => (note.part ?? doc.parts?.find(p => p.staves.includes(note.staff))?.id) === (first?.part ?? doc.parts?.find(p => p.staves.includes(first?.staff))?.id)) ? partOf(first?.part ?? doc.parts?.find(p => p.staves.includes(first?.staff))?.id) : undefined;
  const handPart = part?.kind === 'grand' ? part : undefined;
  const hands = !multi || !!handPart;
  const [upper, lower] = handPart?.staves ?? [1, 2];
  const hand = staff === upper ? 'Right' : staff === lower ? 'Left' : undefined;

  return <div className="note-panel">
    <div className="panel-heading"><h2>{t("Notes")}</h2><span className="count chip">{t("{0} selected", [selected.length])}</span></div>
    {first ? <div className="note-summary">
      <div className="note-name">{notes.length === 1 ? first.name : t("{0} notes", [notes.length])}
        <span>{notes.length === 1 ? t("MIDI {0}", [first.pitch]) : `${Math.min(...notes.map(note => note.pitch))}–${Math.max(...notes.map(note => note.pitch))}`}</span>
      </div>
      <dl className="note-details">
        <dt>{t("Position")}</dt><dd>{t("Bar {0} · Beat {1}", [doc.measures[first.measure]?.number, +(first.beat + 1).toFixed(3)])}</dd>
        <dt>{t("Instrument")}</dt><dd>{part?.name ?? t("Mixed")}</dd>
        <dt>{hands ? t("Hand / voice") : t("Voice")}</dt><dd>{hands ? `${t(hand ?? 'Mixed')} / ` : ''}{voice ?? t("Mixed")}</dd>
        <dt>{t("Duration")}</dt><dd>{t("{0} quarters", [+first.dur.toFixed(3)])}</dd>
        <dt>{t("Velocity")}</dt><dd>{first.velocity}</dd>
        <dt>{t("Performance")}</dt><dd>{first.perf_on.toFixed(2)}–{first.perf_off.toFixed(2)}{t("s")}</dd>
        <dt>{t("Overrides")}</dt><dd>{first.edited.map(field => t(field)).join(', ') || t("None")}</dd>
        {first.deleted && <><dt>{t("Status")}</dt><dd className="danger">{t("Deleted")}</dd></>}
      </dl>
    </div> : <div className="selection-empty"><Music2 size={26} /><span>{t("Select notes")}</span>
      <InfoTip label={t("note selection")}>{t("Click a note, Shift-click to add notes, or drag to select a passage. Ctrl/⌘-click or click a bar number selects a measure; Esc clears selection.")}</InfoTip>
    </div>}
    <div className="control-section">
      <Label tip={t("Change the instrument for this part, including its name, MIDI sound and clef. Grand-staff parts keep both staves.")}>{t("Instrument type")}</Label>
      <select className="glass-select" aria-label={t("Instrument type")} disabled={disabled || !part || !catalog.length} value="" onChange={event => {
        const instrument = catalog[Number(event.target.value)];
        if (part && instrument) void onParts({ [part.id]: { name: instrument.name, program: instrument.program, ...(part.kind === 'single' ? { clef: instrument.clef } : {}) } });
      }}>
        <option value="" disabled>{part?.name ?? (notes.length ? t("Mixed") : "—")}</option>
        {catalog.map((instrument, index) => instrument.kind === part?.kind && <option key={index} value={index}>{t(instrument.name)}</option>)}
      </select>
      {hands && <>
        <Label tip={t("R assigns the right hand (upper staff); L assigns the left hand (lower staff).")}>{t("Hand")}</Label>
        <Segmented label={t("Hand assignment")} value={staff === upper ? 1 : staff === lower ? 2 : undefined} disabled={disabled}
          options={[{ value: 1, label: 'Right hand' }, { value: 2, label: 'Left hand' }]}
          onChange={value => apply({ op: 'set_staff', ids: selected, staff: value === 1 ? upper : lower }, value === 1 ? 'Move to right hand' : 'Move to left hand')} />
      </>}
      <Label tip={t("Press 1–4 to assign a voice within the staff. Voices 1 and 3 have stems up; 2 and 4 have stems down, with 3 and 4 used for inner lines.")}>{t("Voice")}</Label>
      <Segmented label={t("Voice")} value={voice} disabled={disabled} options={[1, 2, 3, 4].map(value => ({ value, label: `v${value}` }))}
        onChange={value => apply({ op: 'set_voice', ids: selected, voice: value }, `Assign voice ${value}`)} />
      <div className="duration-label"><Label tip={t("Sets written length without changing the original recording. Dotted adds half the base duration.")}>{t("Duration")}</Label>
        <label className="dotted-toggle"><input type="checkbox" aria-label={t("Dotted duration")} checked={dotted} disabled={disabled}
          onChange={event => {
            const next = event.target.checked;
            setDotted(next);
            if (first) apply({ op: 'set_duration', ids: selected, dur: first.dur * (next ? 1.5 : 2 / 3) }, 'Toggle dotted duration');
          }} />{t("Dotted")}</label>
      </div>
      <div className="duration-options" role="group" aria-label={t("Written duration")}>
        {durations.map(duration => <button className="chip" key={duration.value} disabled={disabled}
          aria-pressed={!!first && Math.abs(first.dur - duration.value * (dotted ? 1.5 : 1)) < 0.001}
          onClick={() => apply({ op: 'set_duration', ids: selected, dur: duration.value * (dotted ? 1.5 : 1) }, 'Change written duration')}>{duration.label}</button>)}
      </div>
      <Label tip={t("Choose sharp or flat enharmonic spelling, or let the engraver decide automatically.")}>{t("Spelling")}</Label>
      <Segmented label={t("Enharmonic spelling")} value={spelling} disabled={disabled}
        options={[{ value: 'auto', label: 'Auto' }, { value: 'sharp', label: '♯ Sharp' }, { value: 'flat', label: '♭ Flat' }]}
        onChange={prefer => {
          setSpelling(prefer);
          apply({ op: 'respell', ids: selected, prefer }, 'Respell notes');
        }} />
      <Label tip={t("Move by a semitone (±1) or an octave (±12). Use ↑ / ↓ for semitones, Shift ↑ / ↓ for octaves.")}>{t("Transpose")}</Label>
      <div className="transpose-options">{[-12, -1, 1, 12].map(semitones => <button className="button ghost small" key={semitones} disabled={disabled}
        onClick={() => apply({ op: 'transpose', ids: selected, semitones }, `Transpose ${semitones > 0 ? '+' : ''}${semitones}`)}>{semitones > 0 ? '+' : '−'}{Math.abs(semitones)}</button>)}</div>
    </div>
    <div className="control-section note-actions">
      <div className="setting-row"><Label tip={t("Write the selected notes as grace notes. Toggle off to restore regular notation.")}>{t("Grace note")}</Label>
        <Switch label={t("Grace note")} checked={first?.grace ?? false} disabled={disabled}
          onChange={grace => apply({ op: 'set_grace', ids: selected, grace }, 'Change grace notes')} />
      </div>
      <div className="setting-row"><Label tip={t("Align selected notes to their earliest onset and longest duration.")}>{t("Chord")}</Label>
        <button className="button ghost small" disabled={disabled || notes.length < 2}
          onClick={() => apply({ op: 'merge_chord', ids: selected }, 'Merge into chord')}>{t("Merge")}</button>
      </div>
      <div className="two-actions">
        <button className="button ghost small danger" disabled={disabled} onClick={() => apply({ op: 'delete', ids: selected }, 'Delete notes')}><Trash2 size={14} />{t("Delete")}</button>
        <button className="button ghost small" disabled={disabled} onClick={() => apply({ op: 'restore', ids: selected }, 'Restore notes')}>{t("Restore")}</button>
      </div>
      <div className="reset-row"><button className="text-button" disabled={disabled} onClick={() => apply({ op: 'reset', ids: selected }, 'Reset overrides')}><RotateCcw size={13} />{t("Reset overrides")}</button>
        <InfoTip label={t("reset overrides")}>{t("Reset returns selected notes to the automatic transcription. Delete/Backspace removes notes; Restore brings deleted notes back.")}</InfoTip>
      </div>
    </div>
  </div>;
}
