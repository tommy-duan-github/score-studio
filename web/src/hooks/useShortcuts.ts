import { useEffect } from 'react';
import type { Op, ScoreDoc } from '../lib/types';
import type { Edit } from '../components/NotePanel';

interface Options {
  doc: ScoreDoc | null;
  selected: number[];
  busy: boolean;
  edit: Edit;
  undo: () => void;
  redo: () => void;
  toggle: () => void;
  clear: () => void;
}

export function useShortcuts({ doc, selected, busy, edit, undo, redo, toggle, clear }: Options) {
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], dialog, [role="menu"]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && (key === 'z' || key === 'y')) {
        event.preventDefault();
        if (busy) return;
        if ((key === 'y' || event.shiftKey) && doc?.history.can_redo) redo();
        else if (key === 'z' && !event.shiftKey && doc?.history.can_undo) undo();
        return;
      }
      if (key === 'escape') {
        clear();
        return;
      }
      if (event.code === 'Space' && !target.closest('button')) {
        event.preventDefault();
        if (!event.repeat) toggle();
        return;
      }
      if (!selected.length || busy || modifier || event.altKey) return;
      let op: Op | undefined;
      if (key === 'r' || key === 'l') op = { op: 'set_staff', ids: selected, staff: key === 'r' ? 1 : 2 };
      if (/^[1-4]$/.test(key)) op = { op: 'set_voice', ids: selected, voice: Number(key) };
      if (key === 'delete' || key === 'backspace') op = { op: 'delete', ids: selected };
      if (key === 'arrowup' || key === 'arrowdown') {
        op = { op: 'transpose', ids: selected, semitones: (key === 'arrowup' ? 1 : -1) * (event.shiftKey ? 12 : 1) };
      }
      if (op) {
        event.preventDefault();
        void edit([op]);
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
}
