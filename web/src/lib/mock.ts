import { Midi } from '@tonejs/midi';
import { version } from '../../package.json';
import type {
  AssistantRequest, HistoryEntry, Instrument, LlmConfig, Model, ModelsStatus, Note, Op, PartOverrides, PerfSettings, PerfStatus, Project, Review, ScoreDoc, ScoreHeader, Settings,
} from './types';
import { DEFAULT_HEADER } from './verovio';

const defaults: Settings = {
  max_voices: 3,
  auto_keys: true,
  auto_spelling: true,
  auto_runs: true,
  hand_span: 14,
  show_pedal: false,
  show_dynamics: true,
  show_tempo: true,
};

const reviews: Review[] = [
  {
    id: 'key:1-8', kind: 'key', priority: 'high', measures: [1, 8],
    question: 'Which key signature best reflects the opening phrase?',
    options: [{ index: 0, label: 'Keep F major' }, { index: 1, label: 'Use C major' }],
    resolved: null,
  },
  {
    id: 'voice:12-16', kind: 'voice', priority: 'medium', measures: [12, 16],
    question: 'Should the inner left-hand line be a separate voice?',
    options: [{ index: 0, label: 'Keep separate' }, { index: 1, label: 'Merge voices' }],
    resolved: null,
  },
  {
    id: 'duration:28-29', kind: 'duration', priority: 'low', measures: [28, 29],
    question: 'Sustain the bass across the bar line?',
    options: [{ index: 0, label: 'Keep as written' }, { index: 1, label: 'Tie the bass', supported: false }],
    resolved: null,
  },
];

const copy = <T,>(value: T): T => structuredClone(value);
// Deterministic desktop/offline fixtures also support manual UI previews.
const modelScenario = new URLSearchParams(location.search).get('mockModels');
const firstRun = modelScenario === 'missing' || modelScenario === 'offline';
const GiB = 1024 ** 3;
const modelDefinitions = [
  ['duet', 'DuET', 'Rhythm, bars and hands', true, false, true, true, 0.7],
  ['transkun', 'Transkun', 'Piano transcription', true, false, true, false, 0.4],
  ['yptf-multi-ps', 'YourMT3+ · YPTF Multi PS', 'Multiple instruments', false, true, false, true, 1.2],
  ['moe-nops', 'YourMT3+ · MoE NoPS', 'Multiple instruments', false, false, true, true, 1.5],
  ['moe-ps', 'YourMT3+ · MoE PS', 'Multiple instruments', false, false, false, true, 1.5],
  ['yptf-single', 'YourMT3+ · YPTF Single', 'Single instrument', false, false, false, true, 0.9],
  ['ymt3+', 'YourMT3+', 'Multiple instruments', false, false, false, true, 1],
] as const;
const models: Model[] = modelDefinitions.map(([key, name, purpose, required, recommended, installed, managed, size]) => ({
  key, name, purpose, required, recommended,
  installed: modelScenario === 'docker' || (firstRun && managed ? false : installed),
  managed: modelScenario === 'docker' ? false : managed,
  bytes: installed ? Math.round(size * GiB) : null, download_bytes: Math.round(size * GiB),
  source: key === 'duet' ? 'huggingface.co/Wayne42/DuET' : 'huggingface.co',
  state: modelScenario === 'states' && key === 'moe-ps' ? 'error' : 'idle', progress: null,
  error: modelScenario === 'states' && key === 'moe-ps' ? 'Download failed. Check your connection and retry.' : null,
}));
const downloads = new Map<string, number>();
let failDownload = modelScenario === 'offline';
let storageStarted: number | null = null;
function mockModels(): ModelsStatus {
  const hadDownloads = downloads.size > 0;
  for (const [key, start] of downloads) {
    const model = models.find(item => item.key === key)!;
    const progress = Math.min(1, (Date.now() - start) / 3500);
    if (failDownload && progress > 0.25) {
      model.state = 'error'; model.error = 'Download failed. Check your connection and retry.';
      model.progress = null; downloads.delete(key);
    } else if (progress >= 1) {
      model.state = 'idle'; model.installed = true; model.bytes = model.download_bytes;
      model.progress = null; downloads.delete(key);
    } else { model.state = progress < 0.1 ? 'queued' : 'downloading'; model.progress = progress; }
  }
  if (hadDownloads && !downloads.size) failDownload = false;
  return copy({ ready: models.filter(model => model.required).every(model => model.installed), downloading: downloads.size > 0, models });
}
const originalFiles = new Map<string, File>();
const instruments: Instrument[] = [
  { name: 'Piano', program: 0, clef: 'G', kind: 'grand' },
  { name: 'Electric piano', program: 4, clef: 'G', kind: 'grand' },
  { name: 'Violin', program: 40, clef: 'G', kind: 'single' },
  { name: 'Viola', program: 41, clef: 'C', kind: 'single' },
  { name: 'Cello', program: 42, clef: 'F', kind: 'single' },
  { name: 'Flute', program: 73, clef: 'G', kind: 'single' },
];
const performanceSettings: PerfSettings = { preset: 'balanced', cores: [0, 1, 2, 3], priority: 'low' };
const performancePresets = {
  eco: { cores: [0, 1], threads: 2, priority: 'background' as const, nice: 19 },
  balanced: { cores: [0, 1, 2, 3], threads: 4, priority: 'low' as const, nice: 10 },
  full: { cores: [0, 1, 2, 3, 4, 5, 6, 7], threads: 8, priority: 'normal' as const, nice: 0 },
};
function mockPerformance(): PerfStatus {
  return copy({
    settings: performanceSettings,
    effective: { cores: performanceSettings.cores, threads: performanceSettings.cores.length, priority: performanceSettings.priority,
      nice: performanceSettings.priority === 'normal' ? 0 : performanceSettings.priority === 'low' ? 10 : 19 },
    presets: performancePresets,
    system: { platform: 'Mock', docker: false, logical_cpus: 8, allowed_cores: performancePresets.full.cores, cpu_quota: null,
      memory_limit: null, memory_total: 16 * 1024 ** 3, memory_available: 10 * 1024 ** 3, can_raise_priority: true },
    usage: { per_core: Array.from({ length: 8 }, (_, i) => 10 + Math.round((Math.sin(Date.now() / 1800 + i) + 1) * 25)), server_cpu: 12, server_rss: 180 * 1024 ** 2, job: null },
    gpu: { available: true, name: 'NVIDIA GeForce (mock)', memory_total: 8 * 1024 ** 3, memory_used: 2 * 1024 ** 3,
      utilization: 24, driver: 'Mock', used_for: ['Piano transcription (Transkun)', 'Score model (DuET)', 'Multi-instrument (YourMT3+)'] },
  });
}

export async function mockOriginal(doc: ScoreDoc) {
  if (originalFiles.has(doc.id)) return originalFiles.get(doc.id)!;
  const { encodeWav } = await import('./exportAudio');
  const length = Math.ceil((doc.timemap.at(-1)?.[1] ?? 1) * 44100);
  const buffer = new AudioBuffer({ length, sampleRate: 44100 });
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < Math.min(channel.length, 44100); i++) channel[i] = Math.sin(i * 2 * Math.PI * 440 / 44100) * 0.1;
  return encodeWav(buffer, () => {});
}

export function mockOriginalFilename(doc: ScoreDoc) {
  const file = originalFiles.get(doc.id);
  return `${doc.title}.${file ? file.name.split('.').pop() : 'wav'}`;
}

export async function mockXml(id: string) {
  const doc = await getDoc(id);
  const xml = new DOMParser().parseFromString((await fixture()).xml, 'application/xml');
  for (const part of doc.parts ?? []) {
    let definition = xml.querySelector(`score-part[id="${part.id}"]`);
    if (!definition && part.id !== 'P1') {
      definition = xml.createElement('score-part'); definition.setAttribute('id', part.id);
      const name = xml.createElement('part-name'); definition.append(name);
      xml.querySelector('part-list')!.append(definition);
      const music = xml.createElement('part'); music.setAttribute('id', part.id);
      for (const measure of doc.measures) {
        const bar = xml.createElement('measure'); bar.setAttribute('number', String(measure.number));
        // Pitch and timing come from the same notes as mockMidi; each written voice keeps its own cursor.
        bar.innerHTML = `<attributes><divisions>24</divisions><key><fifths>${measure.key}</fifths></key><time><beats>${measure.time[0]}</beats><beat-type>${measure.time[1]}</beat-type></time><clef><sign>${part.clef}</sign><line>${part.clef === 'F' ? 4 : part.clef === 'C' ? 3 : 2}</line></clef></attributes>`;
        const notes = doc.notes.filter(n => n.part === part.id && n.measure === measure.index && !n.deleted).sort((a, b) => a.on - b.on);
        let cursor = measure.start;
        for (const n of notes) {
          const delta = Math.round((n.on - cursor) * 24);
          if (delta) { const move = xml.createElement(delta > 0 ? 'forward' : 'backup'); move.innerHTML = `<duration>${Math.abs(delta)}</duration>`; bar.append(move); }
          const pitch = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'][n.pitch % 12];
          const alter = [1, 3, 6, 8, 10].includes(n.pitch % 12) ? 1 : 0;
          const note = xml.createElement('note'); note.setAttribute('id', `n${n.id}`);
          note.innerHTML = `<pitch><step>${pitch}</step><alter>${alter}</alter><octave>${Math.floor(n.pitch / 12) - 1}</octave></pitch><duration>${Math.round(n.dur * 24)}</duration><voice>${n.voice}</voice>`;
          bar.append(note); cursor = n.on + n.dur;
        }
        if (!notes.length) { const rest = xml.createElement('note'); rest.innerHTML = `<rest measure="yes"/><duration>${measure.length * 24}</duration>`; bar.append(rest); }
        music.append(bar);
      }
      xml.documentElement.append(music);
    }
    // The fixture's piano part may use a generated id rather than P1.
    definition ??= xml.querySelector('score-part');
    if (definition) {
      definition.querySelector('part-name')!.textContent = part.name;
      let instrument = definition.querySelector('score-instrument');
      if (!instrument) {
        instrument = xml.createElement('score-instrument'); instrument.setAttribute('id', `${part.id}-I1`);
        instrument.append(xml.createElement('instrument-name')); definition.append(instrument);
      }
      instrument.querySelector('instrument-name')!.textContent = part.name;
      let midi = definition.querySelector('midi-instrument');
      if (!midi) {
        midi = xml.createElement('midi-instrument'); midi.setAttribute('id', instrument.getAttribute('id')!);
        const channel = xml.createElement('midi-channel'); channel.textContent = String((doc.parts?.indexOf(part) ?? 0) + 1); midi.append(channel);
        midi.append(xml.createElement('midi-program')); definition.append(midi);
      }
      midi.querySelector('midi-program')!.textContent = String(part.program + 1);
    }
    const music = xml.querySelector(`part[id="${part.id}"]`) ?? (part.id === 'P1' ? xml.querySelector('part') : null);
    if (part.kind === 'single') music?.querySelectorAll('clef').forEach(clef => {
      clef.querySelector('sign')!.textContent = part.clef;
      clef.querySelector('line')!.textContent = String(part.clef === 'F' ? 4 : part.clef === 'C' ? 3 : 2);
    });
  }
  return new XMLSerializer().serializeToString(xml);
}
const number = (element: Element, tag: string, fallback = 0) => Number(element.querySelector(tag)?.textContent ?? fallback);
const pitchSteps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
let cached: Promise<{ xml: string; doc: ScoreDoc }> | undefined;

// Left-hand notes in the first two bars that have any (the demo piece may open with a left-hand rest).
function openingLeftHand(doc: ScoreDoc) {
  const left = doc.notes.filter(note => note.staff === 2);
  const first = Math.min(...left.map(note => note.measure));
  return left.filter(note => note.measure < first + 2).map(note => note.id);
}

export function fixture() {
  cached ??= loadFixture();
  return cached;
}

async function loadFixture() {
  const response = await fetch('/fixtures/score.musicxml');
  if (!response.ok) throw new Error('Missing score fixture');
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const notes: Note[] = [];
  const measures: ScoreDoc['measures'] = [];
  let id = 0;
  let end = 0;

  xml.querySelectorAll('part').forEach((part, partIndex) => {
    let start = 0;
    let divisions = 24;
    let time: [number, number] = [4, 4];
    let key = -1;
    part.querySelectorAll(':scope > measure').forEach((bar, index) => {
      divisions = number(bar, 'attributes > divisions', divisions);
      if (bar.querySelector('time')) time = [number(bar, 'beats', 4), number(bar, 'beat-type', 4)];
      key = number(bar, 'fifths', key);
      const length = time[0] * 4 / time[1];
      if (partIndex === 0) {
        measures.push({ index, number: Number(bar.getAttribute('number')) || index + 1, start, length, time: [...time], key });
      }
      let cursor = 0;
      let last = 0;
      for (const element of Array.from(bar.children)) {
        if (element.tagName === 'backup') cursor -= number(element, 'duration') / divisions;
        if (element.tagName === 'forward') cursor += number(element, 'duration') / divisions;
        if (element.tagName !== 'note') continue;
        const duration = number(element, 'duration') / divisions;
        const onset = element.querySelector('chord') ? last : cursor;
        last = onset;
        if (!element.querySelector('chord')) cursor += duration;
        if (!element.querySelector('pitch')) continue;
        const step = element.querySelector('step')!.textContent!;
        const alter = number(element, 'alter');
        const octave = number(element, 'octave');
        const pitch = 12 * (octave + 1) + pitchSteps[step] + alter;
        id += 1;
        element.setAttribute('id', `n${id}`);
        notes.push({
          id, pitch, name: step + (alter === 1 ? '♯' : alter === -1 ? '♭' : '') + octave,
          staff: number(element, 'staff', partIndex + 1),
          voice: (number(element, 'voice', 1) - 1) % 4 + 1,
          on: start + onset, dur: duration, measure: index, beat: onset,
          grace: !!element.querySelector('grace'), deleted: false, added: false,
          perf_on: (start + onset) * 60 / 130,
          perf_off: (start + onset + duration) * 60 / 130,
          velocity: 80, edited: [], part: 'P1',
        });
      }
      start += length;
    });
    end = Math.max(end, start);
  });

  const doc: ScoreDoc = {
    id: 'demo', title: 'Winter Wind', parts: [{ id: 'P1', name: 'Piano', program: 0, kind: 'grand', clef: 'G', staves: [1, 2] }], version: 1, settings: copy(defaults), header: { ...DEFAULT_HEADER },
    meta: { tempo: 130, bars: measures.length, pickup: 0, notes: notes.length, has_audio: false },
    notes, measures, timemap: Array.from({ length: Math.ceil(end) + 1 }, (_, index) => [index, index * 60 / 130]),
    review: copy(reviews), history: { can_undo: false, can_redo: false, edits: 0 },
  };
  return { xml: new XMLSerializer().serializeToString(xml), doc };
}

const projects: Project[] = [
  { id: 'demo-multi', title: 'Violin and Piano', created: new Date().toISOString(), source: 'audio', status: 'ready', bars: 102, has_audio: true, version: 1, instruments: 'multi' },
  { id: 'demo', title: 'Winter Wind', created: new Date().toISOString(), source: 'audio', status: 'ready', bars: 102, has_audio: false, version: 1 },
  { id: 'demo-midi', title: 'Winter Wind (MIDI)', created: new Date().toISOString(), source: 'midi', status: 'ready', bars: 102, has_audio: false, version: 1 },
];
projects.push(projects.shift()!);
const docs = new Map<string, ScoreDoc>();
const undos = new Map<string, ScoreDoc[]>();
const redos = new Map<string, ScoreDoc[]>();
const histories = new Map<string, HistoryEntry[]>();
let config: LlmConfig = { configured: false, model: 'deepseek-flash', base_url: 'https://api.deepseek.com' };

async function getDoc(id: string) {
  if (!docs.has(id)) {
    const doc = copy((await fixture()).doc);
    doc.id = id;
    doc.title = projects.find(project => project.id === id)?.title ?? 'Untitled';
    doc.version = projects.find(project => project.id === id)?.version ?? 1;
    const project = projects.find(p => p.id === id);
    doc.meta.has_audio = !!project?.has_audio;
    if (project?.instruments === 'multi') {
      doc.parts!.push({ id: 'P2', name: 'Violin', program: 40, kind: 'single', clef: 'G', staves: [3] });
      const violin = doc.notes.filter(n => n.staff === 1 && n.measure < 8).map(n => ({ ...n, id: n.id + 50000, staff: 3, part: 'P2', edited: [] }));
      doc.notes.push(...violin); doc.meta.notes = doc.notes.length;
    }
    docs.set(id, doc);
  }
  return docs.get(id)!;
}

function pitchName(pitch: number, prefer = 'sharp') {
  const sharp = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const flat = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  return (prefer === 'flat' ? flat : sharp)[((pitch % 12) + 12) % 12] + (Math.floor(pitch / 12) - 1);
}

function apply(doc: ScoreDoc, op: Op, originals: Note[]) {
  if (op.op === 'resolve_review') {
    const review = doc.review.find(item => item.id === op.review_id);
    if (review) review.resolved = op.option;
    return;
  }
  if (op.op === 'set_key') {
    doc.measures[op.measure].key = op.fifths;
    return;
  }
  if (op.op === 'add_note') {
    const measure = doc.measures.findIndex(bar => op.on >= bar.start && op.on < bar.start + bar.length);
    doc.notes.push({
      ...doc.notes[0], ...op, id: 100000 + doc.notes.length, name: pitchName(op.pitch),
      measure, beat: op.on - doc.measures[measure].start, added: true, deleted: false, edited: [],
    });
    return;
  }
  const notes = doc.notes.filter(note => op.ids.includes(note.id));
  const onset = Math.min(...notes.map(note => note.on));
  const duration = Math.max(...notes.map(note => note.dur));
  for (const note of notes) {
    switch (op.op) {
      case 'set_staff':
        note.staff = op.staff;
        break;
      case 'set_voice':
        note.voice = op.voice;
        break;
      case 'set_duration':
        note.dur = op.dur;
        break;
      case 'transpose':
        note.pitch += op.semitones;
        note.name = pitchName(note.pitch);
        break;
      case 'respell':
        note.name = pitchName(note.pitch, op.prefer);
        break;
      case 'shift':
        note.on += op.delta;
        break;
      case 'set_grace':
        note.grace = op.grace;
        break;
      case 'delete':
        note.deleted = true;
        break;
      case 'restore':
        note.deleted = false;
        break;
      case 'merge_chord':
        note.on = onset;
        note.dur = duration;
        break;
      case 'reset':
        Object.assign(note, copy(originals.find(original => original.id === note.id) ?? note));
        note.edited = [];
        break;
    }
    if (op.op !== 'reset') note.edited = Array.from(new Set([...note.edited, op.op]));
  }
}

function mockUpload(body: unknown) {
  const file = (body as FormData).get('file') as File;
  const project: Project = {
    id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, ''), created: new Date().toISOString(),
    source: /\.midi?$/i.test(file.name) ? 'midi' : 'audio', status: 'queued', has_audio: !/\.midi?$/i.test(file.name), instruments: ((body as FormData).get('instruments') as 'piano' | 'multi') ?? 'piano',
    progress: { stage: 'queued', fraction: 0, message: 'Preparing fixture…' },
  };
  projects.unshift(project);
  if (project.has_audio) originalFiles.set(project.id, file);
  const stages = ['transcribing', 'analysing', 'engraving'] as const;
  stages.forEach((stage, index) => window.setTimeout(() => {
    project.status = stage;
    project.progress = { stage, fraction: (index + 1) / 4, message: `${stage[0].toUpperCase() + stage.slice(1)} fixture…` };
  }, 700 * (index + 1)));
  window.setTimeout(() => {
    project.status = 'ready';
    project.bars = 120;
  }, 3000);
  return { id: project.id, status: project.status };
}

export async function mockRequest(path: string, method: string, body: unknown): Promise<unknown> {
  if (path === '/health') return { ok: true, models_ready: models.filter(model => model.required).every(model => model.installed), version: `${version} (mock)`, cuda: true, llm: copy(config), multi: { available: true, default: 'yptf-multi-ps', models: [
    { key: 'yptf-multi-ps', label: 'YPTF+Multi (PS)' }, { key: 'moe-nops', label: 'YPTF.MoE+Multi (noPS)' }, { key: 'moe-ps', label: 'YPTF.MoE+Multi (PS)' },
    { key: 'yptf-single', label: 'YPTF+Single (noPS)' }, { key: 'ymt3+', label: 'YMT3+' }] } };
  if (path === '/models') return mockModels();
  if (path === '/models/download' && method === 'POST') {
    for (const key of (body as { keys: string[] }).keys) {
      const model = models.find(item => item.key === key);
      if (!model) throw new Error('Model not found');
      if (model.installed || !model.managed || downloads.has(key)) continue;
      model.state = 'queued'; model.progress = 0; model.error = null;
      downloads.set(key, Date.now());
    }
    return mockModels();
  }
  if (path.startsWith('/models/') && path.endsWith('/remove') && method === 'POST') {
    const model = models.find(item => item.key === decodeURIComponent(path.split('/')[2]));
    if (!model || !model.managed || model.required || downloads.has(model.key)) throw new Error('Model cannot be removed');
    model.installed = false; model.bytes = null; model.state = 'idle'; model.progress = null; model.error = null;
    return mockModels();
  }
  if (path === '/storage') {
    storageStarted ??= Date.now();
    const items = projects.map(project => ({ ...copy(project), bytes: (project.source === 'audio' ? 24 : 2) * 1024 ** 2 }));
    const projectBytes = items.reduce((sum, item) => sum + item.bytes, 0);
    const modelBytes = models.reduce((sum, model) => sum + (model.installed ? model.bytes ?? model.download_bytes ?? 0 : 0), 0);
    const appBytes = modelScenario === 'calculating' && Date.now() - storageStarted < 2500 ? null : Math.round(0.8 * GiB);
    return { data_dir: modelScenario === 'docker' ? '/data/score-studio' : 'C:\\Users\\Tommy\\AppData\\Local\\ScoreStudio\\data',
      disk_free: 128 * GiB - projectBytes - modelBytes, disk_total: 256 * GiB,
      projects: { bytes: projectBytes, count: items.length, items }, models: { bytes: modelBytes }, app: { bytes: appBytes } };
  }
  if (path === '/projects/delete' && method === 'POST') {
    const target = body as { all?: boolean; ids?: string[] };
    const ids = projects.filter(project => target.all || target.ids?.includes(project.id)).map(project => project.id);
    for (const id of ids) {
      projects.splice(projects.findIndex(project => project.id === id), 1);
      originalFiles.delete(id);
      for (const collection of [docs, undos, redos, histories]) collection.delete(id);
    }
    return { deleted: ids.length };
  }
  if (path === '/instruments') return copy(instruments);
  if (path === '/performance') {
    if (method === 'PUT') {
      const patch = body as Partial<PerfSettings>;
      Object.assign(performanceSettings, patch);
      if (patch.preset && patch.preset !== 'custom') {
        const preset = performancePresets[patch.preset];
        performanceSettings.cores = [...preset.cores];
        performanceSettings.priority = patch.priority ?? preset.priority;
      }
    }
    return mockPerformance();
  }
  if (path === '/config/llm') {
    if (method === 'PUT') {
      const values = body as Partial<LlmConfig> & { api_key?: string };
      config = {
        model: values.model ?? config.model,
        base_url: values.base_url ?? config.base_url,
        configured: values.api_key !== undefined ? !!values.api_key : config.configured,
      };
    }
    return copy(config);
  }
  if (path === '/projects') {
    if (method === 'POST' && models.some(model => model.required && !model.installed)) throw new Error('Required models are missing. Download models in Settings › Storage.');
    return method === 'POST' ? mockUpload(body) : copy(projects);
  }
  const [, , id, route] = path.split('/');
  const project = projects.find(item => item.id === id);
  if (!project) throw new Error('Project not found');
  if (!route) {
    if (method === 'DELETE') {
      originalFiles.delete(id);
      projects.splice(projects.indexOf(project), 1);
      for (const collection of [docs, undos, redos, histories]) collection.delete(id);
      return;
    }
    if (method === 'PATCH') {
      const patch = body as { title?: string; header?: Partial<ScoreHeader>; parts?: PartOverrides };
      if (patch.title) project.title = patch.title;
      const current = await getDoc(id);
      current.title = project.title;
      if (patch.parts) {
        const originals = (await fixture()).doc.parts!;
        current.parts = current.parts?.map(part => {
          if (!(part.id in patch.parts!)) return part;
          const update = patch.parts![part.id];
          const original = originals.find(p => p.id === part.id) ?? { ...part, name: 'Violin', program: 40, clef: 'G' };
          return update === null ? copy(original) : { ...part, ...update, ...(part.kind === 'grand' ? { clef: part.clef } : {}) };
        });
        current.version++; project.version = current.version;
        project.parts = current.parts?.map(part => ({ id: part.id, name: part.name, notes: current.notes.filter(n => n.part === part.id).length }));
      }
      if (patch.header) {
        current.header = { ...DEFAULT_HEADER, ...current.header, ...patch.header };
        current.version += 1;
        project.version = current.version;
      }
    }
    return copy(project);
  }

  let doc = await getDoc(id);
  if (route === 'retry') {
    project.instruments = (body as { instruments: 'piano' | 'multi' }).instruments;
    project.parts = null;
    project.version = (project.version ?? 1) + 1;
    project.status = 'transcribing';
    project.progress = { stage: 'transcribing', fraction: 0.2, message: 'Preparing fixture…' };
    for (const collection of [docs, undos, redos, histories]) collection.delete(id);
    setTimeout(() => { project.status = 'ready'; project.progress = undefined; }, 900);
    return copy(project);
  }
  if (route === 'doc') return copy(doc);
  if (route === 'history') return copy(histories.get(id) ?? []);
  if (route === 'assistant') {
    const request = body as AssistantRequest;
    if (!config.configured) throw new Error('Configure the assistant first');
    return {
      reply: 'The selected passage can use a single inner voice. Preview the notes before applying.',
      proposals: [{
        title: 'Simplify the inner voice', explanation: 'Assign the selected passage to voice 1.',
        ops: [{ op: 'set_voice', ids: request.note_ids?.length ? request.note_ids : openingLeftHand(doc), voice: 1 }],
        valid: true, error: null,
      }],
    };
  }
  if (route === 'undo' || route === 'redo') {
    const from = route === 'undo' ? undos : redos;
    const to = route === 'undo' ? redos : undos;
    const previous = from.get(id)?.pop();
    if (previous) {
      to.set(id, [...to.get(id) ?? [], copy(doc)]);
      previous.version = doc.version + 1;
      previous.title = project.title;
      doc = previous;
      docs.set(id, doc);
    }
  } else if (route === 'edits' || route === 'settings') {
    undos.set(id, [...undos.get(id) ?? [], copy(doc)]);
    redos.set(id, []);
    if (route === 'settings') Object.assign(doc.settings, body);
    else {
      const request = body as { ops: Op[]; label?: string };
      const originals = (await fixture()).doc.notes;
      request.ops.forEach(op => apply(doc, op, originals));
      histories.set(id, [...histories.get(id) ?? [], {
        index: doc.history.edits, label: request.label ?? 'Edit notes', ops: request.ops, time: new Date().toISOString(),
      }]);
    }
    doc.version += 1;
    doc.history.edits += 1;
  } else throw new Error(`Unknown mock route: ${route}`);
  doc.history.can_undo = !!undos.get(id)?.length;
  doc.history.can_redo = !!redos.get(id)?.length;
  project.version = doc.version;
  return copy(doc);
}

export function mockMidi(doc: ScoreDoc) {
  const midi = new Midi();
  midi.header.setTempo(doc.meta.tempo);
  for (const part of doc.parts ?? []) {
    const track = midi.addTrack();
    track.instrument.number = part.program; track.name = part.name;
    for (const note of doc.notes.filter(note => !note.deleted && part.staves.includes(note.staff))) {
      track.addNote({
        midi: note.pitch, time: note.on * 60 / doc.meta.tempo,
        duration: Math.max(0.05, note.dur * 60 / doc.meta.tempo), velocity: note.velocity / 127,
      });
    }
  }
  return midi;
}
