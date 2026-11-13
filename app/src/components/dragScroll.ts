import { useEffect, type RefObject } from 'react';

/** Nächster scrollbarer Vorfahre (für das Scrollen der Seite, wenn die Tabelle selbst am Ende ist) */
function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Automatisches Scrollen beim Ziehen (Drag & Drop): nähert sich der Mauszeiger dem oberen bzw. unteren Rand des
 * Bereichs, scrollt er mit – je näher am Rand, desto schneller. Kann der Bereich nicht weiter scrollen, scrollt die Seite.
 */
export function useDragAutoScroll(ref: RefObject<HTMLElement | null>, active: boolean, edge = 80) {
  useEffect(() => {
    if (!active) return;
    let y = -1;
    let raf = 0;
    const onOver = (e: DragEvent) => { y = e.clientY; };
    const step = (dist: number) => Math.min(28, Math.ceil((edge - dist) / 3));
    const tick = () => {
      const el = ref.current;
      if (el && y >= 0) {
        const r = el.getBoundingClientRect();
        const top = Math.max(r.top, 0);
        const bottom = Math.min(r.bottom, window.innerHeight);
        let dy = 0;
        if (y < top + edge) dy = -step(Math.max(0, y - top));
        else if (y > bottom - edge) dy = step(Math.max(0, bottom - y));
        if (dy) {
          const before = el.scrollTop;
          el.scrollTop += dy;
          if (el.scrollTop === before) scrollParent(el).scrollTop += dy;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('dragover', onOver);
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('dragover', onOver); cancelAnimationFrame(raf); };
  }, [active, ref, edge]);
}
