import { useRef } from 'react';

export function useAnchorOverride(anchorBottomProp: boolean) {
  const anchorOverride = useRef<boolean | null>(null);
  if (anchorOverride.current === anchorBottomProp) anchorOverride.current = null;
  const shouldAnchorBottom = anchorOverride.current ?? anchorBottomProp;
  return { anchorOverride, shouldAnchorBottom };
}
