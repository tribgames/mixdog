// A side panel's own actions (agent profile, room info) ride the dock
// header's ⋯ menu instead of a button footer in the content. The panel
// publishes them under its pane's leaf id; the dock header row reads them.
import { useEffect, useSyncExternalStore } from 'react';

import type { DockAction } from './pane-dock-chrome';

const NONE: readonly DockAction[] = [];
const byLeaf = new Map<string, readonly DockAction[]>();
const listeners = new Set<() => void>();

function publish(leafId: string, actions: readonly DockAction[]): void {
  if (actions.length) byLeaf.set(leafId, actions);
  else if (!byLeaf.delete(leafId)) return;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Publish `actions` for the pane while `active`; withdrawn on unmount. */
export function usePublishDockPanelActions(
  leafId: string | undefined,
  active: boolean,
  actions: readonly DockAction[]
): void {
  useEffect(() => {
    if (!leafId || !active) return undefined;
    publish(leafId, actions);
    return () => publish(leafId, NONE);
  }, [leafId, active, actions]);
}

/** The actions the showing panel of this pane published. */
export function useDockPanelActions(leafId: string | undefined): readonly DockAction[] {
  return useSyncExternalStore(
    subscribe,
    () => (leafId && byLeaf.get(leafId)) || NONE,
    () => NONE
  );
}
