import { Midi } from '@tonejs/midi';
import type {
  AssistantRequest, HistoryEntry, LlmConfig, Note, Op, Project, Review, ScoreDoc, ScoreHeader, Settings,
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
          velocity: 80, edited: [],
        });
      }
      start += length;
    });
    end = Math.max(end, start);
  });

  const doc: ScoreDoc = {
    id: 'demo', title: 'Winter Wind', version: 1, settings: copy(defaults), header: { ...DEFAULT_HEADER },
    meta: { tempo: 130, bars: measures.length, pickup: 0, notes: notes.length, has_audio: false },
    notes, measures, timemap: Array.from({ length: Math.ceil(end) + 1 }, (_, index) => [index, index * 60 / 130]),
    review: copy(reviews), history: { can_undo: false, can_redo: false, edits: 0 },
  };
  return { xml: new XMLSerializer().serializeToString(xml), doc };
}

const projects: Project[] = [
  { id: 'demo', title: 'Winter Wind', created: new Date().toISOString(), source: 'audio', status: 'ready', bars: 102, has_audio: false, version: 1 },
  { id: 'demo-midi', title: 'Winter Wind (MIDI)', created: new Date().toISOString(), source: 'midi', status: 'ready', bars: 102, has_audio: false, version: 1 },
];
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
    source: /\.midi?$/i.test(file.name) ? 'midi' : 'audio', status: 'queued', has_audio: false,
    progress: { stage: 'queued', fraction: 0, message: 'Preparing fixture…' },
  };
  projects.unshift(project);
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
  if (path === '/health') return { ok: true, version: 'mock', cuda: false, llm: copy(config) };
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
  if (path === '/projects') return method === 'POST' ? mockUpload(body) : copy(projects);
  const [, , id, route] = path.split('/');
  const project = projects.find(item => item.id === id);
  if (!project) throw new Error('Project not found');
  if (!route) {
    if (method === 'DELETE') {
      projects.splice(projects.indexOf(project), 1);
      for (const collection of [docs, undos, redos, histories]) collection.delete(id);
      return;
    }
    if (method === 'PATCH') {
      const patch = body as { title?: string; header?: Partial<ScoreHeader> };
      if (patch.title) project.title = patch.title;
      const current = await getDoc(id);
      current.title = project.title;
      if (patch.header) {
        current.header = { ...DEFAULT_HEADER, ...current.header, ...patch.header };
        current.version += 1;
        project.version = current.version;
      }
    }
    return copy(project);
  }

  let doc = await getDoc(id);
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
  for (const staff of [1, 2]) {
    const track = midi.addTrack();
    for (const note of doc.notes.filter(note => !note.deleted && note.staff === staff)) {
      track.addNote({
        midi: note.pitch, time: note.on * 60 / doc.meta.tempo,
        duration: Math.max(0.05, note.dur * 60 / doc.meta.tempo), velocity: note.velocity / 127,
      });
    }
  }
  return midi;
}
