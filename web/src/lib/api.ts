import type {
  AssistantReply, AssistantRequest, Health, HistoryEntry, LlmConfig,
  Op, PerfSettings, PerfStatus, Project, ScoreDoc, ScoreHeader, Settings, Status,
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

export const api = {
  health: () => request<Health>('/health'),
  config: () => request<LlmConfig>('/config/llm'),
  configure: (body: { api_key?: string; model?: string; base_url?: string }) =>
    request<LlmConfig>('/config/llm', 'PUT', body),
  performance: () => request<PerfStatus>('/performance'),
  setPerformance: (body: Partial<PerfSettings>) => request<PerfStatus>('/performance', 'PUT', body),
  projects: () => request<Project[]>('/projects'),
  project: (id: string) => request<Project>(projectPath(id)),
  upload: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<{ id: string; status: Status }>('/projects', 'POST', body);
  },
  rename: (id: string, title: string) => request<Project>(projectPath(id), 'PATCH', { title }),
  setHeader: (id: string, header: Partial<ScoreHeader>) => request<Project>(projectPath(id), 'PATCH', { header }),
  remove: (id: string) => request<void>(projectPath(id), 'DELETE'),
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
      const { fixture } = await import('./mock');
      return (await fixture()).xml;
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
