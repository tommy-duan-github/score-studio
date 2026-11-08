import { t } from '../lib/i18n';
import { useState } from 'react';
import { X } from 'lucide-react';
import type { LlmConfig, PartOverrides, ScoreDoc, Settings } from '../lib/types';
import { Segmented } from './Controls';
import { NotePanel, type Edit } from './NotePanel';
import { ReviewPanel } from './ReviewPanel';
import { SettingsPanel } from './SettingsPanel';
import { AssistantPanel } from './AssistantPanel';

type Tab = 'Note' | 'Review' | 'Assistant' | 'Engraving';

interface Props {
  doc: ScoreDoc;
  selected: number[];
  edit: Edit;
  busy: boolean;
  onParts: (patch: PartOverrides) => unknown;
  onError: (message: string) => void;
  changeSettings: (settings: Partial<Settings>) => void;
  config: LlmConfig | null;
  onConfig: (config: LlmConfig) => void;
  onPreview: (ids: number[]) => void;
  /** Closes the inspector drawer (tablet / phone layouts). */
  onClose?: () => void;
}

export function Inspector(props: Props) {
  const [tab, setTab] = useState<Tab>('Note');
  const count = props.doc.review.filter(item => item.resolved === null).length;
  return <aside className="inspector glass" aria-label={t("Inspector")} id="inspector">
    <div className="drawer-head inspector-head"><span>{t("Edit")}</span>
      <button type="button" className="icon-button drawer-close" aria-label={t("Close editor panel")} onClick={props.onClose}><X size={17} /></button>
    </div>
    <Segmented label={t("Inspector tabs")} tabs value={tab} onChange={setTab} className="inspector-tabs"
      options={(['Note', 'Review', 'Assistant', 'Engraving'] as const).map(value => ({
        value, label: <>{t(value)}{value === 'Review' && <span className="tab-count">{count}</span>}</>,
      }))} />
    <div className="inspector-body" role="tabpanel" aria-label={t(tab)}>
      <div hidden={tab !== 'Note'}><NotePanel doc={props.doc} selected={props.selected} edit={props.edit} busy={props.busy} onParts={props.onParts} onError={props.onError} /></div>
      <div hidden={tab !== 'Review'}><ReviewPanel doc={props.doc} edit={props.edit} busy={props.busy} /></div>
      <div hidden={tab !== 'Assistant'}><AssistantPanel {...props} /></div>
      <div hidden={tab !== 'Engraving'}><SettingsPanel doc={props.doc} busy={props.busy} onChange={props.changeSettings} /></div>
    </div>
  </aside>;
}
