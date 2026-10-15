import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceSelection } from './nav-types';
import { usePageHideFlush } from './layout-persistence';
import { isMobileRemoteSurface } from './mobile-surface';
import { filterPaneLayoutSessions, paneLeaves } from './pane-layout';
import {
  PANE_LAYOUT_KEY,
  createNewTaskPaneLeaf,
  initialPaneWorkspaceState,
  readStoredPaneLayout,
  safeLocalStorage,
  type PaneWorkspaceState,
} from './pane-workspace-storage';

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

/** Startup restore (session-address validation after first paint), the live
 *  workspace state, and debounced persistence of the tree. */
export function usePaneWorkspaceState(initialSelection: WorkspaceSelection | null) {
  const startupRestore = useRef<{
    stored: PaneWorkspaceState | null;
    mobile: boolean;
    requiresSessionValidation: boolean;
  } | null>(null);
  if (!startupRestore.current) {
    const mobile = isMobileRemoteSurface();
    const storage = safeLocalStorage();
    const raw = readStoredPaneLayout(storage);
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
  const [restorePending, setRestorePending] = useState(restorePlan.requiresSessionValidation && !restorePlan.mobile);
  const [validationPending, setValidationPending] = useState(restorePlan.requiresSessionValidation);
  const [restoredFromStorage, setRestoredFromStorage] = useState(
    Boolean(restorePlan.stored && (restorePlan.mobile || !restorePlan.requiresSessionValidation))
  );
  // Keep the stored split tree on the first frame. PaneWorkspace gates every
  // addressable surface while session validation runs, so geometry can restore
  // immediately without sending an unverified session id to the daemon.
  const [state, setState] = useState<PaneWorkspaceState>(() =>
    initialPaneWorkspaceState(restorePlan.stored, initialSelection)
  );

  useEffect(() => {
    const stored = restorePlan.stored;
    if (!validationPending || !stored) return undefined;
    let cancelled = false;
    const restore = async () => {
      // Reconcile after first paint. Even when the catalog is unavailable,
      // keep file/utility/draft tabs and reject only unverified session
      // addresses; persistence stays paused until this pass settles.
      let addressable = new Set<string>();
      let filtered = filterPaneLayoutSessions(stored.layout, addressable);
      const listSessions = window.mixdogDesktop?.listSessions;
      if (typeof listSessions === 'function') {
        // Cold boot: the daemon catalog can lag the first paint by seconds. A
        // failed read here used to keep the empty-set filter and silently drop
        // EVERY persisted session tab (user: 첫 부팅때 로딩이 안 되고 탭이
        // 사라진다). Only a successfully READ catalog is authoritative; retry
        // briefly before giving up on addressing persisted session tabs.
        for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
          try {
            const [rows, agents] = await Promise.all([
              listSessions(),
              window.mixdogDesktop?.listAgentPool?.() ?? Promise.resolve([]),
            ]);
            const knownSessionIds = restorableSessionIds(rows, agents);
            addressable = knownSessionIds;
            filtered = filterPaneLayoutSessions(stored.layout, knownSessionIds);
            break;
          } catch {
            // Catalog unavailable: wait and retry; after the budget, no
            // persisted session tab is safe to address (non-session tabs
            // remain available).
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
      if (cancelled) return;
      if (restorePlan.mobile) {
        // The phone has been interactive since the first frame, so prune the
        // LIVE tree instead of replaying the stored one — a tab opened or
        // switched during validation must survive.
        setState((prev) => {
          const pruned = filterPaneLayoutSessions(prev.layout, addressable) ?? createNewTaskPaneLeaf();
          if (pruned === prev.layout) return prev;
          const leaves = paneLeaves(pruned);
          return {
            layout: pruned,
            focusedLeafId: leaves.some((leaf) => leaf.id === prev.focusedLeafId) ? prev.focusedLeafId : leaves[0].id,
          };
        });
        setValidationPending(false);
        return;
      }
      const layout = filtered ?? createNewTaskPaneLeaf();
      const leaves = paneLeaves(layout);
      setState({
        layout,
        focusedLeafId: leaves.some((leaf) => leaf.id === stored.focusedLeafId) ? stored.focusedLeafId : leaves[0].id,
      });
      setRestoredFromStorage(filtered !== null);
      setRestorePending(false);
      setValidationPending(false);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [validationPending, restorePlan]);

  const persistState = useCallback(() => {
    if (restorePending) return;
    try {
      window.localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(state));
    } catch {
      // Layout persistence is a convenience only.
    }
  }, [restorePending, state]);
  usePageHideFlush(persistState);
  useEffect(() => {
    if (restorePending) return undefined;
    // Focus, drag and tab operations must paint before the synchronous storage
    // write. The short debounce also collapses resize/reorder bursts.
    const timer = window.setTimeout(persistState, 120);
    return () => window.clearTimeout(timer);
  }, [persistState, restorePending]);

  return { state, setState, restorePending, restoredFromStorage };
}
