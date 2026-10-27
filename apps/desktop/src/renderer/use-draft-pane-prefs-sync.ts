// What keeps the draft-pane prefs (use-draft-pane-preferences.ts) in step with
// the host: the engine snapshot's route while it owns the draft, the host's
// Main route, the persisted prefs at start-up, and the project catalog once
// validated. Each hook is called where its state sat in that hook, so the
// effects keep their declaration order (hydration before the focused-draft
// restore).
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import {
  backfillLeadRoute,
  type DraftPanePrefs,
  type ResolvedDraftPrefs,
  draftModelSelectionFromSnapshot,
  followLeadRoute,
  readHostMainRoute,
  readStoredDraftPaneEntries,
  readStoredLastNewTaskPrefs,
  reresolveDraftEntries,
  reresolvedLastNewTaskPrefs,
} from './draft-pane-prefs-store';
import type { NavigationSelection } from './navigation';
import { subscribeSetupChanges } from './setup-change-refresh';
import { newestOnly } from './sidebar-reference-cache';

type DraftPrefsMap = MutableRefObject<Map<string, DraftPanePrefs>>;
type LastPrefs = MutableRefObject<DraftPanePrefs | null>;

const sameSelection = (a: DesktopModelSelection | null, b: DesktopModelSelection | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The prefs-map key of a focused draft; '' while a session pane owns focus. */
export const focusedDraftKey = (selection: NavigationSelection): string =>
  selection.kind === 'new' ? selection.draftId || 'default' : '';

/** Before the user explicitly changes a draft route, the engine snapshot is
 *  still its authoritative default. Preserve that route in the same prefs
 *  chain so unfocused panes (whose lane snapshot is intentionally empty)
 *  render exactly what the focused pane renders. */
export function useSnapshotDraftModelSelection(
  selectionKind: NavigationSelection['kind'],
  snapshot: Snapshot
): DesktopModelSelection | null {
  // biome-ignore lint/correctness/useExhaustiveDependencies: lists the snapshot fields the seed reads instead of the snapshot object, whose identity changes on every publication
  return useMemo(
    // ONLY while the engine snapshot actually owns the draft: a blank engine
    // (no session id) is the new task's own route. A draft focused while the
    // engine still runs the PREVIOUS session must never inherit — let alone
    // freeze — that unrelated session's model.
    () =>
      selectionKind === 'new' && !String(snapshot.sessionId || '') ? draftModelSelectionFromSnapshot(snapshot) : null,
    [
      selectionKind,
      snapshot.sessionId,
      snapshot.effort,
      snapshot.fast,
      snapshot.autoEffort,
      snapshot.modelParameters,
      snapshot.model,
      snapshot.provider,
    ]
  );
}

/** The Main route the host holds. An unpicked draft paints and runs on it,
 *  never on the last-used cache (a stale effort there used to be submitted
 *  back as the Lead). Read when a draft opens, on the setup-change event the
 *  host and the Workflows/Settings editors raise, and when the window returns. */
export function useHostMainRoute({
  selectionRef,
  draftPanePrefs,
  setNewTaskModelSelection,
  repaintDrafts,
}: {
  selectionRef: MutableRefObject<NavigationSelection>;
  draftPanePrefs: DraftPrefsMap;
  setNewTaskModelSelection(selection: DesktopModelSelection | null): void;
  repaintDrafts(): void;
}) {
  const hostMainRoute = useRef<DesktopModelSelection | null>(null);
  const newest = useRef<ReturnType<typeof newestOnly> | null>(null);
  newest.current ??= newestOnly();
  const refreshHostMainRoute = useCallback(() => {
    newest
      .current?.(readHostMainRoute(window.mixdogDesktop))
      .then(({ current, value: route }) => {
        if (!current || !route || sameSelection(route, hostMainRoute.current)) return;
        hostMainRoute.current = route;
        const draftKey = focusedDraftKey(selectionRef.current);
        if (draftKey && !draftPanePrefs.current.get(draftKey)?.modelSelection) setNewTaskModelSelection(route);
        repaintDrafts();
      })
      .catch(() => {});
  }, [draftPanePrefs, repaintDrafts, selectionRef, setNewTaskModelSelection]);
  useEffect(() => {
    refreshHostMainRoute();
    const unsubscribe = subscribeSetupChanges(refreshHostMainRoute);
    window.addEventListener('focus', refreshHostMainRoute);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshHostMainRoute);
    };
  }, [refreshHostMainRoute]);
  return { hostMainRoute, refreshHostMainRoute };
}

/** Start-up: the persisted drafts and last-used prefs are read back (legacy
 *  keys rewritten at once), and the cached model is offered to the host as the
 *  Lead route; when another route already is, the inheriting drafts follow it. */
export function useHydrateDraftPrefs({
  draftPanePrefs,
  lastNewTaskPrefs,
  hostMainRoute,
  selectionRef,
  persistDraftPanePrefs,
  repaintDrafts,
  setNewTaskModelSelection,
}: {
  draftPanePrefs: DraftPrefsMap;
  lastNewTaskPrefs: LastPrefs;
  hostMainRoute: MutableRefObject<DesktopModelSelection | null>;
  selectionRef: MutableRefObject<NavigationSelection>;
  persistDraftPanePrefs(): void;
  repaintDrafts(): void;
  setNewTaskModelSelection(selection: DesktopModelSelection | null): void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the prefs and route refs are stable
  useEffect(() => {
    // Hydrate BEFORE the focused-draft restore effect (declaration order), so
    // a restored layout's drafts reopen with their saved prefs.
    try {
      const last = readStoredLastNewTaskPrefs();
      if (last.value) lastNewTaskPrefs.current = last.value;
      const entries = readStoredDraftPaneEntries();
      let changed = false;
      for (const [key, value] of entries.rows) {
        if (draftPanePrefs.current.has(key)) continue;
        draftPanePrefs.current.set(key, value);
        changed = true;
      }
      if (changed) repaintDrafts();
      // Migrated values live in memory only until something is staged: write
      // them under the current keys right away.
      if (last.legacy || entries.legacy) persistDraftPanePrefs();
      const api = window.mixdogDesktop;
      const tried = lastNewTaskPrefs.current?.modelSelection;
      if (api?.setModelRoute && tried) {
        void backfillLeadRoute({
          last: lastNewTaskPrefs.current,
          setModelRoute: (selection) => api.setModelRoute(selection) as unknown as Promise<Snapshot>,
        })
          .then(({ route }) => {
            if (route) hostMainRoute.current = route;
            // Skipped because another route already is the Lead route: the
            // drafts without an explicit pick follow it instead of the cache.
            const next = followLeadRoute(lastNewTaskPrefs.current, tried, route);
            if (!next?.modelSelection) return;
            lastNewTaskPrefs.current = next;
            const draftKey = focusedDraftKey(selectionRef.current);
            if (!draftKey || !draftPanePrefs.current.get(draftKey)?.modelSelection) {
              setNewTaskModelSelection(next.modelSelection);
            }
            persistDraftPanePrefs();
            repaintDrafts();
          })
          .catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }, [persistDraftPanePrefs, repaintDrafts, selectionRef, setNewTaskModelSelection]);
}

/** Once the project catalog is validated, every draft's (and the last-used)
 *  project resolves against it again, and the focused draft repaints its own. */
export function useReresolveDraftProjects({
  projectCatalogValidated,
  activeDraftKey,
  draftPanePrefs,
  lastNewTaskPrefs,
  effectiveDraftProjectPath,
  resolvedDraftPrefsFor,
  setNewTaskProjectPath,
  persistDraftPanePrefs,
  repaintDrafts,
}: {
  projectCatalogValidated: boolean;
  activeDraftKey: string;
  draftPanePrefs: DraftPrefsMap;
  lastNewTaskPrefs: LastPrefs;
  effectiveDraftProjectPath(candidate: unknown): string;
  resolvedDraftPrefsFor(draftKey: string): ResolvedDraftPrefs;
  setNewTaskProjectPath(projectPath: string): void;
  persistDraftPanePrefs(): void;
  repaintDrafts(): void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the prefs refs are stable
  useEffect(() => {
    if (!projectCatalogValidated) return;
    let changed = reresolveDraftEntries(draftPanePrefs.current, effectiveDraftProjectPath);
    const last = reresolvedLastNewTaskPrefs(lastNewTaskPrefs.current, effectiveDraftProjectPath);
    if (last !== lastNewTaskPrefs.current) {
      lastNewTaskPrefs.current = last;
      changed = true;
    }
    if (activeDraftKey) setNewTaskProjectPath(resolvedDraftPrefsFor(activeDraftKey).projectPath);
    if (!changed) return;
    persistDraftPanePrefs();
    repaintDrafts();
  }, [
    activeDraftKey,
    effectiveDraftProjectPath,
    persistDraftPanePrefs,
    projectCatalogValidated,
    repaintDrafts,
    resolvedDraftPrefsFor,
    setNewTaskProjectPath,
  ]);
}
