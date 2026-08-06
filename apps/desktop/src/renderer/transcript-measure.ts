/**
 * OpenCode scheduleConnectedMeasure: never measure a row that has left the
 * document. ResizeObserver / ref callbacks can fire one frame after unmount
 * during virtualization, and measuring a detached node reports 0 and thrashes
 * the size cache into a one-frame height jump.
 */
export function scheduleConnectedMeasure<T extends HTMLElement>(
  element: T,
  measure: (element: T) => void,
): number {
  return window.requestAnimationFrame(() => {
    if (element.isConnected) measure(element);
  });
}

