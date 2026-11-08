import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ModelsStatus } from '../lib/types';

/** One owner for downloads, including those continuing after the setup dialog closes. */
export function useModels(onReady: (ready: boolean) => void, refreshHealth: () => Promise<void>) {
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requestId = useRef(0);
  const accept = useCallback((next: ModelsStatus) => {
    setStatus(next);
    setError('');
    onReady(next.ready);
  }, [onReady]);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const id = ++requestId.current;
    try {
      const next = await api.models();
      if (id === requestId.current) accept(next);
    } catch (failure) {
      if (id === requestId.current) {
        setError((failure as Error).message);
        setStatus(current => current?.downloading ? { ...current } : current);
      }
    }
  }, [accept]);
  useEffect(() => {
    if (!status?.downloading || busy) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const id = ++requestId.current;
      try {
        const next = await api.models();
        if (!live || id !== requestId.current) return;
        accept(next);
        if (!next.downloading) void refreshHealth().catch(failure => setError(failure.message));
      } catch (failure) {
        if (live && id === requestId.current) {
          setError((failure as Error).message);
          // Keep polling after a transient network failure.
          setStatus(current => current ? { ...current } : current);
        }
      }
    }, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [status, busy, accept, refreshHealth]);
  const action = async (run: () => Promise<ModelsStatus>) => {
    if (pending.current) return false;
    pending.current = true;
    ++requestId.current; // A late GET must not replace a newer download/remove response.
    setBusy(true);
    setError('');
    try {
      accept(await run());
      await refreshHealth();
      return true;
    } catch (failure) { setError((failure as Error).message); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  return { status, error, busy, refresh,
    download: (keys: string[]) => action(() => api.downloadModels(keys)),
    remove: (key: string) => action(() => api.removeModel(key)),
  };
}
export type ModelManager = ReturnType<typeof useModels>;
