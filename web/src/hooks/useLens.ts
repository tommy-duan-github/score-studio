import { useLayoutEffect, useRef } from 'react';
import { lensFilter, lensSupported } from '../lib/lens';

let definitions: SVGDefsElement | null = null;

function getDefinitions() {
  if (definitions) return definitions;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('svg-library');
  svg.setAttribute('aria-hidden', 'true');
  definitions = document.createElementNS(svg.namespaceURI, 'defs') as SVGDefsElement;
  svg.append(definitions);
  document.body.append(svg);
  return definitions;
}

export function useLens(value: string | number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const thumb = group.querySelector<HTMLElement>('.lens-thumb')!;
    let frame = 0;
    let drag: { id: number; x: number; moved: boolean; target?: HTMLButtonElement } | null = null;
    let suppressClick = false;

    function fit(option: HTMLButtonElement) {
      const width = option.offsetWidth + 6;
      const height = option.offsetHeight + 6;
      thumb.style.width = `${width}px`;
      thumb.style.height = `${height}px`;
      thumb.style.translate = `${option.offsetLeft - 3}px ${option.offsetTop - 3}px`;
      group!.classList.toggle('lens-fallback', !lensSupported);
      if (lensSupported) {
        const id = lensFilter(getDefinitions(), width, height, height / 2);
        if (id) thumb.style.backdropFilter = `url("#${id}")`;
      }
    }

    function place() {
      const selected = group!.querySelector<HTMLButtonElement>('[aria-checked="true"], [aria-selected="true"]');
      thumb.hidden = !selected;
      if (selected) fit(selected);
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    }

    function move(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(event.clientX - drag.x) < 5) return;
      drag.moved = true;
      group!.setPointerCapture(event.pointerId);
      group!.classList.add('dragging');
      const options = Array.from(group!.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
      drag.target = options.reduce<HTMLButtonElement | undefined>((best, option) => {
        const distance = (button: HTMLButtonElement) => {
          const box = button.getBoundingClientRect();
          return Math.abs(event.clientX - box.left - box.width / 2);
        };
        return !best || distance(option) < distance(best) ? option : best;
      }, undefined);
      if (!drag.target) return;
      fit(drag.target);
      for (const option of options) option.classList.toggle('drag-target', option === drag.target);
      const box = group!.getBoundingClientRect();
      const x = Math.max(0, Math.min(group!.clientWidth - thumb.offsetWidth, event.clientX - box.left - thumb.offsetWidth / 2));
      thumb.style.translate = `${x}px ${drag.target.offsetTop - 3}px`;
    }

    function down(event: PointerEvent) {
      if (event.button !== 0 || !(event.target as Element).closest('button:not(:disabled)')) return;
      drag = { id: event.pointerId, x: event.clientX, moved: false };
    }

    function finish(event: PointerEvent) {
      if (!drag || drag.id !== event.pointerId) return;
      const { moved, target } = drag;
      drag = null;
      group!.classList.remove('dragging');
      group!.querySelectorAll('.drag-target').forEach(option => option.classList.remove('drag-target'));
      if (group!.hasPointerCapture(event.pointerId)) group!.releasePointerCapture(event.pointerId);
      if (moved) {
        if (event.type === 'pointerup') target?.click();
        suppressClick = true;
      }
      schedule();
    }

    function click(event: MouseEvent) {
      if (!suppressClick || !event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    }

    place();
    const size = new ResizeObserver(schedule);
    size.observe(group);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void document.fonts.ready.then(schedule);
    group.addEventListener('pointerdown', down);
    group.addEventListener('pointermove', move);
    group.addEventListener('pointerup', finish);
    group.addEventListener('pointercancel', finish);
    group.addEventListener('click', click, true);
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      theme.disconnect();
      group.removeEventListener('pointerdown', down);
      group.removeEventListener('pointermove', move);
      group.removeEventListener('pointerup', finish);
      group.removeEventListener('pointercancel', finish);
      group.removeEventListener('click', click, true);
    };
  }, [value]);
  return ref;
}
