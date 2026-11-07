import { useEffect } from 'react';

export function useGlass() {
  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;
    let target: Element | null = null;
    const update = () => {
      frame = 0;
      let surface = target?.closest<HTMLElement>('.glass, .button, .chip, .icon-button');
      while (surface) {
        const box = surface.getBoundingClientRect();
        surface.style.setProperty('--mx', `${x - box.left}px`);
        surface.style.setProperty('--my', `${y - box.top}px`);
        surface = surface.parentElement?.closest<HTMLElement>('.glass') ?? null;
      }
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      x = event.clientX;
      y = event.clientY;
      target = event.target as Element;
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener('pointermove', move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
    };
  }, []);
}
