import { t } from '../lib/i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Info } from 'lucide-react';
import { useLens } from '../hooks/useLens';

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (!open || !button.current || !bubble.current) return;
    // A manual popover joins the top layer above dialog backdrops and fullscreen overlays.
    bubble.current.setAttribute('popover', 'manual');
    bubble.current.showPopover?.();
    const box = button.current.getBoundingClientRect();
    const tip = bubble.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(box.left + box.width / 2 - tip.width / 2, innerWidth - tip.width - 12));
    const below = box.bottom + 8 + tip.height <= innerHeight - 12;
    setPosition({ left, top: Math.max(12, below ? box.bottom + 8 : box.top - tip.height - 8) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  return <>
    <button
      ref={button}
      type="button"
      className="info-tip"
      aria-label={t("About {0}", [t(label)])}
      aria-describedby={open ? id : undefined}
      aria-expanded={open}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={event => {
        event.preventDefault();
        setOpen(true);
      }}
    ><Info size={15} /></button>
    {open && createPortal(
      <div ref={bubble} id={id} role="tooltip" className="tip-bubble" style={position}>{typeof children === 'string' ? t(children) : children}</div>,
      button.current?.closest('dialog[open], .reading-mode, .sidebar, .inspector') ?? document.body,
    )}
  </>;
}

export function Label({ children, tip }: { children: ReactNode; tip?: string }) {
  return <div className="field-label"><span>{typeof children === 'string' ? t(children) : children}</span>{tip && <InfoTip label={String(children)}>{t(tip)}</InfoTip>}</div>;
}

export interface SegmentOption<T> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({
  label, value, options, onChange, tabs = false, className = '', disabled = false,
}: {
  label: string;
  value?: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  tabs?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useLens(value);
  return <div
    ref={ref}
    className={`segmented lens-toggle ${className}`}
    role={tabs ? 'tablist' : 'radiogroup'}
    aria-label={t(label)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
      buttons[next]?.click();
    }}
  >
    <span className="lens-thumb" aria-hidden="true" />
    {options.map(option => <button
      key={option.value}
      type="button"
      role={tabs ? 'tab' : 'radio'}
      aria-selected={tabs ? value === option.value : undefined}
      aria-checked={tabs ? undefined : value === option.value}
      tabIndex={value === option.value || value === undefined ? 0 : -1}
      disabled={disabled || option.disabled}
      onClick={() => onChange(option.value)}
    >{typeof option.label === 'string' ? t(option.label) : option.label}</button>)}
  </div>;
}

export function Switch({ label, checked, onChange, disabled = false }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  const [value, setValue] = useState(checked);
  useEffect(() => {
    if (!disabled) setValue(checked);
  }, [checked, disabled]);
  return <label className="switch">
    <input type="checkbox" role="switch" aria-label={t(label)} checked={value} disabled={disabled}
      onChange={event => {
        setValue(event.target.checked);
        onChange(event.target.checked);
      }} />
    <span />
  </label>;
}

export function Dropdown({ label, icon, children, className = '', disabled = false, onOpen }: {
  label: string; icon?: ReactNode; children: ReactNode; className?: string; disabled?: boolean; onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={ref} className={`dropdown ${className}`}>
    <button ref={trigger} type="button" className="dropdown-trigger glass glass-pill" aria-label={t(label)}
      disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => { if (!open) onOpen?.(); setOpen(current => !current); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (!open) onOpen?.();
          setOpen(true);
        }
      }}>
      {icon}<span>{t(label)}</span><ChevronDown size={12} />
    </button>
    {open && <div id={id} className="dropdown-menu" role="menu" aria-label={t(label)}
      onClick={event => {
        if ((event.target as Element).closest('button:not(:disabled)')) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onKeyDown={event => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        } else if (event.key === 'Tab') setOpen(false);
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {children}
    </div>}
  </div>;
}

/** A glass popover panel that stays open while its controls are used (closes on outside click / Esc). */
export function Popover({ label, icon, children, className = '', open: controlled, onOpenChange }: {
  label: string; icon?: ReactNode; children: ReactNode; className?: string;
  /** Optional controlled open state (e.g. opened from elsewhere in the UI). */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (controlled === undefined) setUncontrolled(value);
    onOpenChange?.(value);
  };
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // Info tips render in a portal; interacting with them must not close the panel.
      if (!ref.current?.contains(target) && !target.closest?.('.tip-bubble')) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={ref} className={`dropdown popover ${className}`}>
    <button ref={trigger} type="button" className="dropdown-trigger glass glass-pill" aria-label={t(label)}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(current => !current)}>
      {icon}<span>{label}</span><ChevronDown size={12} />
    </button>
    {open && <div id={id} className="dropdown-menu popover-panel" role="dialog" aria-label={t(label)}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      {children}
    </div>}
  </div>;
}
