import { useState } from 'react';
import { Eye, Send } from 'lucide-react';
import { api } from '../lib/api';
import type { ChatMessage, LlmConfig, Op, Proposal, ScoreDoc } from '../lib/types';
import { InfoTip } from './Controls';
import type { Edit } from './NotePanel';

function affectedNotes(doc: ScoreDoc, ops: Op[]) {
  return Array.from(new Set(ops.flatMap(op => {
    if ('ids' in op) return op.ids;
    if (op.op === 'set_key') return doc.notes.filter(note => note.measure >= op.measure).map(note => note.id);
    if (op.op === 'resolve_review') {
      const measures = doc.review.find(item => item.id === op.review_id)?.measures;
      return doc.notes.filter(note => measures && doc.measures[note.measure]?.number >= measures[0]
        && doc.measures[note.measure]?.number <= measures[1]).map(note => note.id);
    }
    return [];
  })));
}

interface Props {
  doc: ScoreDoc;
  selected: number[];
  busy: boolean;
  config: LlmConfig | null;
  onConfig: (config: LlmConfig) => void;
  edit: Edit;
  onPreview: (ids: number[]) => void;
  onError: (message: string) => void;
}

export function AssistantPanel({ doc, selected, busy, config, onConfig, edit, onPreview, onError }: Props) {
  const [chat, setChat] = useState<(ChatMessage & { proposals?: Proposal[] })[]>([]);
  const [message, setMessage] = useState('');
  const [asking, setAsking] = useState(false);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(config?.model ?? 'deepseek-flash');
  const [base, setBase] = useState(config?.base_url ?? 'https://api.deepseek.com');
  const [applied, setApplied] = useState<string[]>([]);

  async function configure() {
    setAsking(true);
    try {
      onConfig(await api.configure({ api_key: key.trim(), model, base_url: base }));
      setKey('');
    } catch (error) {
      onError((error as Error).message);
    }
    finally {
      setAsking(false);
    }
  }

  async function ask() {
    if (!message.trim() || asking) return;
    const content = message.trim();
    const history = chat.map(({ role, content }) => ({ role, content }));
    const bars = doc.notes.filter(note => selected.includes(note.id)).map(note => doc.measures[note.measure]?.number).filter(Number.isFinite);
    setChat(current => [...current, { role: 'user', content }]);
    setMessage('');
    setAsking(true);
    try {
      const response = await api.assistant(doc.id, {
        message: content,
        note_ids: selected,
        measures: bars.length ? [Math.min(...bars), Math.max(...bars)] : undefined,
        history,
      });
      setChat(current => [...current, { role: 'assistant', content: response.reply, proposals: response.proposals }]);
    } catch (error) {
      onError((error as Error).message);
      setMessage(content);
      setChat(current => current.slice(0, -1));
    } finally {
      setAsking(false);
    }
  }

  return <div className="assistant-panel">
    <div className="panel-heading"><h2>Assistant</h2><InfoTip label="assistant">Ask about voicing, rhythm, spelling or readability. The selected note IDs, bar range and chat history are included. Preview a proposal to highlight affected notes; Apply makes one undoable edit.</InfoTip></div>
    {!config?.configured ? <form className="setup" onSubmit={event => {
      event.preventDefault();
      void configure();
    }}>
      <div className="setup-heading"><h3>Connect DeepSeek</h3><InfoTip label="DeepSeek setup">Your key is saved by your local backend. Model and base URL can be changed for a compatible endpoint.</InfoTip></div>
      <label className="field">API key<input type="password" required value={key} onChange={event => setKey(event.target.value)} autoComplete="off" placeholder="sk-…" /></label>
      <label className="field">Model<input required value={model} onChange={event => setModel(event.target.value)} /></label>
      <label className="field">Base URL<input required type="url" value={base} onChange={event => setBase(event.target.value)} /></label>
      <button className="button primary small" disabled={asking || !key.trim()}>{asking ? 'Connecting…' : 'Connect assistant'}</button>
    </form> : <>
      <div className="chat-log" aria-live="polite">
        {chat.map((entry, index) => <div className={`chat-message ${entry.role}`} key={index}>
          <small>{entry.role === 'user' ? 'You' : 'Assistant'}</small><p>{entry.content}</p>
          {entry.proposals?.map((proposal, proposalIndex) => {
            const id = `${index}:${proposalIndex}`;
            const done = applied.includes(id);
            return <article className="proposal" key={proposalIndex}>
              <h3>{proposal.title}</h3><p>{proposal.explanation}</p>
              {proposal.error && <p className="danger">{proposal.error}</p>}
              <div className="two-actions">
                <button className="button ghost small" disabled={!proposal.valid || !proposal.ops.length} onClick={() => onPreview(affectedNotes(doc, proposal.ops))}><Eye size={14} />Preview</button>
                <button className="button primary small" disabled={!proposal.valid || busy || done || !proposal.ops.length}
                  onClick={async () => {
                    if (await edit(proposal.ops, proposal.title)) {
                      onPreview([]);
                      setApplied(current => [...current, id]);
                    }
                  }}>{done ? 'Applied' : 'Apply'}</button>
              </div>
            </article>;
          })}
        </div>)}
        {asking && <div className="assistant-status" role="status">Thinking…</div>}
      </div>
      <form className="chat-compose" onSubmit={event => {
        event.preventDefault();
        void ask();
      }}>
        <div className="context-chip chip">{selected.length ? `${selected.length} notes selected` : 'Whole score'}</div>
        <label className="sr-only" htmlFor="assistant-message">Message to assistant</label>
        <textarea id="assistant-message" placeholder="Ask about the score…" value={message} onChange={event => setMessage(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void ask();
            }
          }} />
        <button className="button primary small" disabled={asking || !message.trim()}>Send message<Send size={14} /></button>
      </form>
    </>}
  </div>;
}
