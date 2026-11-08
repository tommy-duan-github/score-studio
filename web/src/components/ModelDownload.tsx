import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Guitar, ListMusic, Piano, Zap } from 'lucide-react';
import { modelDescription, modelGroup } from '../lib/modelInfo';
import type { ModelManager } from '../hooks/useModels';
import { t } from '../lib/i18n';
import { InfoTip } from './Controls';
import { formatBytes, ModelStatus, modelRunning } from './ModelStatus';

export function ModelDownload({ models, onClose }: { models: ModelManager; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [started, setStarted] = useState(false);
  const { status, refresh } = models;
  useEffect(() => {
    dialog.current?.showModal();
    (document.activeElement as HTMLElement | null)?.blur();
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!status || keys !== null) return;
    const missing = status.models.filter(model => !model.installed && (model.required || model.recommended));
    setKeys(missing.map(model => model.key));
    setSelected(missing.map(model => model.key));
  }, [status, keys]);
  const entries = status?.models.filter(model => keys?.includes(model.key)) ?? [];
  const chosen = entries.filter(model => selected.includes(model.key));
  const resuming = chosen.some(modelRunning);
  useEffect(() => { if (resuming) setStarted(true); }, [resuming]);
  const success = started && !models.busy && !!chosen.length && chosen.every(model => model.installed);
  const active = models.busy || !!status?.downloading;
  const total = chosen.reduce((sum, model) => sum + (model.download_bytes ?? 0), 0);
  const unknown = chosen.some(model => model.download_bytes === null);
  const weight = chosen.reduce((sum, model) => sum + (model.download_bytes || 1), 0);
  const progress = weight ? chosen.reduce((sum, model) => sum + (model.download_bytes || 1) * (model.installed ? 1 : model.progress ?? 0), 0) / weight : 0;
  const failed = !!models.error || chosen.some(model => model.state === 'error');
  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(onClose, 1200);
    return () => clearTimeout(timer);
  }, [success, onClose]);
  async function download() {
    if (!status || keys === null) { await refresh(); return; }
    if (status.downloading) { await refresh(); return; }
    setStarted(true);
    await models.download(chosen.filter(model => !model.installed).map(model => model.key));
  }
  return <dialog ref={dialog} className="dialog glass model-download" aria-labelledby="model-download-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><Download size={18} /><h2 id="model-download-title">{t('Download models')}</h2>
      <InfoTip label={t('model downloads')}>{t('Required models are needed for transcription. Recommended models enable multiple instruments. Downloads continue if you choose Later.')}</InfoTip>
    </div>
    {success ? <div className="models-success" role="status"><CheckCircle2 size={28} /><strong>{t('Models ready')}</strong></div> : <>
      {!status && !models.error && <span>{t('Loading…')}</span>}
      <div className="setup-models storage-list">{entries.map(model => {
        const group = modelGroup(model);
        const Icon = model.key === 'duet' ? ListMusic : model.key === 'cuda' ? Zap : group === 'multi' ? Guitar : Piano;
        return <div className="setup-model" key={model.key} data-model-key={model.key}>
          <label><input type="checkbox" checked={selected.includes(model.key)} disabled={model.required || active || started}
            onChange={event => setSelected(current => event.target.checked ? [...current, model.key] : current.filter(key => key !== model.key))} />
            <span className={`storage-icon group-${group}`}><Icon size={16} /></span>
            <span className="model-copy">
              <span className="model-title"><strong>{model.name}</strong><span className={`tag ${model.required ? '' : 'accent'}`}>{model.required ? t('Required') : t('Recommended')}</span></span>
              <span className="model-desc">{modelDescription(model)}</span>
            </span>
            <small className="model-size">{formatBytes(model.download_bytes)}</small>
          </label>
          {started && selected.includes(model.key) && <ModelStatus model={model} />}
        </div>;
      })}</div>
      <div className="setup-total"><strong>{t('Total')}</strong><span>{unknown ? t('{0} + unknown size', [formatBytes(total)]) : formatBytes(total)}</span></div>
      {started && <div className="setup-progress"><span>{t('Overall progress')} <strong>{Math.round(progress * 100)}%</strong></span>
        <progress aria-label={t('Overall progress')} max="1" value={progress} /></div>}
      {models.error && <p className="danger" role="alert">{t(models.error)}</p>}
      <div className="dialog-actions">
        <button type="button" className="button ghost small" onClick={onClose}>{t('Later')}</button>
        <button type="button" className="button primary small" disabled={models.busy || (active && !failed) || (!!status && !selected.length)} onClick={() => void download()}>{failed || (!status && models.error) ? t('Retry') : t('Download')}</button>
      </div>
    </>}
  </dialog>;
}
