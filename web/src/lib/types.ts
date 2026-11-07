export type Status = 'queued' | 'transcribing' | 'analysing' | 'engraving' | 'ready' | 'error';

export interface Project {
  id: string;
  title: string;
  created: string;
  source: 'audio' | 'midi';
  status: Status;
  bars?: number;
  progress?: { stage: string; fraction: number; message: string };
  error?: string | null;
  has_audio?: boolean;
  version?: number;
}

export interface Settings {
  max_voices: number;
  auto_keys: boolean;
  auto_spelling: boolean;
  auto_runs: boolean;
  hand_span: number;
  show_pedal: boolean;
  show_dynamics: boolean;
  show_tempo: boolean;
}

export interface Note {
  id: number;
  pitch: number;
  name: string;
  staff: number;
  voice: number;
  on: number;
  dur: number;
  measure: number;
  beat: number;
  grace: boolean;
  deleted: boolean;
  added: boolean;
  perf_on: number;
  perf_off: number;
  velocity: number;
  edited: string[];
}

export interface Measure {
  index: number;
  number: number;
  start: number;
  length: number;
  time: [number, number];
  key: number;
}

export interface Review {
  id: string;
  kind: string;
  priority: string;
  measures: [number, number] | null;
  question: string;
  options: { index: number; label: string; supported?: boolean; disabled?: boolean }[];
  resolved: number | null;
}

/** Title block engraved at the top of page 1 (and written to MusicXML exports). Sizes are percent of normal text. */
export interface ScoreHeader {
  /** Empty: use the project title. */
  title: string;
  subtitle: string;
  composer: string;
  title_size: number;
  subtitle_size: number;
  composer_size: number;
  show: boolean;
}

export interface ScoreDoc {
  id: string;
  title: string;
  header?: ScoreHeader;
  version: number;
  settings: Settings;
  meta: { tempo: number; bars: number; pickup: number; notes: number; has_audio: boolean };
  measures: Measure[];
  notes: Note[];
  timemap: [number, number][];
  review: Review[];
  history: { can_undo: boolean; can_redo: boolean; edits: number };
}

type NoteOp<T extends string, Fields = object> = { op: T; ids: number[] } & Fields;

export type Op =
  | NoteOp<'set_staff', { staff: 1 | 2 }>
  | NoteOp<'set_voice', { voice: number }>
  | NoteOp<'set_duration', { dur: number }>
  | NoteOp<'shift', { delta: number }>
  | NoteOp<'transpose', { semitones: number }>
  | NoteOp<'respell', { prefer: 'sharp' | 'flat' | 'auto' }>
  | NoteOp<'set_grace', { grace: boolean }>
  | NoteOp<'merge_chord' | 'delete' | 'restore' | 'reset'>
  | { op: 'add_note'; pitch: number; on: number; dur: number; staff: number; voice?: number }
  | { op: 'set_key'; measure: number; fifths: number }
  | { op: 'resolve_review'; review_id: string; option: number };

export interface LlmConfig {
  configured: boolean;
  model: string;
  base_url: string;
  key_hint?: string | null;
}

export interface Health {
  ok: boolean;
  version: string;
  cuda: boolean;
  llm: LlmConfig;
  docker?: boolean;
  mcp?: boolean;
}

export type PerfPreset = 'eco' | 'balanced' | 'full' | 'custom';
export type PerfPriority = 'normal' | 'low' | 'background';

export interface PerfSettings {
  preset: PerfPreset;
  cores: number[];
  priority: PerfPriority;
}

export interface PerfEffective {
  cores: number[];
  threads: number;
  priority: PerfPriority;
  nice: number;
}

export interface PerfStatus {
  settings: PerfSettings;
  effective: PerfEffective;
  presets: Record<Exclude<PerfPreset, 'custom'>, PerfEffective>;
  system: {
    platform: string;
    docker: boolean;
    logical_cpus: number;
    allowed_cores: number[];
    cpu_quota: number | null;
    memory_limit: number | null;
    memory_total: number;
    memory_available: number;
    can_raise_priority: boolean;
  };
  usage: {
    per_core: number[];
    server_cpu: number;
    server_rss: number;
    job: { project: string; pid: number; started: string; cpu?: number; rss?: number } | null;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Proposal {
  title: string;
  explanation: string;
  ops: Op[];
  valid: boolean;
  error: string | null;
}

export interface AssistantReply {
  reply: string;
  proposals: Proposal[];
}

export interface AssistantRequest {
  message: string;
  note_ids?: number[];
  measures?: [number, number];
  history: ChatMessage[];
}

export interface HistoryEntry {
  index: number;
  label: string;
  ops: Op[];
  time: string;
}
