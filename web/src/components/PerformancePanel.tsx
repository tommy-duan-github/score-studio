import { t } from '../lib/i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
  projects: Project[];
  onError: (message: string) => void;
}

export function PerformancePanel({ open, projects, onError }: Props) {
  const [status, setStatus] = useState<PerfStatus | null>(null);
  const [saving, setSaving] = useState(false);


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

  return <>
    {!s ? <p>{t("Loading…")}</p> : <div className="perf-body">
      <Label tip={t("Eco uses about a quarter of available cores at background priority; Balanced uses half at low priority; Full uses all cores. Choose Custom to select individual cores.")}>{t("Preset")}</Label>
      <Segmented label={t("Performance preset")} value={s.settings.preset} disabled={saving} options={PRESETS}
        onChange={preset => void save(preset === 'custom'
          ? { preset, cores: s.effective.cores, priority: s.settings.priority } : { preset })} />

      <div className="perf-row-heading">
        <Label tip={t("Lit cores are available to transcription; the fill shows system load. Click to toggle a core and switch to Custom, including during a running transcription.")}>{t("Cores")}</Label>
        <span className="perf-figure">{t("{0} of {1} · {2} threads", [s.effective.cores.length, s.system.allowed_cores.length, s.effective.threads])}</span>
      </div>
      <div className="core-grid" role="group" aria-label={t("CPU cores")}>
        {s.system.allowed_cores.map(core => {
          const load = Math.round(s.usage.per_core[core] ?? 0);
          return <button key={core} type="button" className="core-chip" aria-pressed={used.has(core)} disabled={saving}
            aria-label={t("Core {0}, {1}% load", [core, load])} onClick={() => toggleCore(core)}
            style={{ '--load': `${load}%` } as CSSProperties}>
            <span className="core-fill" aria-hidden="true" /><span className="core-label">{core}</span>
          </button>;
        })}
      </div>

      <Label tip={t("Lower priority lets other apps use CPU time first.{0}", [s.system.can_raise_priority ? '' : t(' Raising priority takes effect from the next transcription.')])}>{t("Priority")}</Label>
      <Segmented label={t("Transcription priority")} value={s.settings.priority} disabled={saving} options={PRIORITIES}
        onChange={priority => void save(s.settings.preset === 'custom'
          ? { preset: 'custom', cores: s.effective.cores, priority } : { preset: s.settings.preset, priority })} />

      <section className="gpu-section">
        <Label tip={s.gpu?.available ? t('CUDA accelerates the listed transcription steps. Driver: {0}', [s.gpu.driver ?? t('Unknown')]) : t("No CUDA GPU — transcription runs on the CPU")}>{t("GPU")}</Label>
        {s.gpu?.available && <>
          <strong>{s.gpu.name}</strong>
          <label className="gpu-meter">{t("Utilization")}<span>{s.gpu.utilization == null ? t("Unavailable") : Math.round(s.gpu.utilization) + '%'}</span>
            <progress aria-label={t("GPU utilization")} max="100" {...(s.gpu.utilization == null ? {} : { value: s.gpu.utilization })} />
          </label>
          <label className="gpu-meter">{t("GPU memory")}<span>{s.gpu.memory_used == null || !s.gpu.memory_total ? t("Unavailable") : gb(s.gpu.memory_used) + ' / ' + gb(s.gpu.memory_total)}</span>
            <progress aria-label={t("GPU memory")} max={s.gpu.memory_total || 1} {...(s.gpu.memory_used == null ? {} : { value: s.gpu.memory_used })} />
          </label>
          <small>{s.gpu.used_for.map(step => t(step)).join(' · ')}</small>
        </>}
      </section>
      <dl className="perf-stats">
        <div><dt>{t("Transcription")}</dt><dd>{job
          ? <><strong>{jobTitle}</strong> · {job.device?.toUpperCase()} · {t("{0} cores · {1}", [cores(job.cpu ?? 0), gb(job.rss ?? 0)])}</>
          : t("Idle")}</dd></div>
        <div><dt>{t("Server")}</dt><dd>{t("{0} cores · {1}", [cores(s.usage.server_cpu), gb(s.usage.server_rss)])}</dd></div>
        <div><dt>{t("Memory")}</dt><dd>{t("{0} free of {1}", [gb(s.system.memory_available), gb(s.system.memory_total)])}{s.system.memory_limit ? t(" · container limit {0}", [gb(s.system.memory_limit)]) : ''}</dd></div>
        <div><dt>{t("Container cap")}</dt><dd>{s.system.cpu_quota ? t("{0} CPUs", [s.system.cpu_quota]) : t("None")}
          <InfoTip label={t("container limits")}>{t("Hard limits set in docker-compose.yml (cpus, cpuset, mem_limit) cap everything here. Change them there and recreate the container.")}</InfoTip></dd></div>
      </dl>
    </div>}
  </>;
}
