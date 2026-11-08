import { t } from '../lib/i18n';
import { useEffect, useRef } from 'react';
import { Guitar, Piano, X } from 'lucide-react';
import type { Health, Instruments } from '../lib/types';
import { InfoTip } from './Controls';
import { modelDescription } from '../lib/modelInfo';

export type Mode = { instruments: Instruments; model?: string };

/** Piano (left) or multiple instruments (right, beta): shown after files are chosen, and for "Transcribe again". */
export function ModeChooser({ open, title, files, current, model, multi, busy, audio, onModel, onChoose, onCancel }: {
  open: boolean;
  title: string;
  /** File names being uploaded (a summary is shown); empty for "Transcribe again". */
  files: string[];
  /** Highlights the project's current mode ("Transcribe again"). */
  current?: Instruments;
  model?: string;
  multi: NonNullable<Health['multi']>;
  busy: boolean;
  /** Whether the YourMT3+ checkpoint applies (audio input). */
  audio: boolean;
  onModel: (model: string) => void;
  onChoose: (mode: Mode) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return <dialog ref={dialog} className="dialog glass mode-chooser" aria-labelledby="mode-chooser-title"
    onCancel={event => {
      event.preventDefault();
      if (!busy) onCancel();
    }}
    onClick={event => {
      if (event.target === dialog.current && !busy) onCancel();
    }}>
    {open && <>
      <div className="dialog-heading">
        <h2 id="mode-chooser-title">{title}</h2>
        <InfoTip label={t("transcription mode")}>{t("Piano uses Transkun for a grand staff; Multiple instruments uses YourMT3+ for separate parts, excluding drums and merging sparse detections; MIDI tracks stay separate.")}{current ? t(" Changing the mode or model clears the editing history.") : ''}</InfoTip>
        <button type="button" className="icon-button" aria-label={t("Close")} disabled={busy} onClick={onCancel}><X size={17} /></button>
      </div>
      {files.length > 0 && <p className="mode-files" title={files.join('\n')}>{files.length === 1 ? files[0] : t("{0} files", [files.length])}</p>}
      <div className="mode-options">
        <button type="button" className={`mode-option ${current === 'piano' ? 'current' : ''}`} disabled={busy}
          onClick={() => onChoose({ instruments: 'piano' })}>
          <span className="mode-icon"><Piano size={26} /></span>
          <strong>{t("Piano")}</strong>
          {current === 'piano' && <span className="chip">{t("Current")}</span>}
        </button>
        <button type="button" className={`mode-option ${current === 'multi' ? 'current' : ''}`} disabled={busy}
          onClick={() => onChoose({ instruments: 'multi', model })}>
          <span className="mode-icon"><Guitar size={26} /></span>
          <strong>{t("Multiple instruments")}</strong>
          <span className="chip beta">{t("Beta")}</span>
          {current === 'multi' && <span className="chip">{t("Current")}</span>}
        </button>
      </div>
      {audio && <label className="field mode-model">
        <span>{t("Multiple instruments model")}</span>
        <select aria-label={t("YourMT3+ model")} value={model} disabled={busy} onChange={event => onModel(event.target.value)}>
          {multi.models.map(m => <option key={m.key} value={m.key}>{m.label}{m.key === multi.default ? t(" (default)") : ''}</option>)}
        </select>
        {model && <small className="mode-model-desc">{modelDescription({ key: model, purpose: '' })}</small>}
      </label>}
    </>}
  </dialog>;
}
