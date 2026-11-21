import { useRef } from 'react';
import { createSideFileGuard, type OpenFileTab } from '../side-file-guard';
import { useStableEvent } from '../use-stable-event';

type SideFileGuard = ReturnType<typeof createSideFileGuard>;

export function useSideFileGuardOpeners(openFileTabRaw: OpenFileTab) {
  const sideFileGuardRef = useRef<SideFileGuard | null>(null);
  const openFileTab = useStableEvent<Parameters<OpenFileTab>, void>((...args) =>
    sideFileGuardRef.current ? sideFileGuardRef.current.openFileTab(...args) : openFileTabRaw(...args)
  );
  const openFileInSideDock = useStableEvent<Parameters<SideFileGuard['openFileInSideDock']>, void>((...args) =>
    sideFileGuardRef.current?.openFileInSideDock(...args)
  );
  const openPreviewToSide = useStableEvent<Parameters<SideFileGuard['openPreviewToSide']>, void>((...args) =>
    sideFileGuardRef.current?.openPreviewToSide(...args)
  );
  return { sideFileGuardRef, openFileTab, openFileInSideDock, openPreviewToSide };
}

/** Builds the guard for this render and publishes it to the openers. */
export function bindSideFileGuard(
  sideFileGuardRef: { current: SideFileGuard | null },
  deps: Parameters<typeof createSideFileGuard>[0]
): SideFileGuard {
  const guard = createSideFileGuard(deps);
  sideFileGuardRef.current = guard;
  return guard;
}
