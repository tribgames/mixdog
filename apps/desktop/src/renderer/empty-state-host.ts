/** Ref of an in-flow empty state (`.mx-empty-state`): marks the element it
 *  stands in, which 18-surface-states.css lays out as one column keeping its
 *  other children's size. */
export const EMPTY_STATE_HOST = 'data-empty-state-host';

const hosted = new WeakMap<Element, number>();

export function emptyStateHost(state: HTMLElement | null): (() => void) | undefined {
  const host = state?.parentElement;
  if (!state || !host || state.classList.contains('mx-empty-state-cover')) return undefined;
  hosted.set(host, (hosted.get(host) ?? 0) + 1);
  host.setAttribute(EMPTY_STATE_HOST, '');
  return () => {
    const left = (hosted.get(host) ?? 1) - 1;
    if (left > 0) {
      hosted.set(host, left);
      return;
    }
    hosted.delete(host);
    host.removeAttribute(EMPTY_STATE_HOST);
  };
}
