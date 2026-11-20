import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSelection } from './nav-types';
import { usePageHideFlush } from './layout-persistence';
import { isMobileRemoteSurface } from './mobile-surface';
import { filterPaneLayoutSessions, paneLeaves } from './pane-layout';
import {
  PANE_LAYOUT_KEY,
  createNewTaskPaneLeaf,
  initialPaneWorkspaceState,
  paneLayoutFileStorage,
  readStoredPaneLayout,
  safeLocalStorage,
  type PaneWorkspaceState,
} from './pane-workspace-storage';
import { reportRendererFailure } from './RendererRecovery';
import { sectionStoreFor } from './section-store';
import type { DesktopSessionSummary } from '../shared/contract';
import { isPartialCatalog } from '../shared/session-catalog';
import { isAgentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';

/** Session ids a persisted tab may address at startup. The session catalog is
 *  authoritative: a pool row never revives a Lead tab (stale rows outlive a
 *  deleted session). Only a worker session spawned by a still-listed Lead keeps
 *  its tab, because worker sessions are opened as tabs but never listed. */
export function restorableSessionIds(
  sessions: ReadonlyArray<{ id?: unknown }> | null | undefined,
  agents: ReadonlyArray<{ sessionId?: unknown; ownerSessionId?: unknown }> | null | undefined
): Set<string> {
  const known = new Set<string>();
  for (const row of Array.isArray(sessions) ? sessions : []) known.add(String(row.id || ''));
  for (const row of Array.isArray(agents) ? agents : []) {
    const sessionId = String(row.sessionId || '');
    const ownerId = String(row.ownerSessionId || '');
    if (sessionId && sessionId !== ownerId && known.has(ownerId)) known.add(sessionId);
  }
  return known;
}

type PoolRows = Parameters<typeof restorableSessionIds>[1];

function sessionIdsOf(layout: PaneWorkspaceState['layout']): string[] {
  return paneLeaves(layout).flatMap((leaf) => leaf.tabs.flatMap((tab) => (tab.kind === 'session' ? [tab.id] : [])));
}

/** Startup restore (the stored layout as the initial value, its session tabs
 *  reconciled against the catalog and the pool as they become known), the
 *  live workspace state, and debounced persistence of the tree. */
export function usePaneWorkspaceState(initialSelection: WorkspaceSelection | null) {
  const startupRestore = useRef<{
    stored: PaneWorkspaceState | null;
    mobile: boolean;
    requiresSessionValidation: boolean;
  } | null>(null);
  if (!startupRestore.current) {
    const mobile = isMobileRemoteSurface();
    const storage = safeLocalStorage();
    // Chromium can lose localStorage while the app runs; the main process keeps
    // a file copy of the layout for that. The phone never reads it.
    const raw = readStoredPaneLayout(storage) ?? (mobile ? null : readStoredPaneLayout(paneLayoutFileStorage()));
    // A phone launch is a fresh task boundary: the live page keeps its tabs
    // through transient relay reconnects, but a page restart never revives the
    // PANE/tab list from the previous run.
    const stored = mobile ? null : raw;
    if (mobile) {
      try {
        storage?.removeItem(PANE_LAYOUT_KEY);
      } catch {
        // A fresh in-memory New task still wins when storage is unavailable.
      }
    }
    startupRestore.current = {
      stored,
      mobile,
      requiresSessionValidation: Boolean(
        stored && paneLeaves(stored.layout).some((leaf) => leaf.tabs.some((tab) => tab.kind === 'session'))
      ),
    };
  }
  const restorePlan = startupRestore.current;
  // The stored layout is the initial value only, restored whole on the first
  // frame: restoring is local, so nothing waits on the core. From then on the
  // user owns the layout; an unconfirmed session tab stays in place and shows
  // its own unavailable state if its content cannot be read.
  const restorePending = false;
  const restoredFromStorage = Boolean(restorePlan.stored);
  const [state, render] = useState<PaneWorkspaceState>(() =>
    initialPaneWorkspaceState(restorePlan.stored, initialSelection)
  );
  // The workspace as it is now. A transition lands here first and is rendered
  // from here, so a handler that runs before the next render reads what the
  // handler before it did.
  const current = useRef(state);
  const setState = useCallback((transition: (prev: PaneWorkspaceState) => PaneWorkspaceState) => {
    const next = transition(current.current);
    if (next === current.current) return;
    current.current = next;
    render(next);
  }, []);

  // Bootstrap validation, once. The restored session tabs stay unresolved (kept,
  // shown, persisted) until the catalog and the pool are both known; then the
  // ones still unresolved are judged in the live tree, and the obligation ends:
  // from there on tabs close only through the session lifecycle's own rules
  // (`use-app-session-activity.ts`). A restored tab the user closes or replaces
  // first leaves the obligation; the same id reopened later is the lifecycle's.
  // Unknown is not invalid: a missing `agentPool` entry, or no sections at all,
  // leaves validation unresolved, never the UI or persistence; a published
  // empty pool is known. The session list is read once, at mount; a push
  // carries the whole catalog and, once one has arrived, outranks the mount
  // read. The pool is never requested: the core pushes it.
  const unresolved = useRef<Set<string> | null>(null);
  if (!unresolved.current) {
    unresolved.current = new Set(
      restorePlan.requiresSessionValidation && restorePlan.stored ? sessionIdsOf(restorePlan.stored.layout) : []
    );
  }
  useEffect(() => {
    const pending = unresolved.current!;
    if (!pending.size) return;
    const shown = new Set(sessionIdsOf(state.layout));
    for (const id of [...pending]) if (!shown.has(id)) pending.delete(id);
  }, [state.layout]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap validation runs once; setState is a useCallback with no dependencies
  useEffect(() => {
    const pending = unresolved.current!;
    if (!pending.size) return undefined;
    let active = true;
    let catalog: DesktopSessionSummary[] | undefined;
    let pool: PoolRows | undefined;
    let pushed = false;
    const stops: Array<(() => void) | undefined> = [];
    const finish = () => {
      active = false;
      for (const stop of stops.splice(0)) stop?.();
    };
    const validate = () => {
      if (!active || !catalog || !pool) return;
      const established = restorableSessionIds(catalog, pool);
      // An agent's home keeps its fixed id for good: emptied by a clear, the
      // catalog leaves it out, yet it is that agent's chat.
      const rejected = new Set([...pending].filter((id) => !isAgentHomeSessionId(id) && !established.has(id)));
      pending.clear();
      finish();
      if (!rejected.size) return;
      setState((prev) => {
        const keep = new Set(sessionIdsOf(prev.layout).filter((id) => !rejected.has(id)));
        const pruned = filterPaneLayoutSessions(prev.layout, keep);
        if (pruned === prev.layout) return prev;
        const layout = pruned ?? createNewTaskPaneLeaf();
        const leaves = paneLeaves(layout);
        return {
          layout,
          focusedLeafId: leaves.some((leaf) => leaf.id === prev.focusedLeafId) ? prev.focusedLeafId : leaves[0].id,
        };
      });
    };
    const takeCatalog = (rows: DesktopSessionSummary[]) => {
      catalog = rows;
      validate();
    };
    const api = window.mixdogDesktop;
    // Subscribed before the read is issued: a push that lands meanwhile is not lost.
    stops.push(
      api?.subscribeSessions?.((rows) => {
        pushed = true;
        takeCatalog(rows);
      })
    );
    const sections = sectionStoreFor(api);
    const takePool = () => {
      const entry = sections?.get('agentPool');
      pool = entry ? (entry.value as PoolRows) : undefined;
      validate();
    };
    stops.push(sections?.subscribe('agentPool', takePool));
    takePool();
    const listSessions = api?.listSessions;
    if (typeof listSessions === 'function') {
      void Promise.resolve()
        .then(listSessions)
        .then(
          (rows) => {
            // A first page is not the catalog (a pane of a later page's session would be judged missing): the whole list follows by push.
            if (active && !pushed && !isPartialCatalog(rows)) takeCatalog(rows);
          },
          (error: unknown) => {
            if (!active) return;
            reportRendererFailure('unhandled-rejection', error, {
              components: ['PaneWorkspaceRestore'],
              failureCode: 'pane-catalog-unavailable',
            });
          }
        );
    }
    return finish;
  }, []);

  const fileCopy = useRef<string | null>(null);
  const persistState = useCallback(() => {
    // The live layout, unconfirmed tabs included: they are the user's.
    const serialized = JSON.stringify(state);
    try {
      window.localStorage.setItem(PANE_LAYOUT_KEY, serialized);
    } catch {
      // Layout persistence is a convenience only.
    }
    // The main process keeps the same text in a profile file, for when
    // Chromium loses localStorage. The phone never restores tabs: no file.
    if (restorePlan.mobile || fileCopy.current === serialized) return;
    fileCopy.current = serialized;
    window.mixdogDesktop?.writePaneLayoutFile?.(serialized);
  }, [restorePlan, state]);
  usePageHideFlush(persistState);
  useEffect(() => {
    // Focus, drag and tab operations must paint before the synchronous storage
    // write. The short debounce also collapses resize/reorder bursts.
    const timer = window.setTimeout(persistState, 120);
    return () => window.clearTimeout(timer);
  }, [persistState]);

  return { state, current, setState, restorePending, restoredFromStorage };
}
