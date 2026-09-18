// Shared option list for the composer's workflow picker. Workflow packs change
// rarely, so one fetch serves every composer remount (session/tab switches)
// inside a short TTL.
//
// It is PERSISTED, unlike the sidebar reference cache, for one reason: the
// picker removes itself from the context row when a workspace has a single
// pack, so the count has to be known in the FIRST painted frame. A reserved
// placeholder that later resolves to "one pack" would shift the whole row —
// exactly the movement hiding the control is meant to avoid (user: 자리
// 예약되었다가 사라져도 시프트 생기는 거 아님). Only a never-seen workspace
// starts without an answer; it paints nothing and gains the control if a
// second pack really exists.
import { catalogStorageKey } from './catalog-storage-scope';
import { asRecord } from './text-format';

export type WorkflowOption = { value: string; label: string; active: boolean };

const WORKFLOW_OPTIONS_STORAGE_KEY = 'mixdog.desktop-workflow-options.v1';
const WORKFLOW_OPTIONS_MAX_AGE_MS = 300_000;

let cache: { at: number; options: WorkflowOption[] } | null = null;
const listeners = new Set<() => void>();

/** listWorkflows rows -> picker options. The stored copy is written in the
 *  same row shape, so a live response and a restored one parse identically. */
export function workflowOptions(rows: unknown): WorkflowOption[] {
  return (Array.isArray(rows) ? rows : [])
    .map((entry) => asRecord(entry))
    .map((row) => ({
      value: String(row?.id || ''),
      label: String(row?.name || row?.label || row?.id || ''),
      active: row?.active === true,
    }))
    .filter((option) => option.value);
}

/** The best answer available before any read: the live list, else the last one
 *  this workspace saw. Empty only for a workspace that has never loaded one. */
export function seededWorkflowOptions(): WorkflowOption[] {
  if (cache) return cache.options;
  try {
    return workflowOptions(
      JSON.parse(window.localStorage.getItem(catalogStorageKey(WORKFLOW_OPTIONS_STORAGE_KEY)) || 'null')
    );
  } catch {
    return [];
  }
}

/** The shared list while it is still fresh, else null: the caller reads again. */
export function freshWorkflowOptions(): WorkflowOption[] | null {
  return cache && Date.now() - cache.at < WORKFLOW_OPTIONS_MAX_AGE_MS ? cache.options : null;
}

export function storeWorkflowOptions(options: WorkflowOption[]): void {
  cache = { at: Date.now(), options };
  try {
    window.localStorage.setItem(
      catalogStorageKey(WORKFLOW_OPTIONS_STORAGE_KEY),
      JSON.stringify(options.map(({ value, label, active }) => ({ id: value, name: label, active })))
    );
  } catch {
    // The live list stays usable when browser storage is unavailable.
  }
}

/** Pack edits must not serve a stale list for the remaining TTL window. With a
 *  single-pack workspace hiding the control entirely, a created or deleted
 *  pack decides whether the picker exists at all, so mounted pickers are woken
 *  instead of waiting for a remount. */
export function invalidateWorkflowOptions(): void {
  cache = null;
  for (const listener of [...listeners]) {
    queueMicrotask(() => {
      if (listeners.has(listener)) listener();
    });
  }
}

export function subscribeWorkflowOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
