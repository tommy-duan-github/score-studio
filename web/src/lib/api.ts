import type {
  AssistantReply, AssistantRequest, Health, HistoryEntry, Instruments, LlmConfig,
  Instrument, Model as StorageModel, ModelsStatus, StorageUsage, PartOverrides, Op, PerfSettings, PerfStatus, Project, ScoreDoc, ScoreHeader, Settings, Status,
} from './types';

export const MOCK = import.meta.env.VITE_MOCK === '1'
  || new URLSearchParams(location.search).get('mock') === '1';

async function checked(response: Response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return response;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import('./mock');
    return mockRequest(path, method, body) as Promise<T>;
  }
  const multipart = body instanceof FormData;
  const response = await checked(await fetch(`/api${path}`, {
    method,
    headers: body && !multipart ? { 'Content-Type': 'application/json' } : undefined,
    body: multipart ? body : body ? JSON.stringify(body) : undefined,
  }));
  return response.status === 204 ? undefined as T : response.json();
}

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
function attachmentName(response: Response, fallback: string) {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1] ?? disposition.match(/filename=([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded); } catch { /* Use the plain attachment name. */ } }
  return quoted?.trim() ?? fallback;
}

export const api = {
  health: () => request<Health>('/health'),
  models: () => request<ModelsStatus>('/models'),
  downloadModels: (keys: string[]) => request<ModelsStatus>('/models/download', 'POST', { keys }),
  removeModel: (key: StorageModel['key']) => request<ModelsStatus>(`/models/${encodeURIComponent(key)}/remove`, 'POST'),
  storage: () => request<StorageUsage>('/storage'),
  deleteProjects: (body: { ids: string[] } | { all: true }) => request<{ deleted: number }>('/projects/delete', 'POST', body),
  instruments: () => request<Instrument[]>('/instruments'),
  setParts: (id: string, parts: PartOverrides) => request<Project>(projectPath(id), 'PATCH', { parts }),
  config: () => request<LlmConfig>('/config/llm'),
  configure: (body: { api_key?: string; model?: string; base_url?: string }) =>
    request<LlmConfig>('/config/llm', 'PUT', body),
  performance: () => request<PerfStatus>('/performance'),
  setPerformance: (body: Partial<PerfSettings>) => request<PerfStatus>('/performance', 'PUT', body),
  projects: () => request<Project[]>('/projects'),
  project: (id: string) => request<Project>(projectPath(id)),
  upload: (file: File, mode?: { instruments: Instruments; model?: string }) => {
    const body = new FormData();
    body.append('file', file);
    if (mode) {
      body.append('instruments', mode.instruments);
      if (mode.instruments === 'multi' && mode.model) body.append('model', mode.model);
    }
    return request<{ id: string; status: Status }>('/projects', 'POST', body);
  },
  rename: (id: string, title: string) => request<Project>(projectPath(id), 'PATCH', { title }),
  setHeader: (id: string, header: Partial<ScoreHeader>) => request<Project>(projectPath(id), 'PATCH', { header }),
  remove: (id: string) => request<void>(projectPath(id), 'DELETE'),
  /** Transcribe again, optionally switching the instruments mode (a mode change clears the edit history). */
  retry: (id: string, mode?: { instruments: Instruments; model?: string }) =>
    request<Project>(`${projectPath(id)}/retry`, 'POST', mode),
  doc: (id: string) => request<ScoreDoc>(`${projectPath(id)}/doc`),
  settings: (id: string, body: Partial<Settings>) =>
    request<ScoreDoc>(`${projectPath(id)}/settings`, 'PUT', body),
  edit: (id: string, ops: Op[], label?: string) =>
    request<ScoreDoc>(`${projectPath(id)}/edits`, 'POST', { ops, label }),
  undo: (id: string) => request<ScoreDoc>(`${projectPath(id)}/undo`, 'POST'),
  redo: (id: string) => request<ScoreDoc>(`${projectPath(id)}/redo`, 'POST'),
  history: (id: string) => request<HistoryEntry[]>(`${projectPath(id)}/history`),
  assistant: (id: string, body: AssistantRequest) =>
    request<AssistantReply>(`${projectPath(id)}/assistant`, 'POST', body),
  xml: async (id: string, version: number) => {
    if (MOCK) {
      const { mockXml } = await import('./mock');
      return mockXml(id);
    }
    const response = await checked(await fetch(api.url(id, 'score.musicxml', version)));
    return response.text();
  },
  midi: async (doc: ScoreDoc) => {
    if (MOCK) {
      const { mockMidi } = await import('./mock');
      return new Uint8Array(mockMidi(doc).toArray()).buffer;
    }
    const response = await checked(await fetch(api.url(doc.id, 'score.mid', doc.version)));
    return response.arrayBuffer();
  },
  originalAudio: async (doc: ScoreDoc): Promise<{ blob: Blob; filename: string }> => {
    if (MOCK) {
      const { mockOriginal } = await import('./mock');
      const blob = await mockOriginal(doc);
      return { blob, filename: blob instanceof File ? `${doc.title}.${blob.name.split('.').pop()}` : `${doc.title}.wav` };
    }
    const response = await checked(await fetch(api.url(doc.id, 'export/audio')));
    return { blob: await response.blob(), filename: attachmentName(response, `${doc.title}.audio`) };
  },
  originalFilename: async (doc: ScoreDoc) => {
    if (MOCK) {
      const { mockOriginalFilename } = await import('./mock');
      return mockOriginalFilename(doc);
    }
    // The contract exposes the original extension in the attachment header, not the score document.
    const response = await checked(await fetch(api.url(doc.id, 'export/audio')));
    const filename = attachmentName(response, '');
    await response.body?.cancel();
    return filename;
  },
  url: (id: string, name: string, version?: number): string =>
    `/api${projectPath(id)}/${name}${version === undefined ? '' : `?v=${version}`}`,
};

export async function downloadScore(doc: ScoreDoc, name: 'score.musicxml' | 'score.mid') {
  let url = api.url(doc.id, `export/${name}`);
  if (MOCK) {
    const blob = name === 'score.mid'
      ? new Blob([await api.midi(doc)], { type: 'audio/midi' })
      : new Blob([await api.xml(doc.id, doc.version)], { type: 'application/vnd.recordare.musicxml+xml' });
    url = URL.createObjectURL(blob);
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = `${doc.title}.${name === 'score.mid' ? 'mid' : 'musicxml'}`;
  link.click();
  if (MOCK) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
