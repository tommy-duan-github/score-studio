import { t } from '../lib/i18n';
import type { ScoreDoc, Settings } from '../lib/types';
import { InfoTip, Label, Segmented, Switch } from './Controls';

const toggles = [
  { key: 'auto_keys', label: 'Automatic keys', tip: 'Detect key signatures and key changes automatically.' },
  { key: 'auto_spelling', label: 'Automatic spelling', tip: 'Choose note spellings from the musical context.' },
  { key: 'auto_runs', label: 'Simplify fast runs', tip: 'Simplify fast ornamental runs for more readable notation.' },
  { key: 'show_pedal', label: 'Pedal markings', tip: 'Show detected sustain pedal markings in the score.' },
  { key: 'show_dynamics', label: 'Dynamics', tip: 'Show dynamics derived from performance velocities.' },
  { key: 'show_tempo', label: 'Tempo markings', tip: 'Show tempo markings in the score.' },
] as const;

export function SettingsPanel({ doc, busy, onChange }: { doc: ScoreDoc; busy: boolean; onChange: (settings: Partial<Settings>) => void }) {
  return <div className="settings-panel">
    <div className="panel-heading"><h2>{t("Engraving")}</h2><InfoTip label={t("engraving settings")}>{t("Settings apply to this project. Every change re-engraves the score and can be undone.")}</InfoTip></div>
    <Label tip={t("Limit each staff to 1–4 simultaneous voices (default: 3). Fewer voices simplify the notation; more preserve independent musical lines.")}>{t("Maximum voices")}</Label>
    <Segmented label={t("Maximum voices per staff")} value={doc.settings.max_voices ?? 3} disabled={busy}
      options={[1, 2, 3, 4].map(value => ({ value, label: value }))} onChange={max_voices => onChange({ max_voices })} />
    <div className="settings-group">{toggles.slice(0, 3).map(setting => <div className="setting-row" key={setting.key}>
      <Label tip={setting.tip}>{t(setting.label)}</Label>
      <Switch label={setting.label} checked={doc.settings[setting.key]} disabled={busy} onChange={value => onChange({ [setting.key]: value })} />
    </div>)}</div>
    <div className="hand-span"><Label tip={t("Maximum comfortable hand span in semitones. Guides automatic hand assignment.")}>{t("Hand span")}</Label>
      <span>{t("{0} semitones", [doc.settings.hand_span])}</span>
      <input aria-label={t("Hand span")} type="range" min="7" max="24" disabled={busy}
        defaultValue={doc.settings.hand_span} key={doc.settings.hand_span}
        onPointerUp={event => {
          if (Number(event.currentTarget.value) !== doc.settings.hand_span) onChange({ hand_span: Number(event.currentTarget.value) });
        }}
        onKeyUp={event => {
          if (Number(event.currentTarget.value) !== doc.settings.hand_span) onChange({ hand_span: Number(event.currentTarget.value) });
        }} />
    </div>
    <div className="settings-group visibility-group"><h3>{t("Notation")}</h3>{toggles.slice(3).map(setting => <div className="setting-row" key={setting.key}>
      <Label tip={setting.tip}>{setting.label}</Label>
      <Switch label={setting.label} checked={doc.settings[setting.key]} disabled={busy} onChange={value => onChange({ [setting.key]: value })} />
    </div>)}</div>
  </div>;
}
