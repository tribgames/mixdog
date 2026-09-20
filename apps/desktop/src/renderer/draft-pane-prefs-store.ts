import type { DesktopModelSelection, DesktopOrchestrationMode, DesktopWorkflowState } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { asRecord } from './text-format';

// v2: entries store ONLY explicitly staged fields (null = inherit live from
// the last cached settings). v1 entries materialized inherited values, which
// froze stale models onto restored/parked drafts (user report).
// v3: projectPath follows the same rule — null inherits live, "" is an
// explicit No project. v2 wrote "" for BOTH, so a phone whose first paint
// preceded the relay project catalog froze an empty project into its draft and
// never recovered it (user: 마지막으로 쓴 프로젝트가 안 잡힘).
const DRAFT_PANE_PREFS_KEY = 'mixdog.desktop-draft-pane-prefs.v3';
const LEGACY_DRAFT_PANE_PREFS_KEY = 'mixdog.desktop-draft-pane-prefs.v2';
const ABANDONED_DRAFT_PANE_PREFS_KEY = 'mixdog.desktop-draft-pane-prefs.v1';
const LAST_NEW_TASK_PREFS_KEY = 'mixdog.desktop-last-new-task-prefs.v2';
const LEGACY_LAST_NEW_TASK_PREFS_KEY = 'mixdog.desktop-last-new-task-prefs.v1';
const PERSISTED_DRAFT_ENTRY_CAP = 24;
const SNAPSHOT_MODEL_SEED_CAP = 32;

export type DraftPanePrefs = {
  /** null keeps inheriting live; "" is an explicit No project. */
  projectPath: string | null;
  modelSelection: DesktopModelSelection | null;
  workflow: DesktopWorkflowState | null;
  orchestrationMode?: DesktopOrchestrationMode | null;
};

/** What a draft actually paints and submits: the project is resolved. */
export type ResolvedDraftPrefs = DraftPanePrefs & { projectPath: string };

/** A first-touch entry: every field inherits live until the user stages it. */
export const emptyDraftPanePrefs = (): DraftPanePrefs => ({ projectPath: null, modelSelection: null, workflow: null });

function storedWorkflowPreferences(
  value: Record<string, unknown>
): Pick<DraftPanePrefs, 'workflow' | 'orchestrationMode'> {
  const workflow = asRecord(value.workflow) as DesktopWorkflowState | null;
  const solo = workflow?.id === 'solo';
  const cowork = workflow?.id === 'default' && workflow?.name === 'Cowork';
  const mode = value.orchestrationMode;
  let orchestrationMode: DesktopOrchestrationMode | undefined;
  if (typeof mode === 'string' && ['none', 'focused', 'balanced', 'swarm'].includes(mode)) {
    orchestrationMode = mode as DesktopOrchestrationMode;
  } else if (solo) orchestrationMode = 'none';
  else if (cowork) orchestrationMode = 'swarm';
  return {
    workflow: solo || cowork ? { ...workflow, id: 'default', name: 'Default' } : workflow,
    orchestrationMode,
  };
}

/** A legacy entry cannot separate "never chosen" from "No project", so its
 *  empty path re-enters the inheritance chain; only a current entry may carry
 *  the explicit empty. */
function storedProjectPath(value: unknown, legacy: boolean): string | null {
  if (typeof value !== 'string') return null;
  return legacy && !value.trim() ? null : value;
}

/** One persisted row (a draft entry or the last-used cache) back into memory. */
function storedDraftPanePrefs(value: Record<string, unknown>, legacy: boolean): DraftPanePrefs {
  return {
    projectPath: storedProjectPath(value.projectPath, legacy),
    modelSelection: asRecord(value.modelSelection) ? (value.modelSelection as unknown as DesktopModelSelection) : null,
    ...storedWorkflowPreferences(value),
  };
}

/** Re-resolving a STORED project against the catalog can fail to place it: an
 *  empty or not-yet-delivered phone catalog answers "". Persisting that empty
 *  turns a lost lookup into an explicit No project that then survives every
 *  reconnect and reboot (user: 재접속하면 프로젝트가 사라진다), so a failed
 *  resolution RELEASES the entry back to inheritance. Only the user's own
 *  choice — an already-empty stored value — keeps No project. */
export function resolvedStoredProjectPath(stored: string, resolve: (candidate: string) => string): string | null {
  if (!stored) return '';
  return resolve(stored) || null;
}

export const draftModelSelectionFromSnapshot = (snapshot: Snapshot): DesktopModelSelection | null => {
  const provider = String(snapshot.provider || '');
  const model = String(snapshot.model || '');
  if (!provider || !model) return null;
  const effort = String(snapshot.effort || '');
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof snapshot.fast === 'boolean' ? { fast: snapshot.fast } : {}),
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
  };
};

/** The last-used cache from storage. `legacy` means a v1 key answered and the
 *  caller must write the current keys back right away. */
export function readStoredLastNewTaskPrefs(): { value: DraftPanePrefs | null; legacy: boolean } {
  const stored = window.localStorage.getItem(LAST_NEW_TASK_PREFS_KEY);
  const legacy = stored === null;
  const raw = legacy ? window.localStorage.getItem(LEGACY_LAST_NEW_TASK_PREFS_KEY) : stored;
  const value = raw ? asRecord(JSON.parse(raw)) : null;
  // v1 entries materialized inherited models; resolving them as explicit
  // choices resurfaced stale models, so they are abandoned wholesale.
  window.localStorage.removeItem(ABANDONED_DRAFT_PANE_PREFS_KEY);
  window.localStorage.removeItem(LEGACY_LAST_NEW_TASK_PREFS_KEY);
  return { value: value ? storedDraftPanePrefs(value, legacy) : null, legacy };
}

/** The per-draft entries from storage, retiring the legacy key. */
export function readStoredDraftPaneEntries(): { rows: Array<[string, DraftPanePrefs]>; legacy: boolean } {
  const stored = window.localStorage.getItem(DRAFT_PANE_PREFS_KEY);
  const legacy = stored === null;
  const raw = legacy ? window.localStorage.getItem(LEGACY_DRAFT_PANE_PREFS_KEY) : stored;
  window.localStorage.removeItem(LEGACY_DRAFT_PANE_PREFS_KEY);
  const parsed: unknown = raw ? JSON.parse(raw) : null;
  const rows: Array<[string, DraftPanePrefs]> = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const key = Array.isArray(row) && typeof row[0] === 'string' ? row[0] : '';
    const value = Array.isArray(row) ? asRecord(row[1]) : null;
    if (key && value) rows.push([key, storedDraftPanePrefs(value, legacy)]);
  }
  return { rows, legacy };
}

/** Prefs survive reloads: without persistence a restored pane layout showed
 *  fallback chrome until focused, then snapped to "Select model" because the
 *  freshly-seeded entry was empty (user report). */
export function writeStoredDraftPanePrefs(entries: Map<string, DraftPanePrefs>, last: DraftPanePrefs | null): void {
  window.localStorage.setItem(
    DRAFT_PANE_PREFS_KEY,
    JSON.stringify([...entries.entries()].slice(-PERSISTED_DRAFT_ENTRY_CAP))
  );
  if (last) window.localStorage.setItem(LAST_NEW_TASK_PREFS_KEY, JSON.stringify(last));
}

/** Explicit staging updates the inheritance source for FUTURE new tasks — but
 *  only the STAGED fields. Merging the whole entry rewound the cache to this
 *  pane's older values (user report: the last session-creation model was not
 *  cached for the next New Task). Seeding the cache with an INFERRED project
 *  would freeze it as an explicit choice; only staged fields may enter it. */
export function stagedLastNewTaskPrefs(last: DraftPanePrefs | null, patch: Partial<DraftPanePrefs>): DraftPanePrefs {
  return {
    ...(last ?? emptyDraftPanePrefs()),
    ...(patch.projectPath === undefined ? {} : { projectPath: patch.projectPath }),
    ...(patch.modelSelection ? { modelSelection: patch.modelSelection } : {}),
    ...(patch.workflow ? { workflow: patch.workflow } : {}),
    ...(patch.orchestrationMode ? { orchestrationMode: patch.orchestrationMode } : {}),
  };
}

/** The engine-derived fallback is captured ONCE per draft: it follows the
 *  FOCUSED engine and is null while a session pane owns focus, so a draft
 *  with no explicit choice re-rendered a different model on every focus swap
 *  and on the first public render of a freshly created New task pane. */
export function rememberSnapshotModelSeed(
  seeds: Map<string, DesktopModelSelection>,
  draftKey: string,
  selection: DesktopModelSelection | null
): void {
  if (!draftKey || !selection || seeds.has(draftKey)) return;
  seeds.set(draftKey, selection);
  while (seeds.size > SNAPSHOT_MODEL_SEED_CAP) {
    const oldest = seeds.keys().next().value;
    if (oldest === undefined) break;
    seeds.delete(oldest);
  }
}

/** ONE display/restore rule for a draft's effective prefs (focused and
 *  unfocused): the entry's explicit values, with unset fields inheriting the
 *  last-used prefs. Without the shared rule a null-model entry showed
 *  "Select model" focused while the unfocused pane showed the inherited
 *  model (user report: the two states disagreed). */
export function resolveDraftPrefs({
  entry,
  last,
  seed,
  snapshotDraftModelSelection,
  preferredDraftProjectPath,
  effectiveDraftProjectPath,
}: {
  entry: DraftPanePrefs | undefined;
  last: DraftPanePrefs | null;
  seed: DesktopModelSelection | undefined;
  snapshotDraftModelSelection: DesktopModelSelection | null;
  preferredDraftProjectPath: string;
  effectiveDraftProjectPath(candidate: unknown): string;
}): ResolvedDraftPrefs {
  // null = this pane never chose a project: keep inheriting the last cached
  // choice, then the registry's most recent project, so a catalog that
  // arrives after first paint still reaches the draft.
  const projectPath = entry?.projectPath ?? last?.projectPath ?? preferredDraftProjectPath;
  return {
    projectPath: effectiveDraftProjectPath(projectPath),
    modelSelection: entry?.modelSelection ?? last?.modelSelection ?? seed ?? snapshotDraftModelSelection,
    workflow: entry?.workflow ?? last?.workflow ?? null,
    orchestrationMode: entry?.orchestrationMode ?? last?.orchestrationMode ?? null,
  };
}

/** After the catalog validates, every explicit stored project is re-resolved
 *  against it. An inheriting entry has nothing to re-resolve, and writing ""
 *  into it would convert it into an explicit No project. Mutates the map;
 *  returns whether anything changed. */
export function reresolveDraftEntries(
  entries: Map<string, DraftPanePrefs>,
  resolve: (candidate: string) => string
): boolean {
  let changed = false;
  for (const [key, prefs] of entries) {
    if (prefs.projectPath === null) continue;
    const projectPath = resolvedStoredProjectPath(prefs.projectPath, resolve);
    if (projectPath === prefs.projectPath) continue;
    entries.set(key, { ...prefs, projectPath });
    changed = true;
  }
  return changed;
}

/** Same rule for the last-used cache; answers the same object when unchanged. */
export function reresolvedLastNewTaskPrefs(
  last: DraftPanePrefs | null,
  resolve: (candidate: string) => string
): DraftPanePrefs | null {
  if (!last || last.projectPath === null) return last;
  const projectPath = resolvedStoredProjectPath(last.projectPath, resolve);
  return projectPath === last.projectPath ? last : { ...last, projectPath };
}
