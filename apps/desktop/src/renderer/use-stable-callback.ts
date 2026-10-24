import { useCallback, useInsertionEffect, useRef } from 'react';

/** A callback with a fixed identity that always runs the latest COMMITTED
 *  `callback`. Handed to memoized children so a parent re-render does not
 *  defeat them.
 *
 *  The latest callback is published in an insertion effect, never during
 *  render: a render React abandons (suspended transition, interrupted
 *  concurrent render) must not leak its closure to the committed UI. An
 *  insertion effect, not a layout effect, because it runs before every layout
 *  effect of the commit — a child's layout effect that calls this callback
 *  already sees the callback of the render being committed. */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(callback);
  useInsertionEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
