import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { DesktopModelSelection, DesktopWorkflowState } from "../shared/contract";
import type { NavigationSelection } from "./navigation";
import type { Snapshot } from "./desktop-types";
import { mergeRoutePreference, routePreferenceStore } from "./app-route-preference";
import { asRecord, navigationKey } from "./text-format";

// v2: entries store ONLY explicitly staged fields (null = inherit live from
// the last cached settings). v1 entries materialized inherited values, which
// froze stale models onto restored/parked drafts (user report).
// v3: projectPath follows the same rule — null inherits live, "" is an
// explicit No project. v2 wrote "" for BOTH, so a phone whose first paint
// preceded the relay project catalog froze an empty project into its draft and
// never recovered it (user: 마지막으로 쓴 프로젝트가 안 잡힘).
const DRAFT_PANE_PREFS_KEY = "mixdog.desktop-draft-pane-prefs.v3";
const LEGACY_DRAFT_PANE_PREFS_KEY = "mixdog.desktop-draft-pane-prefs.v2";
const ABANDONED_DRAFT_PANE_PREFS_KEY = "mixdog.desktop-draft-pane-prefs.v1";
const LAST_NEW_TASK_PREFS_KEY = "mixdog.desktop-last-new-task-prefs.v2";
const LEGACY_LAST_NEW_TASK_PREFS_KEY = "mixdog.desktop-last-new-task-prefs.v1";

export type DraftPanePrefs = {
  /** null keeps inheriting live; "" is an explicit No project. */
  projectPath: string | null;
  modelSelection: DesktopModelSelection | null;
  workflow: DesktopWorkflowState | null;
};

/** What a draft actually paints and submits: the project is resolved. */
export type ResolvedDraftPrefs = DraftPanePrefs & { projectPath: string };

/** A legacy entry cannot separate "never chosen" from "No project", so its
 *  empty path re-enters the inheritance chain; only a current entry may carry
 *  the explicit empty. */
function storedProjectPath(value: unknown, legacy: boolean): string | null {
  if (typeof value !== "string") return null;
  return legacy && !value.trim() ? null : value;
}

/** Re-resolving a STORED project against the catalog can fail to place it: an
 *  empty or not-yet-delivered phone catalog answers "". Persisting that empty
 *  turns a lost lookup into an explicit No project that then survives every
 *  reconnect and reboot (user: 재접속하면 프로젝트가 사라진다), so a failed
 *  resolution RELEASES the entry back to inheritance. Only the user's own
 *  choice — an already-empty stored value — keeps No project. */
export function resolvedStoredProjectPath(
  stored: string,
  resolve: (candidate: string) => string,
): string | null {
  if (!stored) return "";
  return resolve(stored) || null;
}

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
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
  };
};

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
  const inheritedDraftPrefs = useCallback((): ResolvedDraftPrefs => {
    const last = lastNewTaskPrefs.current;
    return {
      // An explicit empty path means No project and must not fall through to a
      // previous non-empty value. With no saved preference, seed the registry's
      // most recently selected project.
      projectPath: effectiveDraftProjectPath(last?.projectPath
        ?? (newTaskProjectPathRef.current || preferredDraftProjectPath)),
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
  const resolvedDraftPrefsFor = useCallback((draftKey: string): ResolvedDraftPrefs => {
    const entry = draftKey ? draftPanePrefs.current.get(draftKey) : undefined;
    const last = lastNewTaskPrefs.current;
    // null = this pane never chose a project: keep inheriting the last cached
    // choice, then the registry's most recent project, so a catalog that
    // arrives after first paint still reaches the draft.
    const projectPath = entry?.projectPath
      ?? last?.projectPath
      ?? preferredDraftProjectPath;
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
      ?? { projectPath: null, modelSelection: null, workflow: null };
    const merged = { ...entry, ...patch };
    // Refresh insertion order so the persistence cap drops the oldest drafts.
    draftPanePrefs.current.delete(draftKey);
    draftPanePrefs.current.set(draftKey, merged);
    // Explicit staging updates the inheritance source for FUTURE new tasks —
    // but only the STAGED fields. Merging the whole entry rewound the cache
    // to this pane's older values (user report: the last session-creation
    // model was not cached for the next New Task).
    // Seeding the cache with an INFERRED project would freeze it as an
    // explicit choice; only staged fields may enter it.
    const last = lastNewTaskPrefs.current
      ?? { projectPath: null, modelSelection: null, workflow: null };
    lastNewTaskPrefs.current = {
      ...last,
      ...(patch.projectPath === undefined ? {} : { projectPath: patch.projectPath }),
      ...(patch.modelSelection ? { modelSelection: patch.modelSelection } : {}),
      ...(patch.workflow ? { workflow: patch.workflow } : {}),
    };
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [persistDraftPanePrefs]);
  useEffect(() => {
    // Hydrate BEFORE the focused-draft restore effect below (declaration
    // order), so a restored layout's drafts reopen with their saved prefs.
    try {
      const storedLast = window.localStorage.getItem(LAST_NEW_TASK_PREFS_KEY);
      const legacyLast = storedLast === null;
      const lastRaw = legacyLast
        ? window.localStorage.getItem(LEGACY_LAST_NEW_TASK_PREFS_KEY)
        : storedLast;
      const lastValue = lastRaw ? asRecord(JSON.parse(lastRaw)) : null;
      if (lastValue) {
        lastNewTaskPrefs.current = {
          projectPath: storedProjectPath(lastValue.projectPath, legacyLast),
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
      window.localStorage.removeItem(ABANDONED_DRAFT_PANE_PREFS_KEY);
      window.localStorage.removeItem(LEGACY_LAST_NEW_TASK_PREFS_KEY);
      const storedEntries = window.localStorage.getItem(DRAFT_PANE_PREFS_KEY);
      const legacyEntries = storedEntries === null;
      const raw = legacyEntries
        ? window.localStorage.getItem(LEGACY_DRAFT_PANE_PREFS_KEY)
        : storedEntries;
      window.localStorage.removeItem(LEGACY_DRAFT_PANE_PREFS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      let changed = false;
      for (const row of Array.isArray(parsed) ? parsed : []) {
        const key = Array.isArray(row) && typeof row[0] === "string" ? row[0] : "";
        const value = Array.isArray(row) ? asRecord(row[1]) : null;
        if (!key || !value || draftPanePrefs.current.has(key)) continue;
        draftPanePrefs.current.set(key, {
          projectPath: storedProjectPath(value.projectPath, legacyEntries),
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
      // Migrated values live in memory only until something is staged: write
      // them under the current keys right away.
      if (legacyLast || legacyEntries) persistDraftPanePrefs();
    } catch { /* best-effort */ }
  }, [persistDraftPanePrefs]);
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
    // Same rule as staging: a route change may not materialize an inferred
    // project into the cache (on a phone that value is often not loaded yet).
    const cached = lastNewTaskPrefs.current
      ?? { projectPath: null, modelSelection: null, workflow: null };
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
  }, [persistDraftPanePrefs]);
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
  const resetNewTaskDraft = useCallback((projectPath: string | null) => {
    // null: nothing explicit to restore, so the project INHERITS as well —
    // opening New task before the relay catalog lands must not freeze an empty
    // choice into the entry.
    if (projectPath === null) setNewTaskDeferred(true);
    else stageNewTaskProject(projectPath);
    // A fresh draft INHERITS the last cached model/workflow instead of
    // resetting to "Select model" (user rule). The values are painted but NOT
    // staged into the entry: the draft keeps following the cache until the
    // user explicitly diverges this pane.
    const inherited = inheritedDraftPrefs();
    if (projectPath === null) {
      newTaskProjectPathRef.current = inherited.projectPath;
      setNewTaskProjectPath(inherited.projectPath);
    }
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
      // The PROJECT inherits on the same terms: materializing the resolved
      // value here froze whatever was known at FIRST PAINT, which on a phone
      // is an empty catalog — and "" then read as an explicit No project for
      // the rest of that draft's life.
      projectPath: null,
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
    if (!projectCatalogValidated) return;
    let changed = false;
    for (const [key, prefs] of draftPanePrefs.current) {
      // An inheriting entry has nothing to re-resolve, and writing "" into it
      // would convert it into an explicit No project.
      if (prefs.projectPath === null) continue;
      const projectPath = resolvedStoredProjectPath(
        prefs.projectPath,
        effectiveDraftProjectPath,
      );
      if (projectPath === prefs.projectPath) continue;
      draftPanePrefs.current.set(key, { ...prefs, projectPath });
      changed = true;
    }
    const last = lastNewTaskPrefs.current;
    if (last && last.projectPath !== null) {
      const projectPath = resolvedStoredProjectPath(
        last.projectPath,
        effectiveDraftProjectPath,
      );
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
    projectCatalogValidated,
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
