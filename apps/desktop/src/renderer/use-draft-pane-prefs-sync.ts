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
import { newestOnly, subscribePresetsPushes } from './sidebar-reference-cache';

type DraftPrefsMap = MutableRefObject<Map<string, DraftPanePrefs>>;
type LastPrefs = MutableRefObject<DraftPanePrefs | null>;

const sameSelection = (a: DesktopModelSelection | null, b: DesktopModelSelection | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The prefs-map key of a focused draft; '' while a session pane owns focus. */
export const focusedDraftKey = (selection: NavigationSelection): string =>
  selection.kind === 'new' ? selection.draftId || 'default' : '';

export function useSnapshotDraftModelSelection(
  selectionKind: NavigationSelection['kind'],
  snapshot: Snapshot
): DesktopModelSelection | null {
  // biome-ignore lint/correctness/useExhaustiveDependencies: lists the snapshot fields the seed reads instead of the snapshot object, whose identity changes on every publication
  return useMemo(
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
    const unfollow = subscribePresetsPushes(window.mixdogDesktop, refreshHostMainRoute);
    window.addEventListener('focus', refreshHostMainRoute);
    return () => {
      unsubscribe();
      unfollow();
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
  refreshHostMainRoute,
  persistDraftPanePrefs,
  repaintDrafts,
}: {
  draftPanePrefs: DraftPrefsMap;
  lastNewTaskPrefs: LastPrefs;
  /** useHostMainRoute's ordered read of the published Lead. */
  refreshHostMainRoute(): void;
  persistDraftPanePrefs(): void;
  repaintDrafts(): void;
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
            // Skipped because another route already is the Lead route: the
            // last-used cache follows it instead of keeping the tried model.
            const next = followLeadRoute(lastNewTaskPrefs.current, tried, route);
            if (next?.modelSelection) {
              lastNewTaskPrefs.current = next;
              persistDraftPanePrefs();
            }
            // The answer can arrive after a Lead published since: the inheriting
            // drafts take the Lead through the ordered read, never this answer.
            refreshHostMainRoute();
          })
          .catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }, [persistDraftPanePrefs, refreshHostMainRoute, repaintDrafts]);
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
