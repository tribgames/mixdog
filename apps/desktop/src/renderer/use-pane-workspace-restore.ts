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
    let stopped = false;
    let unverifiedShown = false;
    // Only a successfully READ catalog is authoritative. Cold boot: the daemon
    // catalog can lag the first paint, and a failed read must not be taken for
    // "no session exists" — that dropped EVERY persisted session tab and the
    // pruned tree was then persisted over the stored layout.
    const readCatalog = async (): Promise<Set<string> | null> => {
      const listSessions = window.mixdogDesktop?.listSessions;
      if (typeof listSessions !== 'function') return null;
      try {
        const [rows, agents] = await Promise.all([
          listSessions(),
          window.mixdogDesktop?.listAgentPool?.() ?? Promise.resolve([]),
        ]);
        return restorableSessionIds(rows, agents);
      } catch (error) {
        reportRendererFailure('unhandled-rejection', error, {
          components: ['PaneWorkspaceRestore'],
          failureCode: 'pane-catalog-unavailable',
        });
        return null;
      }
    };
    // The stored geometry with only the session tabs `addressable` vouches for
    // (file/utility/draft tabs always stay).
    const showStored = (addressable: Set<string>) => {
      const filtered = filterPaneLayoutSessions(stored.layout, addressable);
      const layout = filtered ?? createNewTaskPaneLeaf();
      const leaves = paneLeaves(layout);
      setState({
        layout,
        focusedLeafId: leaves.some((leaf) => leaf.id === stored.focusedLeafId) ? stored.focusedLeafId : leaves[0].id,
      });
      setRestoredFromStorage(filtered !== null);
      setRestorePending(false);
    };
    const restore = async () => {
      // Reconcile after first paint.
      const addressable = await readCatalog();
      if (stopped) return;
      if (!addressable) {
        // The boot cover waits for the layout to settle, so a catalog that
        // cannot be read must not hold it: show what can be addressed. The
        // stored layout stays as it is (persistState is paused until a
        // catalog read validates it) and the session list the daemon pushes
        // once it answers finishes the validation.
        if (!unverifiedShown) {
          unverifiedShown = true;
          showStored(new Set());
        }
        return;
      }
      stopped = true;
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
      showStored(addressable);
      setValidationPending(false);
    };
    void restore();
    const unsubscribeSessions = window.mixdogDesktop?.subscribeSessions?.(() => {
      if (!stopped) void restore();
    });
    return () => {
      stopped = true;
      unsubscribeSessions?.();
    };
  }, [validationPending, restorePlan]);

  const fileCopy = useRef<string | null>(null);
  const persistState = useCallback(() => {
    // Until a catalog read has validated the stored layout, `state` may only be
    // a view of it (session tabs left out): both stored copies stay untouched.
    if (validationPending) return;
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
  }, [restorePlan, validationPending, state]);
  usePageHideFlush(persistState);
  useEffect(() => {
    if (validationPending) return undefined;
    // Focus, drag and tab operations must paint before the synchronous storage
    // write. The short debounce also collapses resize/reorder bursts.
    const timer = window.setTimeout(persistState, 120);
    return () => window.clearTimeout(timer);
  }, [persistState, validationPending]);

  return { state, setState, restorePending, restoredFromStorage };
}
