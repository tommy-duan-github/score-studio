import { useEffect, useRef } from 'react';
import { t } from '../lib/i18n';

export function ConfirmAction({ title, message, busy, error, onCancel, onConfirm }: {
  title: string; message: string; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog glass confirm-action" aria-labelledby="storage-confirm-title"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="storage-confirm-title">{title}</h2>
    <p>{message}</p>
    {error && <p className="danger" role="alert">{t(error)}</p>}
    <div className="dialog-actions">
      <button type="button" className="button ghost small" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      <button type="button" className="button primary small" disabled={busy} onClick={onConfirm}>{t('Confirm')}</button>
    </div>
  </dialog>;
}
