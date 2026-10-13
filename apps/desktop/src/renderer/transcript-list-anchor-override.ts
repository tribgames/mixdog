import { useRef } from 'react';

/** Reader intent reaches the core in the SAME task it was decided in: the
 *  follow hook calls setAnchorBottomRef synchronously, and this override
 *  keeps every render until React's own state catches up agreeing with it.
 *  While the two disagreed, the core still owned the end anchor and rolled
 *  each wheel notch back by the growth of the frame it landed in. */
export function useAnchorOverride(anchorBottomProp: boolean) {
  const anchorOverride = useRef<boolean | null>(null);
  if (anchorOverride.current === anchorBottomProp) anchorOverride.current = null;
  const shouldAnchorBottom = anchorOverride.current ?? anchorBottomProp;
  return { anchorOverride, shouldAnchorBottom };
}
