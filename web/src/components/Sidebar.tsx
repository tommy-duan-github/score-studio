import { useEffect, useRef, useState } from 'react';
import { Cpu, FileAudio2, FileMusic, FolderOpen, MoreHorizontal, Music2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { MOCK } from '../lib/api';
import type { Project } from '../lib/types';
import { Dropdown, InfoTip } from './Controls';
import { PerformanceDialog } from './PerformanceDialog';

interface Props {
  projects: Project[];
  active: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onUpload: (files: File[]) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onError: (message: string) => void;
  /** Closes the library drawer (tablet / phone layouts). */
  onClose?: () => void;
}

export function Sidebar({ projects, active, loading, onSelect, onUpload, onRename, onRemove, onError, onClose }: Props) {
  const [perfOpen, setPerfOpen] = useState(false);
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

  async function upload(files: File[]) {
    if (!files.length || uploading) return;
    setUploading(true);
    await onUpload(files);
    setUploading(false);
    if (input.current) input.current.value = '';
  }

  function openAction(type: 'rename' | 'delete', project: Project) {
    setTitle(project.title);
    setAction({ type, project });
  }

  return <aside className="sidebar glass" aria-label="Project library" id="library">
    <div className="brand"><span className="brand-mark"><Music2 size={22} /></span><span>Score Studio</span>
      <button type="button" className="icon-button drawer-close" aria-label="Close project library" onClick={onClose}><X size={17} /></button>
    </div>
    <div className="upload-heading">
      <span>New transcription</span>
      <InfoTip label="file upload">Drop or choose .mid, .midi, .mp3, .wav, .flac, .m4a or .ogg files. Audio and MIDI are transcribed into an editable piano score.</InfoTip>
    </div>
    <input ref={input} type="file" multiple hidden accept=".mid,.midi,.mp3,.wav,.flac,.m4a,.ogg"
      onChange={event => void upload(Array.from(event.target.files ?? []))} />
    <button className={`upload-zone ${dragging ? 'dragover' : ''}`} disabled={uploading}
      aria-label="New transcription" onClick={() => input.current?.click()}
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
      <span>{uploading ? 'Uploading…' : 'Drop audio or MIDI'}</span>
      <span className="upload-choose"><Plus size={12} /> Choose files</span>
    </button>
    <div className="library-heading"><FolderOpen size={14} /><h2>Projects</h2><span className="chip">{projects.length}</span></div>
    <nav className="projects" aria-label="Projects">
      {loading && <div className="library-empty">Loading projects…</div>}
      {!loading && !projects.length && <div className="library-empty">No projects</div>}
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
            <span className="project-copy"><strong>{project.title}</strong><small>{project.source === 'audio' ? 'Audio' : 'MIDI'}{project.bars ? ` · ${project.bars} bars` : ''}</small></span>
          </button>
          <Dropdown label={`Options for ${project.title}`} icon={<MoreHorizontal size={16} />} className="project-menu">
            <button role="menuitem" onClick={() => openAction('rename', project)}><Pencil size={15} />Rename</button>
            <button role="menuitem" className="danger" onClick={() => openAction('delete', project)}><Trash2 size={15} />Delete</button>
          </Dropdown>
          <div className="project-state"><span className={`status-chip ${project.status}`}><span />{project.status}</span>{pending && <span>{Math.round((project.progress?.fraction ?? 0) * 100)}%</span>}</div>
          {pending && <div className="project-progress">
            <progress max="1" value={project.progress?.fraction ?? 0} aria-label={`${project.title} progress`} />
            <small>{project.progress?.message ?? project.progress?.stage ?? 'Queued'}</small>
          </div>}
          {project.status === 'error' && <small className="project-error">{project.error ?? 'Processing failed'}</small>}
        </div>;
      })}
    </nav>
    <div className="sidebar-footer"><span className="status-dot" />{MOCK ? 'Mock workspace' : 'Workspace'}
      <InfoTip label="workspace">{MOCK ? 'Fixture score. Edits and uploads are kept in memory and reset on refresh.' : 'Projects, audio and editing history are stored on the Score Studio backend.'}</InfoTip>
      {!MOCK && <button type="button" className="chip perf-button" aria-haspopup="dialog" onClick={() => setPerfOpen(true)}><Cpu size={13} />Performance</button>}
    </div>
    {!MOCK && <PerformanceDialog open={perfOpen} onClose={() => setPerfOpen(false)} projects={projects} onError={onError} />}
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
        <div className="dialog-heading"><h2 id="project-action-title">{action.type === 'rename' ? 'Rename project' : 'Delete project?'}</h2><button type="button" className="icon-button" aria-label="Close" onClick={() => setAction(null)}><X size={17} /></button></div>
        {action.type === 'rename'
          ? <label className="field">Name<input autoFocus required aria-label="New project name" value={title} onChange={event => setTitle(event.target.value)} /></label>
          : <p>Delete “{action.project.title}” and its editing history?</p>}
        <div className="dialog-actions"><button type="button" className="button ghost small" onClick={() => setAction(null)}>Cancel</button><button className="button primary small" disabled={submitting || (action.type === 'rename' && !title.trim())}>{action.type === 'rename' ? 'Save' : 'Delete'}</button></div>
      </form>}
    </dialog>
  </aside>;
}
