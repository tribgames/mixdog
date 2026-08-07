// Session catalog freshness, extracted from App.tsx: the sidebar list state,
// the optimistic rename/archive/delete overlay, and the three ways a fresh catalog
// arrives (initial/manual refresh, main-process push, safety-net poll).
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { DesktopSessionSummary } from "../shared/contract";
import {
  mergeSessionCatalogPushRows,
  mergeSessionCatalogRows,
} from "../shared/session-catalog";
import {
  readCachedSessionCatalog,
  scheduleCachedSessionCatalogWrite,
} from "./session-catalog-cache";

/** Push is the primary freshness path; the poll only guards hosts without it
 *  (the remote browser shim). */
const FALLBACK_POLL_INTERVAL_MS = 15_000;

export interface SessionCatalog {
  sessions: DesktopSessionSummary[];
  setSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  /** Sessions renamed locally but not yet reconciled with the engine. */
  pendingRenames: React.MutableRefObject<Map<string, { title: string }>>;
  /** Sessions archived/restored locally but not yet reconciled with the engine. */
  pendingArchives: React.MutableRefObject<Map<string, { archived: boolean }>>;
  /** Sessions deleted locally but not yet gone from the engine listing. */
  pendingDeletes: React.MutableRefObject<Set<string>>;
  /** Drop in-flight list responses so a local optimistic change is not undone. */
  invalidateInFlight: () => void;
}

export function useSessionCatalog(
  reconcileUnreadSessions: (rows: DesktopSessionSummary[]) => void,
): SessionCatalog {
  // Paint the durable presentation cache on the first render. It never makes
  // a session addressable: pane/session reads still validate the exact record,
  // and the incremental host catalog replaces stale rows in the background.
  const [sessions, setSessionsState] = useState<DesktopSessionSummary[]>(
    readCachedSessionCatalog,
  );
  const sessionsRef = useRef<DesktopSessionSummary[]>(sessions);
  const pendingRenames = useRef(new Map<string, { title: string }>());
  const pendingArchives = useRef(new Map<string, { archived: boolean }>());
  const pendingDeletes = useRef(new Set<string>());
  const refreshVersion = useRef(0);

  const invalidateInFlight = useCallback(() => { refreshVersion.current += 1; }, []);

  // Engine rows carry no knowledge of a local mutation still in flight, so the
  // optimistic title/archive/removal is re-applied on top of every catalog.
  const projectSessionRows = useCallback((next: DesktopSessionSummary[] | null | undefined) => (
    (Array.isArray(next) ? next : [])
      .filter((session) => !pendingDeletes.current.has(session.id))
      .map((session) => {
        const rename = pendingRenames.current.get(session.id);
        const archive = pendingArchives.current.get(session.id);
        if (!rename && !archive) return session;
        return {
          ...session,
          ...(rename ? { title: rename.title } : {}),
          ...(archive ? { archived: archive.archived } : {}),
        };
      })
  ), []);

  const setSessions = useCallback<Dispatch<SetStateAction<DesktopSessionSummary[]>>>((update) => {
    const current = sessionsRef.current;
    const proposed = typeof update === "function"
      ? update(current)
      : update;
    const merged = mergeSessionCatalogRows(current, proposed);
    if (merged === current) return;
    sessionsRef.current = merged;
    setSessionsState(merged);
  }, []);

  const commitProjectedRows = useCallback((
    rows: DesktopSessionSummary[],
    lowPriority: boolean,
  ): DesktopSessionSummary[] => {
    const current = sessionsRef.current;
    const merged = lowPriority
      ? mergeSessionCatalogPushRows(current, rows)
      : mergeSessionCatalogRows(current, rows);
    if (merged === current) return current;
    sessionsRef.current = merged;
    scheduleCachedSessionCatalogWrite(merged);
    const publish = () => setSessionsState(() => sessionsRef.current);
    if (lowPriority) startTransition(publish);
    else publish();
    reconcileUnreadSessions(merged);
    return merged;
  }, [reconcileUnreadSessions]);

  const refreshSessions = useCallback(async () => {
    const host = window.mixdogDesktop;
    if (!host?.listSessions) return [];
    const version = ++refreshVersion.current;
    const next = await host.listSessions();
    const rows = projectSessionRows(next);
    if (version === refreshVersion.current) {
      return commitProjectedRows(rows, false);
    }
    return rows;
  }, [commitProjectedRows, projectSessionRows]);

  // Push-capable desktop hosts own freshness through their store watcher.
  // Browser shims without that lane retain the bounded fallback poll.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void refreshSessions().catch(() => undefined);
    };
    const pushCapable = typeof window.mixdogDesktop?.subscribeSessions === "function";
    const timer = pushCapable
      ? undefined
      : window.setInterval(refresh, FALLBACK_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    // Schedule surfaces (Run now / save) announce new background sessions
    // immediately instead of waiting out the poll interval.
    window.addEventListener("mixdog:sessions-refresh", refresh as EventListener);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("mixdog:sessions-refresh", refresh as EventListener);
    };
  }, [refreshSessions]);

  // Instant sidebar: main watches the on-disk session store and pushes fresh
  // catalogs (~0.5s debounce), so activity from any mixdog process lands here
  // without waiting for a poll tick or an extra list round-trip.
  // NOTE: this never re-resumes. The engine owns viewer sync; re-resuming on
  // every store push swapped the transcript to the DISK state (in-flight turn
  // missing) and the live pipe swapped it back — the violent up-down shaking
  // the user saw when entering a session mid-turn.
  useEffect(() => {
    const host = window.mixdogDesktop;
    if (typeof host?.subscribeSessions !== "function") return;
    return host.subscribeSessions((next) => {
      refreshVersion.current += 1; // in-flight polls must not overwrite
      const rows = projectSessionRows(next);
      commitProjectedRows(rows, true);
    });
  }, [commitProjectedRows, projectSessionRows]);

  return {
    sessions,
    setSessions,
    refreshSessions,
    pendingRenames,
    pendingArchives,
    pendingDeletes,
    invalidateInFlight,
  };
}
