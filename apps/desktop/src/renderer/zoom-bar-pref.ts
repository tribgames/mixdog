// The one "show the zoom bar" preference shared by every panel that has a
// ZoomPill (browser, image/PDF/document previews, Visualize). Stored in
// localStorage; a change reaches every mounted panel (and other windows).
// Off hides the pill only - keyboard and wheel zoom keep working.
import { useSyncExternalStore } from 'react';

import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';

export const ZOOM_BAR_STORAGE_KEY = 'mixdog:zoom-bar-visible';

const listeners = new Set<() => void>();

// Session-only value used when a storage write failed.
let memoryFallback: boolean | null = null;

export function readZoomBarVisible(): boolean {
  if (memoryFallback !== null) return memoryFallback;
  try {
    return window.localStorage.getItem(ZOOM_BAR_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setZoomBarVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(ZOOM_BAR_STORAGE_KEY, String(visible));
    memoryFallback = null;
  } catch {
    // Storage unavailable: the choice then lasts only until reload.
    memoryFallback = visible;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ZOOM_BAR_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Whether the zoom bar shows; re-renders the caller when the preference changes. */
export function useZoomBarVisible(): boolean {
  return useSyncExternalStore(subscribe, readZoomBarVisible, () => true);
}

/** The ⋯ checkbox item every in-scope panel carries. Call `useZoomBarVisible`
 *  in the same component so the item re-renders when the preference flips. */
export function zoomBarAction(separatorBefore = false): DockAction {
  const visible = readZoomBarVisible();
  return {
    id: 'zoom-bar',
    label: t('Zoom bar'),
    checked: visible,
    checkbox: true,
    separatorBefore,
    onSelect: () => setZoomBarVisible(!visible),
  };
}
