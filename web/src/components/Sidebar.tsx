import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Settings, FileAudio2, FileMusic, FolderOpen, MoreHorizontal, Music2, Pencil, Plus, RefreshCw, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import type { Health, Instruments, Project } from '../lib/types';
import { Dropdown, InfoTip } from './Controls';
import { ModeChooser, type Mode } from './ModeChooser';

interface Props {
  projects: Project[];
  active: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onUpload: (files: File[], mode?: { instruments: Instruments; model?: string }) => Promise<void>;
  /** YourMT3+ availability and checkpoints (null: unknown / not offered). */
  multi?: Health['multi'] | null;
  onRename: (id: string, title: string) => Promise<void>;
  onRetranscribe?: (id: string, mode: { instruments: Instruments; model?: string }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onError: (message: string) => void;
  onSettings: () => void;
  modelsMissing?: boolean;
  onStorage?: () => void;
  /** Closes the library drawer (tablet / phone layouts). */
  onClose?: () => void;
}

const MODEL_KEY = 'score-studio:mt3-model';

function storedModel(): string | undefined {
  try {
    return localStorage.getItem(MODEL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const isAudio = (name: string) => !/\.(mid|midi)$/i.test(name);

export function Sidebar({ projects, active, loading, multi, modelsMissing, onStorage, onSelect, onUpload, onRetranscribe, onRename, onRemove, onError, onClose, onSettings }: Props) {
  const multiOn = !!multi?.available;
  const [modelPref, setModelPref] = useState(storedModel);
  const model = multi?.models.some(m => m.key === modelPref) ? modelPref : multi?.default;
  const setModel = (value: string) => {
    setModelPref(value);
    try {
      localStorage.setItem(MODEL_KEY, value);
    } catch { /* per-viewer convenience only */ }
  };
  /** Files waiting for the piano / multiple-instruments choice. */
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  /** Project waiting for the "Transcribe again" choice. */
  const [again, setAgain] = useState<Project | null>(null);
  const [againModel, setAgainModel] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [action, setAction] = useState<{ type: 'rename' | 'delete'; project: Project } | null>(null);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);

  useEffect(() => {
    if (action) dialog.current?.showModal();
    else dialog.current?.close();
  }, [action]);

  async function send(files: File[], mode: Mode) {
    setUploading(true);
    await onUpload(files, mode);
    setUploading(false);
    setPendingFiles(null);
    if (input.current) input.current.value = '';
  }

  function upload(files: File[]) {
    if (!files.length || uploading) return;
    if (multiOn) setPendingFiles(files);          // ask: piano or multiple instruments
    else void send(files, { instruments: 'piano' });
  }

  async function transcribeAgain(mode: Mode) {
    if (!again) return;
    setSubmitting(true);
    await onRetranscribe?.(again.id, mode);
    setSubmitting(false);
    setAgain(null);
  }

  function openAction(type: 'rename' | 'delete', project: Project) {
    setTitle(project.title);
    setAction({ type, project });
  }

  return <aside className="sidebar glass" aria-label={t("Project library")} id="library">
    <div className="brand"><span className="brand-mark"><Music2 size={22} /></span><span>{t("Score Studio")}</span>
      <button type="button" className="icon-button drawer-close" aria-label={t("Close project library")} onClick={onClose}><X size={17} /></button>
    </div>
    <div className="upload-heading">
      <span>{t("New transcription")}</span>
      <InfoTip label={t("file upload")}>{t("Drop or choose .mid, .midi, .mp3, .wav, .flac, .m4a or .ogg files. Audio and MIDI are transcribed into an editable piano score.")}</InfoTip>
    </div>
    <input ref={input} type="file" multiple hidden accept=".mid,.midi,.mp3,.wav,.flac,.m4a,.ogg"
      onChange={event => void upload(Array.from(event.target.files ?? []))} />
    <button className={`upload-zone ${dragging ? 'dragover' : ''}`} disabled={uploading}
      aria-label={t("New transcription")} onClick={() => input.current?.click()}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}>
      <span className="upload-icon"><Upload size={21} /></span>
      <span>{uploading ? t("Uploading…") : t("Drop audio or MIDI")}</span>
      <span className="upload-choose"><Plus size={12} />{t("Choose files")}</span>
    </button>
    {modelsMissing && <button type="button" className="models-warning" aria-label={t('Models missing — Settings › Storage')} onClick={onStorage}>
      <TriangleAlert size={16} /><span>{t('Models missing')}<small>{t('Settings › Storage')}</small></span><ChevronRight size={15} />
    </button>}
    <div className="library-heading"><FolderOpen size={14} /><h2>{t("Projects")}</h2><span className="chip">{projects.length}</span></div>
    <nav className="projects" aria-label={t("Projects")}>
      {loading && <div className="library-empty">{t("Loading projects…")}</div>}
      {!loading && !projects.length && <div className="library-empty">{t("No projects")}</div>}
      {projects.map(project => {
        const pending = !['ready', 'error'].includes(project.status);
        const Icon = project.source === 'audio' ? FileAudio2 : FileMusic;
        return <div key={project.id} data-project-id={project.id} className={`project-item ${project.id === active ? 'active' : ''}`}>
          <button className="project-select" aria-current={active === project.id ? 'page' : undefined}
            onClick={() => {
              onSelect(project.id);
              onClose?.();
            }}>
            <span className="project-icon"><Icon size={19} /></span>
            <span className="project-copy"><strong>{project.title}</strong><small>{project.source === 'audio' ? t("Audio") : t("MIDI")}{project.parts?.length ? ` · ${project.parts.map(part => part.name).join(' + ')}` : project.instruments === 'multi' ? t(" · Multi-instrument") : ''}{project.bars ? t(" · {0} bars", [project.bars]) : ''}</small></span>
          </button>
          <Dropdown label={t("Options for {0}", [project.title])} icon={<MoreHorizontal size={16} />} className="project-menu">
            <button role="menuitem" onClick={() => openAction('rename', project)}><Pencil size={15} />{t("Rename")}</button>
            {multiOn && onRetranscribe && !pending && <button role="menuitem" onClick={() => {
              setAgainModel(project.mt3_model ?? model);
              setAgain(project);
            }}><RefreshCw size={15} />{t("Transcribe again…")}</button>}
            <button role="menuitem" className="danger" onClick={() => openAction('delete', project)}><Trash2 size={15} />{t("Delete")}</button>
          </Dropdown>
          <div className="project-state"><span className={`status-chip ${project.status}`}><span />{t(project.status)}</span>{pending && <span>{Math.round((project.progress?.fraction ?? 0) * 100)}%</span>}</div>
          {pending && <div className="project-progress">
            <progress max="1" value={project.progress?.fraction ?? 0} aria-label={t("{0} progress", [project.title])} />
            <small>{t(project.progress?.message ?? project.progress?.stage ?? 'Queued')}</small>
          </div>}
          {project.status === 'error' && <small className="project-error">{t(project.error ?? "Processing failed")}</small>}
        </div>;
      })}
    </nav>
    <div className="sidebar-footer"><button type="button" className="button ghost small" aria-haspopup="dialog" onClick={onSettings}><Settings size={16} />{t("Settings")}</button></div>
    <dialog ref={dialog} className="dialog glass" onCancel={() => setAction(null)}
      onClick={event => {
        if (event.target === dialog.current) setAction(null);
      }} aria-labelledby="project-action-title">
      {action && <form onSubmit={async event => {
        event.preventDefault();
        setSubmitting(true);
        if (action.type === 'rename') await onRename(action.project.id, title);
        else await onRemove(action.project.id);
        setSubmitting(false);
        setAction(null);
      }}>
        <div className="dialog-heading"><h2 id="project-action-title">{action.type === 'rename' ? t("Rename project") : t("Delete project?")}</h2><button type="button" className="icon-button" aria-label={t("Close")} onClick={() => setAction(null)}><X size={17} /></button></div>
        {action.type === 'rename'
          ? <label className="field">{t("Name")}<input autoFocus required aria-label={t("New project name")} value={title} onChange={event => setTitle(event.target.value)} /></label>
          : <p>{t("Delete “")}{action.project.title}{t("” and its editing history?")}</p>}
        <div className="dialog-actions"><button type="button" className="button ghost small" onClick={() => setAction(null)}>{t("Cancel")}</button><button className="button primary small" disabled={submitting || (action.type === 'rename' && !title.trim())}>{action.type === 'rename' ? t("Save") : t("Delete")}</button></div>
      </form>}
    </dialog>
    {multiOn && <ModeChooser open={!!pendingFiles} title={t("New transcription")} files={(pendingFiles ?? []).map(f => f.name)}
      model={model} multi={multi!} busy={uploading} audio={(pendingFiles ?? []).some(f => isAudio(f.name))}
      onModel={setModel} onChoose={mode => void send(pendingFiles ?? [], mode)}
      onCancel={() => {
        setPendingFiles(null);
        if (input.current) input.current.value = '';
      }} />}
    {multiOn && <ModeChooser open={!!again} title={t("Transcribe again")} files={[]} current={again?.instruments ?? 'piano'}
      model={againModel ?? model} multi={multi!} busy={submitting} audio={again?.source === 'audio'}
      onModel={setAgainModel} onChoose={mode => void transcribeAgain(mode)} onCancel={() => setAgain(null)} />}
  </aside>;
}
