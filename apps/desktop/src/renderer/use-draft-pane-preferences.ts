import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { DesktopModelSelection, DesktopWorkflowState } from "../shared/contract";
import type { NavigationSelection } from "./navigation";
import type { Snapshot } from "./desktop-types";
import { mergeRoutePreference, routePreferenceStore } from "./app-route-preference";
import { asRecord, navigationKey } from "./text-format";

// v2: entries store ONLY explicitly staged fields (null = inherit live from
// the last cached settings). v1 entries materialized inherited values, which
// froze stale models onto restored/parked drafts (user report).
const DRAFT_PANE_PREFS_KEY = "mixdog.desktop-draft-pane-prefs.v2";
const LEGACY_DRAFT_PANE_PREFS_KEY = "mixdog.desktop-draft-pane-prefs.v1";
const LAST_NEW_TASK_PREFS_KEY = "mixdog.desktop-last-new-task-prefs.v1";

export type DraftPanePrefs = {
  projectPath: string;
  modelSelection: DesktopModelSelection | null;
  workflow: DesktopWorkflowState | null;
};

export const draftModelSelectionFromSnapshot = (snapshot: Snapshot): DesktopModelSelection | null => {
  const provider = String(snapshot.provider || "");
  const model = String(snapshot.model || "");
  if (!provider || !model) return null;
  const effort = String(snapshot.effort || "");
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof snapshot.fast === "boolean" ? { fast: snapshot.fast } : {}),
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
  };
};

export function useDraftPanePreferences({
  selection,
  selectionRef,
  snapshot,
  projectCatalogReady,
  preferredDraftProjectPath,
  effectiveDraftProjectPath,
}: {
  selection: NavigationSelection;
  selectionRef: MutableRefObject<NavigationSelection>;
  snapshot: Snapshot;
  projectCatalogReady: boolean;
  preferredDraftProjectPath: string;
  effectiveDraftProjectPath(candidate: unknown): string;
}) {
  const [newTaskDeferred, setNewTaskDeferred] = useState(false);
  const [newTaskProjectPath, setNewTaskProjectPath] = useState("");
  const newTaskProjectPathRef = useRef("");
  const [newTaskModelSelection, setNewTaskModelSelection] = useState<DesktopModelSelection | null>(null);
  const newTaskModelSelectionRef = useRef<DesktopModelSelection | null>(null);
  const [newTaskWorkflow, setNewTaskWorkflow] = useState<DesktopWorkflowState | null>(null);
  const newTaskWorkflowRef = useRef<DesktopWorkflowState | null>(null);
  // Per-draft-tab prefs (user requirement: every pane manages its OWN
  // project/model/workflow). The singletons above always mirror the FOCUSED
  // draft (submit path unchanged); this map keeps each draftId's staged
  // values so switching drafts restores them and non-focused draft panes
  // render their own chrome instead of the focused draft's.

  const draftPanePrefs = useRef(new Map<string, DraftPanePrefs>());
  const [, setDraftPrefsVersion] = useState(0);
  // The LAST staged model/workflow/project (any draft, persisted): every NEW
  // draft seeds from it (user rule: a new task reuses the last cached
  // settings; each pane then diverges independently).
  const lastNewTaskPrefs = useRef<DraftPanePrefs | null>(null);
  // Before the user explicitly changes a draft route, the engine snapshot is
  // still its authoritative default. Preserve that route in the same prefs
  // chain so unfocused panes (whose lane snapshot is intentionally empty)
  // render exactly what the focused pane renders.
  const snapshotDraftModelSelection = useMemo(
    // ONLY while the engine snapshot actually owns the draft: a blank engine
    // (no session id) is the new task's own route. A draft focused while the
    // engine still runs the PREVIOUS session must never inherit — let alone
    // freeze — that unrelated session's model.
    () => selection.kind === "new" && !String(snapshot.sessionId || "")
      ? draftModelSelectionFromSnapshot(snapshot)
      : null,
    [selection.kind, snapshot.sessionId, snapshot.effort, snapshot.fast, snapshot.modelParameters, snapshot.model,
      snapshot.provider],
  );
  const inheritedDraftPrefs = useCallback((): DraftPanePrefs => {
    const last = lastNewTaskPrefs.current;
    return {
      // An explicit empty path means No project and must not fall through to a
      // previous non-empty value. With no saved preference, seed the registry's
      // most recently selected project.
      projectPath: effectiveDraftProjectPath(last
        ? last.projectPath
        : newTaskProjectPathRef.current || preferredDraftProjectPath),
      // The last cached settings win over the focused-draft singletons: the
      // singletons may still mirror an old parked draft, while a genuinely
      // new task must reuse the LAST cached settings (user rule). Every
      // explicit staging also updates lastNewTaskPrefs, so this order never
      // loses fresh data.
      modelSelection: last?.modelSelection
        ?? newTaskModelSelectionRef.current
        ?? snapshotDraftModelSelection,
      workflow: last?.workflow
        ?? newTaskWorkflowRef.current ?? null,
    };
  }, [effectiveDraftProjectPath, preferredDraftProjectPath, snapshotDraftModelSelection]);
  // ONE display/restore rule for a draft's effective prefs (focused and
  // unfocused): the entry's explicit values, with unset fields inheriting the
  // last-used prefs. Without the shared rule a null-model entry showed
  // "Select model" focused while the unfocused pane showed the inherited
  // model (user report: the two states disagreed).
  // The engine-derived fallback is captured ONCE per draft: it follows the
  // FOCUSED engine and is null while a session pane owns focus, so a draft
  // with no explicit choice re-rendered a different model on every focus swap
  // and on the first public render of a freshly created New task pane.
  const draftSnapshotModelSeeds = useRef(new Map<string, DesktopModelSelection>());
  const resolvedDraftPrefsFor = useCallback((draftKey: string): DraftPanePrefs => {
    const entry = draftKey ? draftPanePrefs.current.get(draftKey) : undefined;
    const last = lastNewTaskPrefs.current;
    const projectPath = entry
      ? entry.projectPath
      : last
        ? last.projectPath
        : preferredDraftProjectPath;
    if (draftKey && snapshotDraftModelSelection
      && !draftSnapshotModelSeeds.current.has(draftKey)) {
      draftSnapshotModelSeeds.current.set(draftKey, snapshotDraftModelSelection);
      while (draftSnapshotModelSeeds.current.size > 32) {
        const oldest = draftSnapshotModelSeeds.current.keys().next().value;
        if (oldest === undefined) break;
        draftSnapshotModelSeeds.current.delete(oldest);
      }
    }
    return {
      projectPath: effectiveDraftProjectPath(projectPath),
      modelSelection: entry?.modelSelection
        ?? last?.modelSelection
        ?? (draftKey ? draftSnapshotModelSeeds.current.get(draftKey) : undefined)
        ?? snapshotDraftModelSelection,
      workflow: entry?.workflow ?? last?.workflow ?? null,
    };
  }, [effectiveDraftProjectPath, preferredDraftProjectPath, snapshotDraftModelSelection]);
  // Prefs survive reloads: without persistence a restored pane layout showed
  // fallback chrome until focused, then snapped to "Select model" because the
  // freshly-seeded entry was empty (user report).
  const persistDraftPanePrefs = useCallback(() => {
    try {
      const entries = [...draftPanePrefs.current.entries()].slice(-24);
      window.localStorage.setItem(DRAFT_PANE_PREFS_KEY, JSON.stringify(entries));
      if (lastNewTaskPrefs.current) {
        window.localStorage.setItem(LAST_NEW_TASK_PREFS_KEY,
          JSON.stringify(lastNewTaskPrefs.current));
      }
    } catch { /* best-effort */ }
  }, []);
  const rememberDraftPanePrefs = useCallback((patch: Partial<DraftPanePrefs>) => {
    const current = selectionRef.current;
    if (current.kind !== "new") return;
    const draftKey = current.draftId || "default";
    // A first-touch entry stays null-valued (inherit live): only the fields
    // the user explicitly stages freeze on this pane.
    const entry = draftPanePrefs.current.get(draftKey)
      ?? { projectPath: inheritedDraftPrefs().projectPath, modelSelection: null, workflow: null };
    const merged = { ...entry, ...patch };
    // Refresh insertion order so the persistence cap drops the oldest drafts.
    draftPanePrefs.current.delete(draftKey);
    draftPanePrefs.current.set(draftKey, merged);
    // Explicit staging updates the inheritance source for FUTURE new tasks —
    // but only the STAGED fields. Merging the whole entry rewound the cache
    // to this pane's older values (user report: the last session-creation
    // model was not cached for the next New Task).
    const last = lastNewTaskPrefs.current ?? inheritedDraftPrefs();
    lastNewTaskPrefs.current = {
      ...last,
      ...(patch.projectPath === undefined ? {} : { projectPath: patch.projectPath }),
      ...(patch.modelSelection ? { modelSelection: patch.modelSelection } : {}),
      ...(patch.workflow ? { workflow: patch.workflow } : {}),
    };
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [inheritedDraftPrefs, persistDraftPanePrefs]);
  useEffect(() => {
    // Hydrate BEFORE the focused-draft restore effect below (declaration
    // order), so a restored layout's drafts reopen with their saved prefs.
    try {
      const lastRaw = window.localStorage.getItem(LAST_NEW_TASK_PREFS_KEY);
      const lastValue = lastRaw ? asRecord(JSON.parse(lastRaw)) : null;
      if (lastValue) {
        lastNewTaskPrefs.current = {
          projectPath: typeof lastValue.projectPath === "string" ? lastValue.projectPath : "",
          modelSelection: asRecord(lastValue.modelSelection)
            ? lastValue.modelSelection as unknown as DesktopModelSelection
            : null,
          workflow: asRecord(lastValue.workflow)
            ? lastValue.workflow as unknown as DesktopWorkflowState
            : null,
        };
      }
      // v1 entries materialized inherited models; resolving them as explicit
      // choices resurfaced stale models, so they are abandoned wholesale.
      window.localStorage.removeItem(LEGACY_DRAFT_PANE_PREFS_KEY);
      const raw = window.localStorage.getItem(DRAFT_PANE_PREFS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return;
      let changed = false;
      for (const row of parsed) {
        const key = Array.isArray(row) && typeof row[0] === "string" ? row[0] : "";
        const value = Array.isArray(row) ? asRecord(row[1]) : null;
        if (!key || !value || draftPanePrefs.current.has(key)) continue;
        draftPanePrefs.current.set(key, {
          projectPath: typeof value.projectPath === "string" ? value.projectPath : "",
          modelSelection: asRecord(value.modelSelection)
            ? value.modelSelection as unknown as DesktopModelSelection
            : null,
          workflow: asRecord(value.workflow)
            ? value.workflow as unknown as DesktopWorkflowState
            : null,
        });
        changed = true;
      }
      if (changed) setDraftPrefsVersion((value) => value + 1);
    } catch { /* best-effort */ }
  }, []);
  const stageNewTaskProject = useCallback((projectPath: string) => {
    const next = String(projectPath || "").trim();
    newTaskProjectPathRef.current = next;
    setNewTaskProjectPath(next);
    setNewTaskDeferred(true);
    rememberDraftPanePrefs({ projectPath: next });
  }, [rememberDraftPanePrefs]);
  const stageNewTaskModelSelection = useCallback((selection: DesktopModelSelection) => {
    const remembered = routePreferenceStore.remember(selection);
    newTaskModelSelectionRef.current = remembered;
    setNewTaskModelSelection(remembered);
    rememberDraftPanePrefs({ modelSelection: remembered });
  }, [rememberDraftPanePrefs]);
  const rememberSessionRouteForNextTask = useCallback((selection: DesktopModelSelection) => {
    const cached = lastNewTaskPrefs.current ?? inheritedDraftPrefs();
    const modelSelection = mergeRoutePreference(
      cached.modelSelection,
      routePreferenceStore.remember(selection),
    );
    lastNewTaskPrefs.current = {
      ...cached,
      modelSelection,
    };
    // A successful session route becomes the seed for every draft that has no
    // explicit model of its own; explicitly staged draft panes keep their
    // per-pane entries unchanged.
    const current = selectionRef.current;
    const focusedDraftKey = current.kind === "new" ? current.draftId || "default" : "";
    if (!focusedDraftKey || !draftPanePrefs.current.get(focusedDraftKey)?.modelSelection) {
      newTaskModelSelectionRef.current = modelSelection;
      setNewTaskModelSelection(modelSelection);
    }
    persistDraftPanePrefs();
    // Inheriting (null-model) draft panes render the cache live: repaint them.
    setDraftPrefsVersion((value) => value + 1);
  }, [inheritedDraftPrefs, persistDraftPanePrefs]);
  const stageNewTaskWorkflow = useCallback((workflow: DesktopWorkflowState) => {
    newTaskWorkflowRef.current = workflow;
    setNewTaskWorkflow(workflow);
    rememberDraftPanePrefs({ workflow });
  }, [rememberDraftPanePrefs]);
  const clearNewTaskPreferences = useCallback((target?: NavigationSelection) => {
    const current = target?.kind === "new" ? target : selectionRef.current;
    const focusedOwnsTarget = current.kind === "new"
      && selectionRef.current.kind === "new"
      && navigationKey(selectionRef.current) === navigationKey(current);
    if (!target || focusedOwnsTarget) {
      newTaskModelSelectionRef.current = null;
      newTaskWorkflowRef.current = null;
      setNewTaskModelSelection(null);
      setNewTaskWorkflow(null);
    }
    // Retire the draft's entry (materialized into a session, or torn down) —
    // but never write nulls into lastNewTaskPrefs: the just-used settings
    // stay the seed for the NEXT new task (user rule).
    if (current.kind === "new") {
      draftPanePrefs.current.delete(current.draftId || "default");
      // The retired draft key may be reused (the "default" draft): a stale
      // engine-derived seed would otherwise resurface in the next task.
      draftSnapshotModelSeeds.current.delete(current.draftId || "default");
      persistDraftPanePrefs();
      setDraftPrefsVersion((value) => value + 1);
    }
  }, [persistDraftPanePrefs]);
  const resetNewTaskDraft = useCallback((projectPath: string) => {
    stageNewTaskProject(projectPath);
    // A fresh draft INHERITS the last cached model/workflow instead of
    // resetting to "Select model" (user rule). The values are painted but NOT
    // staged into the entry: the draft keeps following the cache until the
    // user explicitly diverges this pane.
    const inherited = inheritedDraftPrefs();
    newTaskModelSelectionRef.current = inherited.modelSelection;
    setNewTaskModelSelection(inherited.modelSelection);
    newTaskWorkflowRef.current = inherited.workflow;
    setNewTaskWorkflow(inherited.workflow);
  }, [inheritedDraftPrefs, stageNewTaskProject]);
  // Focused-draft switch: restore THAT draft's staged prefs into the working
  // singletons (or seed a first-seen draft from the inherited values), so
  // Ctrl+N tabs and pane clicks never bleed prefs into each other.
  const activeDraftKey = selection.kind === "new" ? selection.draftId || "default" : "";
  useEffect(() => {
    if (!activeDraftKey) return;
    const entry = draftPanePrefs.current.get(activeDraftKey);
    const resolved = resolvedDraftPrefsFor(activeDraftKey);
    if (entry) {
      // A null model/workflow stays INHERITED: resolution falls through to
      // the stable last-cached settings, so pane focus cannot change the
      // visible route and later session-route changes keep flowing in.
      newTaskProjectPathRef.current = resolved.projectPath;
      setNewTaskProjectPath(resolved.projectPath);
      newTaskModelSelectionRef.current = resolved.modelSelection;
      setNewTaskModelSelection(resolved.modelSelection);
      newTaskWorkflowRef.current = resolved.workflow;
      setNewTaskWorkflow(resolved.workflow);
      return;
    }
    // First sight of this draft: register a null-valued entry and paint the
    // inherited settings (user rule: new tasks reuse the last settings).
    // Model/workflow stay INHERITED (null) so later session-route changes
    // keep flowing in until the user explicitly stages this pane, and
    // auto-seeding never rewrites lastNewTaskPrefs (which rewound the cache
    // to stale values — user report: the last session-creation model was
    // not applied to the next New Task).
    draftPanePrefs.current.set(activeDraftKey, {
      projectPath: resolved.projectPath,
      modelSelection: null,
      workflow: null,
    });
    newTaskProjectPathRef.current = resolved.projectPath;
    setNewTaskProjectPath(resolved.projectPath);
    newTaskModelSelectionRef.current = resolved.modelSelection;
    setNewTaskModelSelection(resolved.modelSelection);
    newTaskWorkflowRef.current = resolved.workflow;
    setNewTaskWorkflow(resolved.workflow);
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [activeDraftKey, persistDraftPanePrefs, resolvedDraftPrefsFor]);
  useEffect(() => {
    if (!projectCatalogReady) return;
    let changed = false;
    for (const [key, prefs] of draftPanePrefs.current) {
      const projectPath = effectiveDraftProjectPath(prefs.projectPath);
      if (projectPath === prefs.projectPath) continue;
      draftPanePrefs.current.set(key, { ...prefs, projectPath });
      changed = true;
    }
    const last = lastNewTaskPrefs.current;
    if (last) {
      const projectPath = effectiveDraftProjectPath(last.projectPath);
      if (projectPath !== last.projectPath) {
        lastNewTaskPrefs.current = { ...last, projectPath };
        changed = true;
      }
    }
    if (activeDraftKey) {
      const resolved = resolvedDraftPrefsFor(activeDraftKey);
      newTaskProjectPathRef.current = resolved.projectPath;
      setNewTaskProjectPath(resolved.projectPath);
    }
    if (!changed) return;
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [
    activeDraftKey,
    effectiveDraftProjectPath,
    persistDraftPanePrefs,
    projectCatalogReady,
    resolvedDraftPrefsFor,
  ]);
  // Requested navigation is lightweight sidebar chrome only. The pane,
  // title, transcript and scroll state stay on the committed selection until
  // the final host response can replace that whole surface in one render.


  return {
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection,
    newTaskProjectPath,
    newTaskWorkflow,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
  };
}
