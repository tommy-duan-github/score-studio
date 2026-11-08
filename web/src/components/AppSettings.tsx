import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { Cpu, ExternalLink, Github, HardDrive, Info, MessageCircle, Music2, Settings, SlidersHorizontal, User, X } from 'lucide-react';

const REPO_URL = 'https://github.com/tommy-duan-github/score-studio';
import { api } from '../lib/api';
import type { Project } from '../lib/types';
import type { Theme } from '../hooks/useTheme';
import { useLanguage } from '../lib/i18n';
import { Label, Segmented } from './Controls';
import { PerformancePanel } from './PerformancePanel';
import { StoragePanel } from './StoragePanel';
import type { ModelManager } from '../hooks/useModels';

export function AppSettings({ open, onClose, theme, onTheme, projects, onError, models, onDelete, initialSection = 'General' }: {
  open: boolean; onClose: () => void; theme: Theme; onTheme: (theme: Theme) => void;
  projects: Project[]; onError: (message: string) => void;
  models: ModelManager; onDelete: (body: { ids: string[] } | { all: true }) => Promise<void>;
  initialSection?: 'General' | 'Storage';
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<'General' | 'Performance' | 'Storage' | 'About'>('General');
  const [version, setVersion] = useState('');
  const { language, setLanguage } = useLanguage();
  useEffect(() => {
    if (open) {
      if (initialSection === 'Storage') setSection('Storage');
      dialog.current?.showModal();
      (document.activeElement as HTMLElement | null)?.blur();      // no focus ring on the first tab when opened by mouse
    } else dialog.current?.close();
  }, [open, initialSection]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.health().then(health => { if (live) setVersion(health.version); }).catch(error => { if (live) onError(error.message); });
    return () => { live = false; };
  }, [open, onError]);
  const sections = [
    { value: 'General', label: t('General'), title: t('Preferences'), icon: SlidersHorizontal },
    { value: 'Performance', label: t('Performance'), title: t('Performance'), icon: Cpu },
    { value: 'Storage', label: t('Storage'), title: t('Storage'), icon: HardDrive },
    { value: 'About', label: t('About'), title: t('About'), icon: Info },
  ] as const;
  const current = sections.find(item => item.value === section)!;
  return <dialog ref={dialog} className="dialog glass app-settings" aria-labelledby="app-settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <nav className="settings-nav" aria-label={t("Settings sections")}>
      <h2 id="app-settings-title"><Settings size={16} /><span>{t("Settings")}</span></h2>
      <div role="tablist" aria-orientation="vertical">
        {sections.map(item => <button key={item.value} type="button" role="tab" aria-selected={section === item.value}
          className={section === item.value ? 'active' : ''} onClick={() => setSection(item.value)}>
          <item.icon size={16} /><span>{item.label}</span>
        </button>)}
      </div>
    </nav>
    <section className="settings-content" role="tabpanel" aria-label={current.title}>
      <div className="settings-content-head">
        <h3>{current.title}</h3>
        <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X size={17} /></button>
      </div>
      {section === 'General' && <div className="general-settings">
        <Label>{t("Theme")}</Label>
        <Segmented label={t("Theme")} value={theme} onChange={onTheme} options={[
          { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
        ]} />
        <Label>{t("Language")}</Label>
        <Segmented label={t("Language")} value={language} onChange={setLanguage} options={[
          { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' },
        ]} />
      </div>}
      {section === 'Performance' && <PerformancePanel open={open} projects={projects} onError={onError} />}
      {section === 'Storage' && open && <StoragePanel models={models} onDelete={onDelete} />}
      {section === 'About' && <div className="about-settings">
        <div className="about-identity">
          <span className="brand-mark"><Music2 size={22} /></span>
          <div><strong>{t("Score Studio")}</strong><small>{t("Version")} {version || '—'}</small></div>
        </div>
        <p>{t("Score Studio turns piano recordings or MIDI into an editable score, with multi-instrument transcription in beta. Built on Transkun, DuET, YourMT3+ and Verovio.")}</p>
        <div className="storage-list about-links">
          <a className="about-row" href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="storage-icon"><Github size={16} /></span>
            <span className="row-copy"><strong>{REPO_URL.replace('https://github.com/', '')}</strong><small>{t("Updates, releases and bug reports")}</small></span>
            <ExternalLink size={14} className="about-row-end" />
          </a>
          <div className="about-row">
            <span className="storage-icon group-multi"><MessageCircle size={16} /></span>
            <span className="row-copy"><strong>dafisherman</strong><small>Discord</small></span>
          </div>
          <div className="about-row">
            <span className="storage-icon neutral"><User size={16} /></span>
            <span className="row-copy"><strong>Tommy Duan</strong><small>{t("Author")}</small></span>
          </div>
        </div>
      </div>}
    </section>
  </dialog>;
}
