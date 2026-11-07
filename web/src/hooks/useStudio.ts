import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { DEFAULT_HEADER } from '../lib/verovio';
import type { LlmConfig, Op, Project, ScoreDoc, ScoreHeader, Settings } from '../lib/types';

export function useStudio(onError: (message: string) => void) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [doc, setDoc] = useState<ScoreDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const activeRef = useRef(active);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  /** Title-block fields shown optimistically and not yet confirmed by the server. */
  const pendingHeader = useRef<{ id: string; patch: Partial<ScoreHeader> } | null>(null);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const list = await api.projects();
    setProjects(current => list.map(item => ({ ...current.find(p => p.id === item.id), ...item })));
    return list;
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.allSettled([api.projects(), api.health()]).then(([library, health]) => {
      if (!live) return;
      if (library.status === 'fulfilled') {
        setProjects(library.value);
        setActive(library.value[0]?.id ?? null);
      } else onError(library.reason.message);
      if (health.status === 'fulfilled') setConfig(health.value.llm);
      else onError(health.reason.message);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [onError]);

  const project = projects.find(item => item.id === active) ?? null;
  const ready = project?.status === 'ready';

  useEffect(() => {
    setDoc(null);
    if (!active) return;
    let live = true;
    void api.project(active).then(value => {
      if (live) setProjects(list => list.map(p => p.id === value.id ? { ...p, ...value } : p));
    }).catch(error => {
      if (live) onError(error.message);
    });
    return () => {
      live = false;
    };
  }, [active, onError]);

  useEffect(() => {
    if (!active || !ready) return;
    let live = true;
    void api.doc(active).then(value => {
      if (live) setDoc(value);
    })
      .catch(error => {
        if (live) onError(error.message);
      });
    return () => {
      live = false;
    };
  }, [active, ready, onError]);

  useEffect(() => {
    const processing = projects.filter(p => !['ready', 'error'].includes(p.status));
    if (!processing.length) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const results = await Promise.allSettled(processing.map(p => api.project(p.id)));
      if (!live) return;
      const updates = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      setProjects(list => list.map(p => ({ ...p, ...updates.find(update => update.id === p.id) })));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') onError(failure.reason.message);
    }, 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projects, onError]);

  const mutate = useCallback((id: string, action: () => Promise<ScoreDoc>): Promise<boolean> => {
    pending.current += 1;
    setBusy(true);
    const result = queue.current.then(async () => {
      try {
        const next = await action();
        // A queued edit's response predates a header change still being saved: keep the change on screen.
        const header = pendingHeader.current?.id === id ? pendingHeader.current.patch : null;
        if (activeRef.current === id) setDoc(header ? { ...next, header: { ...DEFAULT_HEADER, ...next.header, ...header } } : next);
        setProjects(list => list.map(p => p.id === id ? { ...p, title: next.title, version: next.version } : p));
        return true;
      } catch (error) {
        onError((error as Error).message);
        return false;
      } finally {
        pending.current -= 1;
        setBusy(pending.current > 0);
      }
    });
    queue.current = result;
    return result;
  }, [onError]);

  async function upload(files: File[]) {
    for (const file of files) {
      if (!/\.(mid|midi|mp3|wav|flac|m4a|ogg)$/i.test(file.name)) {
        onError(`Unsupported file: ${file.name}`);
        continue;
      }
      try {
        const result = await api.upload(file);
        await refresh();
        setActive(result.id);
      } catch (error) {
        onError((error as Error).message);
      }
    }
  }

  async function rename(id: string, title: string) {
    if (!title.trim()) return;
    try {
      const updated = await api.rename(id, title.trim());
      setProjects(list => list.map(p => p.id === id ? { ...p, ...updated } : p));
      if (activeRef.current === id) setDoc(current => current ? { ...current, title: updated.title } : null);
    } catch (error) {
      onError((error as Error).message);
    }
  }

  /** Title block: shown immediately, then saved (queued behind pending edits). */
  function setHeader(patch: Partial<ScoreHeader>) {
    if (!doc) return Promise.resolve(false);
    const id = doc.id;
    setDoc(current => current?.id === id ? { ...current, header: { ...DEFAULT_HEADER, ...current.header, ...patch } } : current);
    pendingHeader.current = { id, patch: { ...(pendingHeader.current?.id === id ? pendingHeader.current.patch : {}), ...patch } };
    const settle = () => {
      // Forget the fields this save covered, unless a later change replaced them meanwhile.
      const current = pendingHeader.current;
      if (current?.id !== id) return;
      const rest = Object.fromEntries(Object.entries(current.patch)
        .filter(([key, value]) => value !== patch[key as keyof ScoreHeader]));
      pendingHeader.current = Object.keys(rest).length ? { id, patch: rest } : null;
    };
    const result = queue.current.then(async () => {
      try {
        const updated = await api.setHeader(id, patch);
        settle();
        if (updated.version !== undefined) {
          if (activeRef.current === id) setDoc(current => current?.id === id ? { ...current, version: updated.version! } : current);
          setProjects(list => list.map(p => p.id === id ? { ...p, version: updated.version } : p));
        }
        return true;
      } catch (error) {
        settle();
        onError((error as Error).message);
        const fresh = await api.doc(id).catch(() => null);
        if (fresh && activeRef.current === id) setDoc(fresh);
        return false;
      }
    });
    queue.current = result;
    return result;
  }

  async function remove(id: string) {
    try {
      await api.remove(id);
      const list = await refresh();
      if (activeRef.current === id) setActive(list[0]?.id ?? null);
    } catch (error) {
      onError((error as Error).message);
    }
  }

  return {
    projects, project, active, setActive, doc, loading, busy, config, setConfig,
    upload, rename, remove, setHeader,
    edit: (ops: Op[], label?: string) => doc
      ? mutate(doc.id, () => api.edit(doc.id, ops, label)) : Promise.resolve(false),
    settings: (settings: Partial<Settings>) => doc
      ? mutate(doc.id, () => api.settings(doc.id, settings)) : Promise.resolve(false),
    undo: () => doc ? mutate(doc.id, () => api.undo(doc.id)) : Promise.resolve(false),
    redo: () => doc ? mutate(doc.id, () => api.redo(doc.id)) : Promise.resolve(false),
  };
}
