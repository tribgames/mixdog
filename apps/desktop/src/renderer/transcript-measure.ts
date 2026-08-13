/**
 * Never measure a row that has left the
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

export const TRANSCRIPT_ROW_MEASURE_EVENT = "mixdog:transcript-row-measure";

/**
 * A disclosure changes a mounted row's natural height in React's layout
 * phase. Notify the virtual timeline in that same pre-paint phase instead of
 * waiting for ResizeObserver, which otherwise leaves scrollTop and the virtual
 * spacer describing different geometry for one frame.
 */
export function requestTranscriptRowMeasure(element: HTMLElement | null): void {
  const row = element?.closest<HTMLElement>(".transcript-virtual-row");
  if (!row?.isConnected) return;
  row.dispatchEvent(new CustomEvent(TRANSCRIPT_ROW_MEASURE_EVENT, { bubbles: true }));
}

