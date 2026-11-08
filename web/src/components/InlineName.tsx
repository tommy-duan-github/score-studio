import { useLayoutEffect, useRef, useState } from 'react';

/** Names stay text until explicitly edited; blur and Enter share a single save path. */
export function InlineName({ value, label, onSave, className = '', disabled = false }: {
  value: string; label: string; onSave: (value: string) => void; className?: string; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const display = useRef<HTMLSpanElement>(null);
  const restoreFocus = useRef(false);
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; display.current?.focus(); }
  }, [editing]);
  const start = () => { if (!disabled) { settled.current = false; setEditing(true); } };
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = input.current?.value.trim();
    setEditing(false);
    if (save && next && next !== value) onSave(next);
  };
  return editing ? <input ref={input} className={`inline-name editing ${className}`} aria-label={label}
    defaultValue={value} maxLength={200} onBlur={() => finish(true)} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); restoreFocus.current = true; finish(event.key === 'Enter');
      }
    }} /> : <span ref={display} className={`inline-name ${className}`} role="button" tabIndex={disabled ? -1 : 0}
    aria-label={label} aria-disabled={disabled} onDoubleClick={start} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); start(); }
    }}>{value}</span>;
}
