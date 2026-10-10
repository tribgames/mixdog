import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RecordValue } from './desktop-types';

// The app-wide Auto reasoning switch, shared by every route sheet. It is read
// once on demand (only a model that supports it asks), re-read when a sheet
// opens, and published by whichever surface changes it.
export type AutoEffortState = { installed: boolean; enabled: boolean; supported: boolean };

let current: AutoEffortState | null = null;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Publish the `autoEffort` entry of a tool-module settings answer. */
export function publishAutoEffort(settings: unknown): void {
  const entry = (settings as RecordValue | undefined)?.autoEffort as RecordValue | undefined;
  if (!entry) return;
  current = { installed: entry.installed === true, enabled: entry.enabled === true, supported: entry.supported !== false };
  for (const listener of listeners) listener();
}

export function refreshAutoEffort(): Promise<void> {
  reading ??= window.mixdogDesktop
    .invokeCapability<RecordValue>({ capability: 'getToolModuleSettings', args: [] })
    .then((result) => publishAutoEffort(result?.value))
    .catch(() => {
      /* the switch keeps its last known state */
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

export async function setAutoEffortEnabled(enabled: boolean): Promise<void> {
  const result = await window.mixdogDesktop.invokeCapability<RecordValue>({
    capability: 'setBuiltinToolEnabled',
    args: ['autoEffort', enabled],
  });
  publishAutoEffort(result?.value);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** RouteEditor's Auto props for a model: the switch shows only when the model
 *  supports it and the tool is installed; failed toggles re-read the state. */
export function useAutoEffortRoute(capable: boolean) {
  const autoEffort = useAutoEffort(capable);
  const [pending, setPending] = useState(false);
  return {
    autoEffort: capable && autoEffort?.installed && autoEffort.supported ? { enabled: autoEffort.enabled, pending } : null,
    onChangeAutoEffort: async (enabled: boolean) => {
      setPending(true);
      try {
        await setAutoEffortEnabled(enabled);
      } catch {
        await refreshAutoEffort();
      } finally {
        setPending(false);
      }
    },
    onOpenSheet: () => {
      if (capable) void refreshAutoEffort();
    },
  };
}

/** The switch state; `wanted` (the model supports it) triggers the first read. */
export function useAutoEffort(wanted: boolean): AutoEffortState | null {
  useEffect(() => {
    if (wanted && current === null) void refreshAutoEffort();
  }, [wanted]);
  return useSyncExternalStore(subscribe, () => current);
}
