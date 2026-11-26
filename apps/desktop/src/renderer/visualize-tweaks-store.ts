import { useSyncExternalStore } from 'react';

import type { VisualizePaneView, VisualizeTabView } from '../shared/visualize';
import { parseVisualizeTweaks, sanitizeTweakValue, type VisualizeTweak } from '../shared/visualize-tweaks';

export type VisualizeTweakDefs = { tweaks: VisualizeTweak[] } | { error: string };

const paneKey = (sessionId: string, tabId: string, pane: number): string => `${sessionId}\0${tabId}\0${pane}`;
const valuesKey = (sessionId: string, tabId: string, pane: number, version: number): string =>
  `${paneKey(sessionId, tabId, pane)}\0${version}`;

/** The version a pane's values belong to: a kept version's number, else the
 *  tab's newest (the live files). */
export const visualizeTweakVersion = (tab: VisualizeTabView, pane: VisualizePaneView): number =>
  pane.version ?? tab.versions?.at(-1)?.n ?? 0;

let defs = new Map<string, VisualizeTweakDefs>();
let values = new Map<string, Record<string, string>>();
let revision = 0;
const listeners = new Set<() => void>();

function changed(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Re-renders on any tweak change; the value is only a change counter. */
export function useVisualizeTweaksRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
    () => 0
  );
}

/** A page reported its `mx-tweaks` block text (null: it has none). */
export function setVisualizeTweakDefs(
  sessionId: string,
  tabId: string,
  pane: number,
  raw: string | null
): VisualizeTweakDefs | null {
  const key = paneKey(sessionId, tabId, pane);
  const next = raw === null ? null : parseVisualizeTweaks(raw);
  const map = new Map(defs);
  if (next) map.set(key, next);
  else map.delete(key);
  defs = map;
  changed();
  return next;
}

/** The controls the pane declared; empty when none or malformed. */
export function visualizePaneTweaks(sessionId: string, tabId: string, pane: number): VisualizeTweak[] {
  const found = defs.get(paneKey(sessionId, tabId, pane));
  return found && 'tweaks' in found ? found.tweaks : [];
}

export function visualizeTweakValues(
  sessionId: string,
  tabId: string,
  pane: number,
  version: number
): Record<string, string> {
  return values.get(valuesKey(sessionId, tabId, pane, version)) ?? {};
}

/** Set one control; an unacceptable value is refused. A value equal to the
 *  default is stored as no override. */
export function setVisualizeTweakValue(
  sessionId: string,
  tabId: string,
  pane: number,
  version: number,
  tweak: VisualizeTweak,
  raw: unknown
): boolean {
  const value = sanitizeTweakValue(tweak, raw);
  if (value === null) return false;
  const key = valuesKey(sessionId, tabId, pane, version);
  const next = { ...(values.get(key) ?? {}) };
  if (value === tweak.default) delete next[tweak.id];
  else next[tweak.id] = value;
  const map = new Map(values);
  if (Object.keys(next).length) map.set(key, next);
  else map.delete(key);
  values = map;
  changed();
  return true;
}

/** Back to the defaults: one control, or all of the pane's. */
export function resetVisualizeTweaks(
  sessionId: string,
  tabId: string,
  pane: number,
  version: number,
  id?: string
): void {
  const key = valuesKey(sessionId, tabId, pane, version);
  const current = values.get(key);
  if (!current) return;
  const map = new Map(values);
  if (id === undefined) map.delete(key);
  else {
    const { [id]: _dropped, ...rest } = current;
    if (Object.keys(rest).length) map.set(key, rest);
    else map.delete(key);
  }
  values = map;
  changed();
}

/** A tab closed (every pane), a compare pane went away (`fromPane`), or the
 *  session was deleted (no tab): what those panes declared and set goes. */
export function releaseVisualizeTweaks(sessionId: string, tabId?: string, fromPane = 0): void {
  const owned = (key: string): boolean => {
    const [session, tab, pane] = key.split('\0');
    if (session !== sessionId) return false;
    return tabId === undefined || (tab === tabId && Number(pane) >= fromPane);
  };
  const nextDefs = new Map([...defs].filter(([key]) => !owned(key)));
  const nextValues = new Map([...values].filter(([key]) => !owned(key)));
  if (nextDefs.size === defs.size && nextValues.size === values.size) return;
  defs = nextDefs;
  values = nextValues;
  changed();
}

/** Reconcile a session's stored tweaks against its surviving `tabs`: drops any
 *  tab absent from `tabs` and any pane index `>= tab.panes.length`. */
export function pruneVisualizeTweaks(sessionId: string, tabs: readonly Pick<VisualizeTabView, 'id' | 'panes'>[]): void {
  if (!tabs.length) {
    releaseVisualizeTweaks(sessionId);
    return;
  }
  const paneCounts = new Map(tabs.map((tab) => [tab.id, tab.panes.length]));
  const stale = (key: string): boolean => {
    const [session, tab, pane] = key.split('\0');
    if (session !== sessionId) return false;
    const count = paneCounts.get(tab);
    return count === undefined || Number(pane) >= count;
  };
  const nextDefs = new Map([...defs].filter(([key]) => !stale(key)));
  const nextValues = new Map([...values].filter(([key]) => !stale(key)));
  if (nextDefs.size === defs.size && nextValues.size === values.size) return;
  defs = nextDefs;
  values = nextValues;
  changed();
}

/** Test seam. */
export function resetVisualizeTweakStore(): void {
  defs = new Map();
  values = new Map();
  changed();
}
/** Whether any pane of the tab declared (valid) tweaks. */
export const visualizeTabHasTweaks = (sessionId: string, tab: VisualizeTabView): boolean =>
  tab.panes.some((_, index) => visualizePaneTweaks(sessionId, tab.id, index).length > 0);
