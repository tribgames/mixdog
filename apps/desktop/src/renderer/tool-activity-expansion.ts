import { useEffect, useState } from 'react';
import type { TranscriptItem } from './desktop-types';
import { desktopToolActivitySurface } from './transcript-tool-core';

/** How much of a turn's tool activity starts open: nothing, the command runs
 *  and file changes, or every call. Open calls show a short preview first. */
export type ToolActivityExpansion = 'collapsed' | 'commands' | 'all';

const STORAGE_KEY = 'mixdog.desktop.tool-activity-expansion.v1';
const CHANGE_EVENT = 'mixdog:tool-activity-expansion';
const EXPANDING_CALLS = new Set([
  'shell',
  'bash',
  'bash_session',
  'shell_command',
  'job_wait',
  'git',
  'edit',
  'apply_patch',
]);

/** The mode rows open by, and the key their remembered toggles live under:
 *  every Ctrl+O press starts a fresh view, so rows closed by hand in an
 *  earlier one never keep "everything" from opening. */
export interface ToolActivityView {
  mode: ToolActivityExpansion;
  key: string;
}

// Ctrl+O flips this window's view without touching the saved setting.
let override: ToolActivityView | null = null;
let overrideCount = 0;
let currentView: ToolActivityView | null = null;

export function storedToolActivityExpansion(): ToolActivityExpansion {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'commands' || value === 'all' ? value : 'collapsed';
  } catch {
    return 'collapsed';
  }
}

/** Stable while nothing changed, so a re-read never re-renders the transcript. */
function effectiveToolActivityView(): ToolActivityView {
  const stored = storedToolActivityExpansion();
  const next = override ?? { mode: stored, key: stored };
  if (currentView?.mode !== next.mode || currentView.key !== next.key) currentView = next;
  return currentView;
}

function publish(): void {
  window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT));
}

export function setToolActivityExpansion(value: ToolActivityExpansion): void {
  override = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    console.warn('Could not persist tool activity expansion', error);
  }
  publish();
}

/** Everything open, or back to the saved setting (closed when that is already
 *  everything). */
export function toggleToolActivityExpandAll(): void {
  const stored = storedToolActivityExpansion();
  let next: ToolActivityExpansion = 'all';
  if (effectiveToolActivityView().mode === 'all') next = stored === 'all' ? 'collapsed' : stored;
  overrideCount += 1;
  override = next === stored ? null : { mode: next, key: `${next}~${overrideCount}` };
  publish();
}

function useExpansionValue<T>(read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const sync = () => setValue(read());
    const stored = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) sync();
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', stored);
    };
  }, [read]);
  return value;
}

/** The expansion the transcript renders with, Ctrl+O included. */
export function useToolActivityView(): ToolActivityView {
  return useExpansionValue(effectiveToolActivityView);
}

/** The saved setting, as Settings shows it. */
export function useStoredToolActivityExpansion(): ToolActivityExpansion {
  return useExpansionValue(storedToolActivityExpansion);
}

export function toolActivityCallExpands(item: TranscriptItem, mode: ToolActivityExpansion): boolean {
  if (mode === 'all') return true;
  return mode === 'commands' && EXPANDING_CALLS.has(desktopToolActivitySurface(item.name, item.args).normalizedName);
}
