import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { DesktopModelSelection, DesktopOrchestrationMode, DesktopWorkflowState } from '../shared/contract';
import type { NavigationSelection } from './navigation';
import type { Snapshot } from './desktop-types';
import { mergeRoutePreference, routePreferenceStore } from './app-route-preference';
import { navigationKey } from './text-format';
import {
  type DraftPanePrefs,
  type ResolvedDraftPrefs,
  draftModelSelectionFromSnapshot,
  emptyDraftPanePrefs,
  readStoredDraftPaneEntries,
  readStoredLastNewTaskPrefs,
  rememberSnapshotModelSeed,
  reresolveDraftEntries,
  reresolvedLastNewTaskPrefs,
  resolveDraftPrefs,
  stagedLastNewTaskPrefs,
  writeStoredDraftPanePrefs,
} from './draft-pane-prefs-store';
import { useFocusedDraftRoute } from './use-focused-draft-route';

export {
  type DraftPanePrefs,
  type ResolvedDraftPrefs,
  draftModelSelectionFromSnapshot,
  resolvedStoredProjectPath,
} from './draft-pane-prefs-store';

/** The prefs-map key of a focused draft; '' while a session pane owns focus. */
const focusedDraftKey = (selection: NavigationSelection): string =>
  selection.kind === 'new' ? selection.draftId || 'default' : '';

export function useDraftPanePreferences({
  selection,
  selectionRef,
  snapshot,
  projectCatalogValidated,
  preferredDraftProjectPath,
  effectiveDraftProjectPath,
}: {
  selection: NavigationSelection;
  selectionRef: MutableRefObject<NavigationSelection>;
  snapshot: Snapshot;
  projectCatalogValidated: boolean;
  preferredDraftProjectPath: string;
  effectiveDraftProjectPath(candidate: unknown): string;
}) {
  const [newTaskDeferred, setNewTaskDeferred] = useState(false);
  // Per-draft-tab prefs (user requirement: every pane manages its OWN
  // project/model/workflow). The focused-route singletons always mirror the
  // FOCUSED draft (submit path unchanged); this map keeps each draftId's
  // staged values so switching drafts restores them and non-focused draft
  // panes render their own chrome instead of the focused draft's.
  const focused = useFocusedDraftRoute();
  const {
    paint: paintFocusedDraft,
    setProjectPath: setNewTaskProjectPath,
    setModelSelection: setNewTaskModelSelection,
    setWorkflow: setNewTaskWorkflow,
  } = focused;
  const draftPanePrefs = useRef(new Map<string, DraftPanePrefs>());
  const [, setDraftPrefsVersion] = useState(0);
  const repaintDrafts = useCallback(() => setDraftPrefsVersion((value) => value + 1), []);
  // The LAST staged model/workflow/project (any draft, persisted): every NEW
  // draft seeds from it (user rule: a new task reuses the last cached
  // settings; each pane then diverges independently).
  const lastNewTaskPrefs = useRef<DraftPanePrefs | null>(null);
  const draftSnapshotModelSeeds = useRef(new Map<string, DesktopModelSelection>());
  // Before the user explicitly changes a draft route, the engine snapshot is
  // still its authoritative default. Preserve that route in the same prefs
  // chain so unfocused panes (whose lane snapshot is intentionally empty)
  // render exactly what the focused pane renders.
  const snapshotDraftModelSelection = useMemo(
    // ONLY while the engine snapshot actually owns the draft: a blank engine
    // (no session id) is the new task's own route. A draft focused while the
    // engine still runs the PREVIOUS session must never inherit — let alone
    // freeze — that unrelated session's model.
    () =>
      selection.kind === 'new' && !String(snapshot.sessionId || '') ? draftModelSelectionFromSnapshot(snapshot) : null,
    [
      selection.kind,
      snapshot.sessionId,
      snapshot.effort,
      snapshot.fast,
      snapshot.modelParameters,
      snapshot.model,
      snapshot.provider,
    ]
  );
  const inheritedDraftPrefs = useCallback((): ResolvedDraftPrefs => {
    const last = lastNewTaskPrefs.current;
    return {
      // An explicit empty path means No project and must not fall through to a
      // previous non-empty value. With no saved preference, seed the registry's
      // most recently selected project.
      projectPath: effectiveDraftProjectPath(
        last?.projectPath ?? (focused.projectPathRef.current || preferredDraftProjectPath)
      ),
      // The last cached settings win over the focused-draft singletons: the
      // singletons may still mirror an old parked draft, while a genuinely
      // new task must reuse the LAST cached settings (user rule). Every
      // explicit staging also updates lastNewTaskPrefs, so this order never
      // loses fresh data.
      modelSelection: last?.modelSelection ?? focused.modelSelectionRef.current ?? snapshotDraftModelSelection,
      workflow: last?.workflow ?? focused.workflowRef.current ?? null,
      orchestrationMode: last?.orchestrationMode ?? null,
    };
  }, [
    effectiveDraftProjectPath,
    focused.modelSelectionRef,
    focused.projectPathRef,
    focused.workflowRef,
    preferredDraftProjectPath,
    snapshotDraftModelSelection,
  ]);
  const resolvedDraftPrefsFor = useCallback(
    (draftKey: string): ResolvedDraftPrefs => {
      rememberSnapshotModelSeed(draftSnapshotModelSeeds.current, draftKey, snapshotDraftModelSelection);
      return resolveDraftPrefs({
        entry: draftKey ? draftPanePrefs.current.get(draftKey) : undefined,
        last: lastNewTaskPrefs.current,
        seed: draftKey ? draftSnapshotModelSeeds.current.get(draftKey) : undefined,
        snapshotDraftModelSelection,
        preferredDraftProjectPath,
        effectiveDraftProjectPath,
      });
    },
    [effectiveDraftProjectPath, preferredDraftProjectPath, snapshotDraftModelSelection]
  );
  const persistDraftPanePrefs = useCallback(() => {
    try {
      writeStoredDraftPanePrefs(draftPanePrefs.current, lastNewTaskPrefs.current);
    } catch {
      /* best-effort */
    }
  }, []);
  const rememberDraftPanePrefs = useCallback(
    (patch: Partial<DraftPanePrefs>) => {
      const draftKey = focusedDraftKey(selectionRef.current);
      if (!draftKey) return;
      // A first-touch entry stays null-valued (inherit live): only the fields
      // the user explicitly stages freeze on this pane.
      const entry = draftPanePrefs.current.get(draftKey) ?? emptyDraftPanePrefs();
      // Refresh insertion order so the persistence cap drops the oldest drafts.
      draftPanePrefs.current.delete(draftKey);
      draftPanePrefs.current.set(draftKey, { ...entry, ...patch });
      lastNewTaskPrefs.current = stagedLastNewTaskPrefs(lastNewTaskPrefs.current, patch);
      persistDraftPanePrefs();
      repaintDrafts();
    },
    [persistDraftPanePrefs, repaintDrafts, selectionRef]
  );
  useEffect(() => {
    // Hydrate BEFORE the focused-draft restore effect below (declaration
    // order), so a restored layout's drafts reopen with their saved prefs.
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
    } catch {
      /* best-effort */
    }
  }, [persistDraftPanePrefs, repaintDrafts]);
  const stageNewTaskProject = useCallback(
    (projectPath: string) => {
      const next = String(projectPath || '').trim();
      setNewTaskProjectPath(next);
      setNewTaskDeferred(true);
      rememberDraftPanePrefs({ projectPath: next });
    },
    [rememberDraftPanePrefs, setNewTaskProjectPath]
  );
  const stageNewTaskModelSelection = useCallback(
    (selection: DesktopModelSelection) => {
      const remembered = routePreferenceStore.remember(selection);
      setNewTaskModelSelection(remembered);
      rememberDraftPanePrefs({ modelSelection: remembered });
    },
    [rememberDraftPanePrefs, setNewTaskModelSelection]
  );
  const rememberSessionRouteForNextTask = useCallback(
    (selection: DesktopModelSelection) => {
      // Same rule as staging: a route change may not materialize an inferred
      // project into the cache (on a phone that value is often not loaded yet).
      const cached = lastNewTaskPrefs.current ?? emptyDraftPanePrefs();
      const modelSelection = mergeRoutePreference(cached.modelSelection, routePreferenceStore.remember(selection));
      lastNewTaskPrefs.current = { ...cached, modelSelection };
      // A successful session route becomes the seed for every draft that has no
      // explicit model of its own; explicitly staged draft panes keep their
      // per-pane entries unchanged.
      const draftKey = focusedDraftKey(selectionRef.current);
      if (!draftKey || !draftPanePrefs.current.get(draftKey)?.modelSelection) setNewTaskModelSelection(modelSelection);
      persistDraftPanePrefs();
      // Inheriting (null-model) draft panes render the cache live: repaint them.
      repaintDrafts();
    },
    [persistDraftPanePrefs, repaintDrafts, selectionRef, setNewTaskModelSelection]
  );
  const stageNewTaskWorkflow = useCallback(
    (workflow: DesktopWorkflowState) => {
      setNewTaskWorkflow(workflow);
      rememberDraftPanePrefs({ workflow });
    },
    [rememberDraftPanePrefs, setNewTaskWorkflow]
  );
  const stageNewTaskOrchestrationMode = useCallback(
    (orchestrationMode: DesktopOrchestrationMode) => rememberDraftPanePrefs({ orchestrationMode }),
    [rememberDraftPanePrefs]
  );
  const clearNewTaskPreferences = useCallback(
    (target?: NavigationSelection) => {
      const current = target?.kind === 'new' ? target : selectionRef.current;
      const focusedOwnsTarget =
        current.kind === 'new' &&
        selectionRef.current.kind === 'new' &&
        navigationKey(selectionRef.current) === navigationKey(current);
      if (!target || focusedOwnsTarget) {
        setNewTaskModelSelection(null);
        setNewTaskWorkflow(null);
      }
      // Retire the draft's entry (materialized into a session, or torn down) —
      // but never write nulls into lastNewTaskPrefs: the just-used settings
      // stay the seed for the NEXT new task (user rule).
      const draftKey = focusedDraftKey(current);
      if (!draftKey) return;
      draftPanePrefs.current.delete(draftKey);
      // The retired draft key may be reused (the "default" draft): a stale
      // engine-derived seed would otherwise resurface in the next task.
      draftSnapshotModelSeeds.current.delete(draftKey);
      persistDraftPanePrefs();
      repaintDrafts();
    },
    [persistDraftPanePrefs, repaintDrafts, selectionRef, setNewTaskModelSelection, setNewTaskWorkflow]
  );
  const resetNewTaskDraft = useCallback(
    (projectPath: string | null) => {
      // null: nothing explicit to restore, so the project INHERITS as well —
      // opening New task before the relay catalog lands must not freeze an empty
      // choice into the entry.
      if (projectPath === null) setNewTaskDeferred(true);
      else stageNewTaskProject(projectPath);
      // A fresh draft INHERITS the last cached model/workflow instead of
      // resetting to "Select model" (user rule). The values are painted but NOT
      // staged into the entry: the draft keeps following the cache until the
      // user explicitly diverges this pane.
      paintFocusedDraft(inheritedDraftPrefs(), { projectPath: projectPath === null });
    },
    [inheritedDraftPrefs, paintFocusedDraft, stageNewTaskProject]
  );
  // Focused-draft switch: restore THAT draft's staged prefs into the working
  // singletons (or seed a first-seen draft from the inherited values), so
  // Ctrl+N tabs and pane clicks never bleed prefs into each other.
  const activeDraftKey = focusedDraftKey(selection);
  useEffect(() => {
    if (!activeDraftKey) return;
    // A null model/workflow stays INHERITED: resolution falls through to
    // the stable last-cached settings, so pane focus cannot change the
    // visible route and later session-route changes keep flowing in.
    paintFocusedDraft(resolvedDraftPrefsFor(activeDraftKey));
    if (draftPanePrefs.current.has(activeDraftKey)) return;
    // First sight of this draft: register a null-valued entry (user rule: new
    // tasks reuse the last settings). Model/workflow stay INHERITED (null) so
    // later session-route changes keep flowing in until the user explicitly
    // stages this pane, and auto-seeding never rewrites lastNewTaskPrefs
    // (which rewound the cache to stale values — user report: the last
    // session-creation model was not applied to the next New Task).
    // The PROJECT inherits on the same terms: materializing the resolved
    // value here froze whatever was known at FIRST PAINT, which on a phone
    // is an empty catalog — and "" then read as an explicit No project for
    // the rest of that draft's life.
    draftPanePrefs.current.set(activeDraftKey, emptyDraftPanePrefs());
    persistDraftPanePrefs();
    repaintDrafts();
  }, [activeDraftKey, paintFocusedDraft, persistDraftPanePrefs, repaintDrafts, resolvedDraftPrefsFor]);
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

  return {
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection: focused.modelSelection,
    newTaskProjectPath: focused.projectPath,
    newTaskWorkflow: focused.workflow,
    newTaskOrchestrationMode: activeDraftKey ? resolvedDraftPrefsFor(activeDraftKey).orchestrationMode : null,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
  };
}
