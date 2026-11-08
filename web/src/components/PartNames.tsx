import { t } from '../lib/i18n';
import type { Part, PartOverrides } from '../lib/types';
import { InlineName } from './InlineName';

export function PartNames({ parts, onChange, busy }: { parts?: Part[]; onChange?: (patch: PartOverrides) => unknown; busy?: boolean }) {
  const entries = parts?.length ? parts : [{ id: 'P1', name: 'Piano' }];
  return <span className="part-names">{entries.map(part => <span key={part.id} data-part-id={part.id}>{onChange
    ? <InlineName key={part.id} value={part.name} label={t("Part name: {0}", [part.name])} className="part-chip" disabled={busy}
      onSave={name => void onChange({ [part.id]: { name } })} />
    : <span>{part.name}</span>}</span>)}</span>;
}
