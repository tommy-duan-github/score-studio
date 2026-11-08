import { t } from '../lib/i18n';
import type { Model } from '../lib/types';

export function formatBytes(bytes: number | null) {
  if (bytes === null) return t('Unknown size');
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${(bytes / 1024 ** unit).toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
export const modelRunning = (model: Model) => model.state === 'downloading' || model.state === 'queued';

type Tone = 'ok' | 'idle' | 'busy' | 'error' | 'builtin';

/** A dot and a word for the model state; a thin bar while downloading, and the error below. */
export function ModelStatus({ model, showError = true }: { model: Model; showError?: boolean }) {
  const running = modelRunning(model);
  const [tone, label]: [Tone, string] = !model.managed ? ['builtin', t('Built in')] : running
    ? ['busy', model.state === 'queued' ? t('Queued') : t('Downloading {0}%', [Math.round((model.progress ?? 0) * 100)])]
    : model.state === 'error' ? ['error', t('Error')] : model.installed ? ['ok', t('Installed')] : ['idle', t('Not downloaded')];
  return <div className={`model-state tone-${tone}`}>
    <span className="model-state-label"><i aria-hidden="true" />{label}</span>
    {running && <progress max="1" value={model.progress ?? 0} aria-label={t('{0} progress', [model.name])} />}
    {showError && model.error && <small className="danger" role="alert">{t(model.error)}</small>}
  </div>;
}
