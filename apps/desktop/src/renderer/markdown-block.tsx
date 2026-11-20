import { type ReactNode, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { PARKED_ATTRIBUTE, type ParkedBlocks } from './markdown-block-parking';

/** One block of a reply: its element, or while it is parked the box that
 *  stands for it (markdown-block-parking). */
export function MarkdownBlock({ id, parking, children }: { id: string; parking: ParkedBlocks; children: ReactNode }) {
  const subscribe = useCallback((listener: () => void) => parking.subscribe(id, listener), [parking, id]);
  const parked = useSyncExternalStore(subscribe, () => parking.parked(id));
  const mounted = parked === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the block's element changed when it parked or returned.
  useLayoutEffect(() => parking.sync(), [parking, mounted]);
  if (parked) {
    return (
      <div
        {...{ [PARKED_ATTRIBUTE]: id }}
        aria-hidden="true"
        style={{ height: parked.height, marginTop: parked.before, marginBottom: parked.after }}
      />
    );
  }
  return children;
}
