import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Cpu, X } from 'lucide-react';
import { api } from '../lib/api';
import type { PerfPreset, PerfPriority, PerfSettings, PerfStatus, Project } from '../lib/types';
import { InfoTip, Label, Segmented } from './Controls';

const PRESETS: { value: PerfPreset; label: string }[] = [
  { value: 'eco', label: 'Eco' }, { value: 'balanced', label: 'Balanced' },
  { value: 'full', label: 'Full' }, { value: 'custom', label: 'Custom' },
];
const PRIORITIES: { value: PerfPriority; label: string }[] = [
  { value: 'normal', label: 'Normal' }, { value: 'low', label: 'Low' }, { value: 'background', label: 'Background' },
];

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
const cores = (percent: number) => `${(percent / 100).toFixed(1)}`;

interface Props {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  onError: (message: string) => void;
}

export function PerformanceDialog({ open, onClose, projects, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<PerfStatus | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  // Every request gets a sequence number; a response older than one already shown (e.g. a poll that
  // started before a save) is dropped, so the dialog never jumps back to stale settings.
  const issued = useRef(0);
  const shown = useRef(0);
  const accept = (seq: number, next: PerfStatus) => {
    if (seq < shown.current) return;
    shown.current = seq;
    setStatus(next);
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      const seq = ++issued.current;
      try {
        const next = await api.performance();
        if (alive) accept(seq, next);
      } catch (error) {
        if (alive) onError((error as Error).message);
      }
      if (alive) timer = window.setTimeout(poll, 1500);      // next poll only after this one finished
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, onError]);

  async function save(body: Partial<PerfSettings>) {
    setSaving(true);
    const seq = ++issued.current;
    try {
      accept(seq, await api.setPerformance(body));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggleCore(core: number) {
    if (!status) return;
    const current = new Set(status.effective.cores);
    if (current.has(core)) current.delete(core);
    else current.add(core);
    if (!current.size) return;
    void save({ preset: 'custom', cores: [...current].sort((a, b) => a - b), priority: status.settings.priority });
  }

  const s = status;
  const used = new Set(s?.effective.cores ?? []);
  const job = s?.usage.job;
  const jobTitle = job ? projects.find(project => project.id === job.project)?.title ?? job.project : null;

  return <dialog ref={dialog} className="dialog glass perf-dialog" onCancel={onClose} aria-labelledby="perf-title"
    onClick={event => {
      if (event.target === dialog.current) onClose();
    }}>
    <div className="dialog-heading">
      <h2 id="perf-title"><Cpu size={17} />Performance</h2>
      <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
    </div>
    {!s ? <p>Loading…</p> : <div className="perf-body">
      <Label tip="Eco: about a quarter of the cores at background priority. Balanced: about half at low priority. Full: every core the container allows. Custom: choose cores below. Transcription is the only heavy work; the editor stays responsive at any setting.">Preset</Label>
      <Segmented label="Performance preset" value={s.settings.preset} disabled={saving} options={PRESETS}
        onChange={preset => void save(preset === 'custom'
          ? { preset, cores: s.effective.cores, priority: s.settings.priority } : { preset })} />

      <div className="perf-row-heading">
        <Label tip="Cores the backend may run on. Lit cores are in use; the fill shows each core's current load across the whole system. Click a core to switch to Custom and toggle it. Cores applied immediately, including to a running transcription.">Cores</Label>
        <span className="perf-figure">{s.effective.cores.length} of {s.system.allowed_cores.length} · {s.effective.threads} threads</span>
      </div>
      <div className="core-grid" role="group" aria-label="CPU cores">
        {s.system.allowed_cores.map(core => {
          const load = Math.round(s.usage.per_core[core] ?? 0);
          return <button key={core} type="button" className="core-chip" aria-pressed={used.has(core)} disabled={saving}
            aria-label={`Core ${core}, ${load}% load`} title={`${load}% load`} onClick={() => toggleCore(core)}
            style={{ '--load': `${load}%` } as CSSProperties}>
            <span className="core-fill" aria-hidden="true" /><span className="core-label">{core}</span>
          </button>;
        })}
      </div>

      <Label tip={`Scheduling priority of transcriptions. Lower priority lets the host's other apps go first, so a busy host slows the transcription, not your other services.${s.system.can_raise_priority ? '' : ' Raising priority takes effect from the next transcription.'}`}>Priority</Label>
      <Segmented label="Transcription priority" value={s.settings.priority} disabled={saving} options={PRIORITIES}
        onChange={priority => void save(s.settings.preset === 'custom'
          ? { preset: 'custom', cores: s.effective.cores, priority } : { preset: s.settings.preset, priority })} />

      <dl className="perf-stats">
        <div><dt>Transcription</dt><dd>{job
          ? <><strong>{jobTitle}</strong> · {cores(job.cpu ?? 0)} cores · {gb(job.rss ?? 0)}</>
          : 'Idle'}</dd></div>
        <div><dt>Server</dt><dd>{cores(s.usage.server_cpu)} cores · {gb(s.usage.server_rss)}</dd></div>
        <div><dt>Memory</dt><dd>{gb(s.system.memory_available)} free of {gb(s.system.memory_total)}{s.system.memory_limit ? ` · container limit ${gb(s.system.memory_limit)}` : ''}</dd></div>
        <div><dt>Container cap</dt><dd>{s.system.cpu_quota ? `${s.system.cpu_quota} CPUs` : 'None'}
          <InfoTip label="container limits">Hard limits set in docker-compose.yml (cpus, cpuset, mem_limit) cap everything here. Change them there and recreate the container.</InfoTip></dd></div>
      </dl>
    </div>}
  </dialog>;
}
