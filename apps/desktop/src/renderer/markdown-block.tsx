import { Fragment, type ReactNode, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { PARKED_ATTRIBUTE, type ParkedBlocks } from './markdown-block-parking';

/** One block of a reply: its element, or while it is parked the box that
 *  stands for it (markdown-block-parking). */
export function MarkdownBlock({ id, parking, children }: { id: string; parking: ParkedBlocks; children: ReactNode }) {
  const subscribe = useCallback((listener: () => void) => parking.subscribe(id, listener), [parking, id]);
  const parked = useSyncExternalStore(subscribe, () => parking.parked(id));
  const mounted = parked === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the block's element changed when it parked or returned.
  useLayoutEffect(() => parking.sync(), [parking, mounted]);
  // Keyed apart, a block and its box are never one element: a block returning is a new element, which the observer
  // reports, even when the block's own element is a div like the box.
  if (parked) {
    return (
      <div
        key="parked"
        {...{ [PARKED_ATTRIBUTE]: id }}
        aria-hidden="true"
        style={{ height: parked.height, marginTop: parked.before, marginBottom: parked.after }}
      />
    );
  }
  return <Fragment key="mounted">{children}</Fragment>;
}
