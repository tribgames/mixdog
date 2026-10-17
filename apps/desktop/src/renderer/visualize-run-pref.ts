// "Run agent pages immediately" on a paired remote device: off by default, an
// agent page there renders without scripts until the user taps Run. A user who
// trusts their agent's pages turns this on to run them at once, like the
// desktop window. Stored in this device's localStorage only (never synced to
// the host or other devices); a change reaches every mounted panel.
import { useSyncExternalStore } from 'react';

import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';

export const VISUALIZE_RUN_PAGES_STORAGE_KEY = 'mixdog:visualize-run-agent-pages';

const listeners = new Set<() => void>();

// Session-only value used when a storage write failed.
let memoryFallback: boolean | null = null;

export function readVisualizeRunPages(): boolean {
  if (memoryFallback !== null) return memoryFallback;
  try {
    return window.localStorage.getItem(VISUALIZE_RUN_PAGES_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setVisualizeRunPages(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(VISUALIZE_RUN_PAGES_STORAGE_KEY, 'true');
    else window.localStorage.removeItem(VISUALIZE_RUN_PAGES_STORAGE_KEY);
    memoryFallback = null;
  } catch {
    // Storage unavailable: the choice then lasts only until reload.
    memoryFallback = on;
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === VISUALIZE_RUN_PAGES_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Whether agent pages run without the Run tap on this device. */
export function useVisualizeRunPages(): boolean {
  return useSyncExternalStore(subscribe, readVisualizeRunPages, () => false);
}

/** The ⋯ checkbox item (remote devices only). Call `useVisualizeRunPages` in
 *  the same component so the item re-renders when the preference flips. */
export function visualizeRunPagesAction(): DockAction {
  const on = readVisualizeRunPages();
  return {
    id: 'run-agent-pages',
    label: t('Run agent pages immediately'),
    checked: on,
    checkbox: true,
    onSelect: () => setVisualizeRunPages(!on),
  };
}
