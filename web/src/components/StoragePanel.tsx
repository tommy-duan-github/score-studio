import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileAudio2, FileMusic, Folder, Guitar, ListMusic, Piano, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { modelDescription, modelGroup, modelShortName, type ModelGroup } from '../lib/modelInfo';
import type { Model, StorageUsage } from '../lib/types';
import type { ModelManager } from '../hooks/useModels';
import { InfoTip } from './Controls';
import { ConfirmAction } from './ConfirmAction';
import { formatBytes, ModelStatus, modelRunning } from './ModelStatus';

const GROUPS: { key: ModelGroup; label: () => string; beta?: boolean }[] = [
  { key: 'core', label: () => t('Core') },
  { key: 'multi', label: () => `YourMT3+ · ${t('Multiple instruments')}`, beta: true },
  { key: 'gpu', label: () => t('Acceleration') },
];
const modelIcon = (model: Model) => model.key === 'duet' ? ListMusic : model.key === 'transkun' ? Piano : model.key === 'cuda' ? Zap : Guitar;

/** One stacked bar: this app's projects, models and program files, the rest of the drive, and free space. */
function UsageBar({ usage }: { usage: StorageUsage }) {
  const total = Math.max(1, usage.disk_total);
  const used = Math.max(0, usage.disk_total - usage.disk_free);
  const known = usage.projects.bytes + usage.models.bytes + (usage.app.bytes ?? 0);
  const parts = [
    { key: 'projects', label: t('Projects'), bytes: usage.projects.bytes, shown: usage.projects.bytes },
    { key: 'models', label: t('Models'), bytes: usage.models.bytes, shown: usage.models.bytes },
    { key: 'app', label: t('App'), bytes: usage.app.bytes ?? 0, shown: usage.app.bytes },
    // While the app size is still being measured it is counted in "Other", whose value then waits too.
    { key: 'other', label: t('Other'), bytes: Math.max(0, used - known), shown: usage.app.bytes === null ? null : Math.max(0, used - known) },
  ];
  const legend = [...parts, { key: 'free', label: t('Free'), bytes: usage.disk_free, shown: usage.disk_free }];
  return <>
    <div className="usage-bar" role="group" aria-label={t('Disk usage')}>
      {parts.map(part => <span key={part.key} className={`usage-seg usage-${part.key} ${part.bytes > 0 ? '' : 'empty'}`}
        style={{ flexBasis: `${part.bytes / total * 100}%` }} title={`${part.label} · ${formatBytes(part.shown)}`}
        role="meter" aria-label={t('{0} disk usage', [part.label])} aria-valuemin={0} aria-valuemax={usage.disk_total} aria-valuenow={part.bytes} />)}
      <span className="usage-seg usage-free" title={`${t('Free')} · ${formatBytes(usage.disk_free)}`} />
    </div>
    <ul className="usage-legend">{legend.map(item => <li key={item.key}>
      <span><i className={`storage-dot usage-${item.key}`} />{item.label}</span>
      <strong>{item.shown === null ? t('Calculating…') : formatBytes(item.shown)}</strong>
    </li>)}</ul>
  </>;
}

export function StoragePanel({ models, onDelete }: {
  models: ModelManager; onDelete: (body: { ids: string[] } | { all: true }) => Promise<void>;
}) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ model: Model } | { ids: string[]; all: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const selectAll = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await api.storage();
      if (id === requestId.current) { setUsage(next); setError(''); }
    } catch (failure) { if (id === requestId.current) setError((failure as Error).message); }
  }, []);
  const { refresh: refreshModels } = models;
  useEffect(() => { void refreshModels(); }, [refreshModels]);
  useEffect(() => { void refresh(); }, [refresh, models.status]);
  // App size can be computed asynchronously by the server.
  useEffect(() => {
    if (!usage || usage.app.bytes !== null) return;
    const timer = window.setTimeout(() => void refresh(), 1000);
    return () => clearTimeout(timer);
  }, [usage, refresh]);
  const items = usage?.projects.items ?? [];
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && selected.length < items.length;
  }, [selected, items.length]);
  const missing = models.status?.models.filter(model => model.managed && !model.installed) ?? [];
  const ask = (action: NonNullable<typeof confirm>) => { setActionError(''); setConfirm(action); };
  async function perform() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      if ('model' in confirm) {
        if (!await models.remove(confirm.model.key)) return;
      } else {
        await onDelete(confirm.all ? { all: true } : { ids: confirm.ids });
        setSelected([]);
      }
      setConfirm(null);
      await refresh();
    } catch (failure) { setActionError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const groups = GROUPS.map(group => ({ ...group, models: models.status?.models.filter(model => modelGroup(model) === group.key) ?? [] }))
    .filter(group => group.models.length);
  return <div className="storage-panel">
    {error && <div role="alert" className="storage-error"><span>{t(error)}</span><button className="button ghost small" onClick={() => void refresh()}>{t('Retry')}</button></div>}
    <section aria-label={t('Usage')}>
      <div className="storage-section-head"><h4>{t('Usage')}</h4>
        {usage && <span className="storage-free">{t('{0} free of {1}', [formatBytes(usage.disk_free), formatBytes(usage.disk_total)])}</span>}
      </div>
      {!usage ? !error && <span className="storage-loading">{t('Loading…')}</span> : <>
        <UsageBar usage={usage} />
        <div className="storage-path" title={usage.data_dir}><Folder size={12} /><span>{usage.data_dir}</span></div>
      </>}
    </section>
    <section aria-label={t('Models')}>
      <div className="storage-section-head"><h4>{t('Models')}</h4>
        {!!missing.length && <button className="button ghost small" disabled={models.busy || models.status?.downloading} onClick={() => void models.download(missing.map(model => model.key))}><Download size={13} />{t('Download all missing')}</button>}
      </div>
      {models.error && <div role="alert" className="storage-error"><span>{t(models.error)}</span><button className="button ghost small" onClick={() => void refreshModels()}>{t('Retry')}</button></div>}
      {!models.status && !models.error && <span className="storage-loading">{t('Loading…')}</span>}
      {groups.map(group => <div className="model-group" key={group.key} aria-label={group.label()} role="group">
        <div className="storage-eyebrow"><span>{group.label()}</span>{group.beta && <span className="chip beta">{t('Beta')}</span>}</div>
        <div className="storage-list">{group.models.map(model => {
          const Icon = modelIcon(model);
          const size = formatBytes(model.installed ? model.bytes : model.download_bytes);
          return <div className="storage-model" key={model.key} data-model-key={model.key}>
            <span className={`storage-icon group-${group.key}`}><Icon size={16} /></span>
            <div className="model-copy">
              <div className="model-title"><strong>{modelShortName(model)}</strong>
                {model.required ? <span className="tag">{t('Required')}</span>
                  : model.recommended && <span className="tag accent">{group.key === 'multi' ? t('Default') : t('Recommended')}</span>}
              </div>
              <span className="model-desc">{modelDescription(model)}</span>
              {model.error && <span className="model-error" role="alert">{t(model.error)}</span>}
            </div>
            <div className="model-side">
              <ModelStatus model={model} showError={false} />
              {!(model.bytes === null && model.download_bytes === null) && <small className="model-size">{size}</small>}
            </div>
            <div className="model-action">{model.managed && !modelRunning(model) && (!model.installed
              ? <button className="button ghost small" disabled={models.busy} onClick={() => void models.download([model.key])}>{t('Download')}</button>
              : !model.required && <button className="button ghost small danger" disabled={models.busy || models.status?.downloading} onClick={() => ask({ model })}>{t('Remove')}</button>)}</div>
          </div>;
        })}</div>
      </div>)}
    </section>
    <section aria-label={t('Projects')}>
      <div className="storage-section-head"><h4>{t('Projects')} <span className="chip">{usage?.projects.count ?? 0}</span>
        <InfoTip label={t('project storage')}>{t('Deleting projects removes their source files, scores and editing history.')}</InfoTip></h4>
        {usage && <span className="storage-total">{formatBytes(usage.projects.bytes)}</span>}
      </div>
      <div className="storage-list">
        <label className="storage-select-all"><input ref={selectAll} type="checkbox" checked={!!items.length && selected.length === items.length} disabled={!items.length || busy}
          onChange={event => setSelected(event.target.checked ? items.map(item => item.id) : [])} /><span>{t('Select all')}</span></label>
        {items.map(item => {
          const Icon = item.source === 'audio' ? FileAudio2 : FileMusic;
          return <label key={item.id} className="storage-project">
            <input type="checkbox" aria-label={t('Select {0}', [item.title])} checked={selected.includes(item.id)} disabled={busy}
              onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
            <span className="storage-icon"><Icon size={15} /></span>
            <span className="row-copy"><strong>{item.title}</strong><small>{item.source === 'audio' ? t('Audio') : t('MIDI')} · <time dateTime={item.created}>{new Date(item.created).toLocaleDateString(document.documentElement.lang)}</time></small></span>
            <small className="model-size">{formatBytes(item.bytes)}</small>
          </label>;
        })}
        {!items.length && usage && <div className="storage-empty">{t('No projects')}</div>}
      </div>
      <div className="storage-project-actions">
        <button className="button ghost small danger" disabled={!selected.length || busy} onClick={() => ask({ ids: [...selected], all: false })}>{t('Delete selected')}</button>
        <button className="button ghost small danger" disabled={!items.length || busy} onClick={() => ask({ ids: items.map(item => item.id), all: true })}>{t('Clear all projects')}</button>
      </div>
    </section>
    {confirm && <ConfirmAction title={'model' in confirm ? t('Remove model?') : t(confirm.ids.length === 1 ? 'Delete {0} project?' : 'Delete {0} projects?', [confirm.ids.length])}
      message={'model' in confirm ? t('Remove {0}? You can download it again later.', [confirm.model.name]) : t(confirm.ids.length === 1 ? 'Delete {0} project and its editing history? This cannot be undone.' : 'Delete {0} projects and their editing history? This cannot be undone.', [confirm.ids.length])}
      error={actionError || models.error} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void perform()} />}
  </div>;
}
