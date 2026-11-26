import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  VisualizeGoneOpen,
  VisualizeInlineContent,
  VisualizeInlineKind,
  VisualizePaneView,
  VisualizeProblem,
  VisualizeTabView,
  VisualizeVersionTurn,
  VisualizeVersionView,
} from '../../shared/visualize';
import type { VisualizeAnnotation } from '../../shared/visualize-annotations';
import { type HistoryEntry, rekeyHistory } from './history';
import { formatProblemsSection, localizeProblemText } from './page-problems';
import type { VisualizeTarget } from './targets';

export type FileTarget = Exclude<VisualizeTarget, { kind: 'url' }>;

/** A kept version on screen in place of (or beside) the live files. */
export interface ShownVersion {
  n: number;
  /** Each pane file in the version's snapshot folder, rooted in its kept folder. */
  targets: FileTarget[];
  panes: VisualizePaneView[];
  /** Its kept page assets that differ from the current files, by their
   *  root-qualified names (`keptAssetNames`): what the restore confirm lists. */
  restoreAssets: string[];
}

export interface VisualizeTabSummary {
  id: string;
  label: string;
  kind: string;
  target: string;
}

export interface VisualizeResult {
  text: string;
  tabs?: VisualizeTabSummary[];
  path?: string;
  /** The tab's page problems, when it has any (the text already lists them). */
  problems?: VisualizeProblem[];
  /** The conversation whose panel the call acted on, when it ran for another
   *  session's work (a sub-agent, a room member); its chat cards read it. */
  ownerSessionId?: string;
}

export interface TabState {
  id: string;
  label: string;
  /** Identity for reuse: the resolved targets in order. */
  key: string;
  cwd: string;
  /** Start order (`loadStamp`) of the open or reload whose files and `cwd`
   *  the tab holds: an older reload finishing late never overwrites them. */
  loadedStamp?: number;
  revision: number;
  /** Web URL tabs live in the browser panel and carry no panes. */
  url?: string;
  /** Opened only to check the agent's own work (`input.verify`): never
   *  published, shown, activated or kept in history; read off screen; closed
   *  at the session's next turn end. A plain open of it clears this. */
  verify?: boolean;
  /** Each with the root (resolved when the target was) its page assets,
   *  versions, restores and remote reads are contained in: the display-only
   *  path math of a publish never touches the file system. */
  targets: FileTarget[];
  panes: VisualizePaneView[];
  unwatch: Array<() => void>;
  /** Aborted once the tab is closed or its session deleted (tabs.ts `end`):
   *  work run for the tab (`whileOpen`) never resumes after that. */
  lifetime: AbortController;
  reloadTimer: NodeJS.Timeout | null;
  /** The live files are gone (deleted, or their folder removed): the tab shows
   *  a "file was removed" notice and retries until they are back. */
  missing?: boolean;
  /** Last resolved canonical target key before the tab became missing, so a
   *  case-only reopen on case-insensitive Windows still recovers this tab. */
  lastCanonicalKey?: string;
  /** Retries a failed reload (see reloads.ts); not a pending reload. */
  retryTimer?: NodeJS.Timeout | null;
  /** Distinct runtime problems since the last reload (replaced, never mutated). */
  problems: VisualizeProblem[];
  /** Bumps on every report, repeats included: a page still erroring is not settled. */
  problemSeq: number;
  /** Outside network for this tab's pages; on for every opened tab (like the
   *  browser panel). The guard still reports refused requests if it is cleared. */
  allowNetwork?: boolean;
  /** Kept versions (file tabs, with history on). */
  versions?: VisualizeVersionView[];
  /** The kept version shown instead of live (null/absent = live). */
  shown?: ShownVersion | null;
  /** The shown version sits beside the live files. */
  compare?: boolean;
  /** A file changed while a kept version was shown; reload on back to live. */
  pendingReload?: boolean;
  /** The last snapshot was skipped: the session's version history is full. */
  historyFull?: boolean;
  /** The live files were not kept as the newest version (too large, history full, or snapshot error). */
  liveUnkept?: boolean;
  /** Stat fingerprint of the live files last loaded into this tab. */
  liveStat?: string;
  /** The chat card's picture (a PNG data URL)… */
  thumbnail?: string;
  /** …of this version (0 for a tab without versions). */
  thumbnailVersion?: number;
  /** Direct-renderer tabs: the live content (no files, `targets` is empty). */
  inline?: VisualizeInlineContent;
  /** Kept contents of an inline tab, oldest first (held in memory), with the
   *  card picture each version's turn ended on. */
  inlineHistory?: Array<{
    n: number;
    at: number;
    content: VisualizeInlineContent;
    thumbnail?: string;
    turns?: VisualizeVersionTurn[];
  }>;
  /** Displayed pane indices whose inline render finished since the last open. */
  rendered?: Set<number>;
  /** Render ids already spent, with the tab revision they were issued for. */
  rendersSpent?: Map<string, number>;
  /** The agent's annotation marks and the revision they were made on: any
   *  remount (reload, version, network switch) leaves them behind. */
  annotations?: { revision: number; marks: VisualizeAnnotation[] };
}

/** The tab's marks for what it shows now (none once its revision moved on). */
export const currentAnnotations = (tab: TabState): VisualizeAnnotation[] =>
  tab.annotations && tab.annotations.revision === tab.revision ? tab.annotations.marks : [];

export interface SessionState {
  tabs: TabState[];
  active: string | null;
  counter: number;
  /** Everything opened this session, newest first (see history.ts). */
  history: HistoryEntry[];
  /** Turn-end record of opens with nothing left to show (turn-hold.ts); lives
   *  and goes with the session's state. */
  goneOpens?: VisualizeGoneOpen[];
}

/** The kind a tab's panes show together: the single pane's, else `split`. */
export const paneKindOf = (tab: TabState): VisualizePaneView['kind'] | 'split' =>
  tab.panes.length === 1 ? tab.panes[0].kind : 'split';

export function summary(tab: TabState): VisualizeTabSummary {
  if (tab.url) return { id: tab.id, label: tab.label, kind: 'url', target: tab.url };
  return {
    id: tab.id,
    label: tab.label,
    kind: paneKindOf(tab),
    target: tab.inline ? inlinePaneTarget(tab.inline) : tab.targets.map((target) => target.target).join(' | '),
  };
}

/** `summary` for an export result: file targets as project-relative paths and
 *  no host path or page-server URL in the label. */
export function exportSummary(tab: TabState, cwd: string): VisualizeTabSummary {
  const base = summary(tab);
  if (tab.url) return base;
  return {
    ...base,
    label: localizeProblemText(base.label, [cwd, ...problemRootsOf(tab)]),
    target: tab.inline ? base.target : tab.targets.map((target) => remoteTargetOf(target)).join(' | '),
  };
}

/** The host folders kept out of the tab's problem text: its cwd and the
 *  roots of its live files. */
export const problemRootsOf = (tab: TabState): string[] => [
  ...new Set([tab.cwd, ...tab.targets.map((target) => target.root)]),
];

const INLINE_LABELS: Record<VisualizeInlineKind, string> = {
  mermaid: 'Mermaid diagram',
  svg: 'SVG',
  chart: 'Chart',
  html: 'HTML',
  markdown: 'Markdown',
};

/** What an inline pane is called as a target (never a host path). */
const inlinePaneTarget = (content: VisualizeInlineContent): string => content.title ?? `inline ${content.kind}`;

export const inlinePane = (content: VisualizeInlineContent): VisualizePaneView => ({
  kind: 'inline',
  label: content.title ?? INLINE_LABELS[content.kind],
  target: inlinePaneTarget(content),
  url: '',
  inline: content,
});

/** Reuse identity of an inline tab: its title, else its exact content. */
export const inlineKey = (content: VisualizeInlineContent): string =>
  content.title
    ? `inline:${content.title}`
    : `inline:${content.kind}:${createHash('sha1').update(content.source).digest('hex')}`;

const normalizeRequestedPath = (cwd: string, raw: string): string =>
  isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);

/** Reuse identity of a file tab: its resolved canonical target paths in order. */
export const fileTargetsKey = (files: readonly Pick<FileTarget, 'path'>[]): string =>
  files.map((target) => target.path).join('\0');

/** Resolved canonical key when every target has a non-empty path, else undefined. */
export const resolvedCanonicalKey = (targets: readonly Pick<FileTarget, 'path'>[] | undefined): string | undefined =>
  targets?.length && targets.every((target) => target.path) ? fileTargetsKey(targets) : undefined;

/** Canonical key for an open tab, falling back to `lastCanonicalKey` while missing. */
export const tabCanonicalKey = (tab: Pick<TabState, 'missing' | 'lastCanonicalKey' | 'targets'>): string | undefined =>
  tab.missing ? tab.lastCanonicalKey : resolvedCanonicalKey(tab.targets);

/** Requested-path identity of a file tab (before symlink resolution, preserving exact case). */
export const requestedPathsKey = (cwd: string, targets: readonly string[]): string =>
  targets.map((raw) => normalizeRequestedPath(cwd, raw)).join('\0');

/** Requested-path identity of a file tab (before symlink resolution, preserving exact case). */
export const requestedTargetsKey = (cwd: string, files: readonly Pick<FileTarget, 'target'>[]): string =>
  requestedPathsKey(
    cwd,
    files.map((file) => file.target)
  );

/** Requested-path key formatted as a tab/history identity distinct from canonical file paths. */
export const targetIdentityKey = (cwd: string, files: readonly Pick<FileTarget, 'target'>[]): string =>
  `\0target\0${requestedTargetsKey(cwd, files)}`;

const isDirectTargetsRequest = (cwd: string, files: readonly Pick<FileTarget, 'target' | 'path'>[]): boolean =>
  files.every((file) => {
    const requested = normalizeRequestedPath(cwd, file.target);
    return process.platform === 'win32' ? requested.toLowerCase() === file.path.toLowerCase() : requested === file.path;
  });

const entryRequestedPaths = (entry: HistoryEntry): string[] | null => {
  const { cwd } = entry;
  if (cwd !== undefined) return entry.targets.map((raw) => normalizeRequestedPath(cwd, raw));
  if (entry.targets.every((raw) => isAbsolute(raw))) return entry.targets.map((raw) => resolve(raw));
  return null;
};

const exactRequestedHistoryMatch = (
  entry: HistoryEntry,
  cwd: string,
  files: readonly Pick<FileTarget, 'target'>[],
  canonicalKey: string
): boolean => {
  if (entry.content || entry.targets.length !== files.length) return false;
  const stored = entryRequestedPaths(entry);
  if (!stored) return entry.key === canonicalKey;
  const incoming = files.map((file) => normalizeRequestedPath(cwd, file.target));
  return stored.every((path, index) => path === incoming[index]);
};

const foldedRequestedHistoryMatch = (
  entry: HistoryEntry,
  cwd: string,
  files: readonly Pick<FileTarget, 'target'>[],
  canonicalKey: string
): boolean => {
  if (process.platform !== 'win32' || entry.content || entry.targets.length !== files.length) return false;
  const stored = entryRequestedPaths(entry);
  if (!stored) return false;
  if ((entry.canonicalKey ?? entry.key) !== canonicalKey) return false;
  const incoming = files.map((file) => normalizeRequestedPath(cwd, file.target));
  return stored.every((path, index) => path.toLowerCase() === incoming[index].toLowerCase());
};

export interface ClosedHistoryOptions {
  ignoreTab?: TabState;
}

export interface ClosedHistoryScope {
  tabs?: readonly TabState[];
  openKeys?: ReadonlySet<string>;
  isOpen?: (entry: HistoryEntry) => boolean;
  history: readonly HistoryEntry[];
}

export function historyEntryMatchesRequestedTab(
  entry: HistoryEntry,
  tab: { cwd: string; targets: readonly string[]; canonicalKey?: string }
): boolean {
  if (entry.content) return false;
  const stored = entryRequestedPaths(entry);
  if (!stored) return true;
  if (tab.targets.length !== stored.length) return false;
  const tabPaths = tab.targets.map((raw) => normalizeRequestedPath(tab.cwd, raw));
  if (tabPaths.every((path, index) => path === stored[index])) return true;
  return (
    process.platform === 'win32' &&
    tab.canonicalKey !== undefined &&
    (entry.canonicalKey ?? entry.key) === tab.canonicalKey &&
    tabPaths.every((path, index) => path.toLowerCase() === stored[index].toLowerCase())
  );
}

const historyEntryIsOpen = (
  scope: ClosedHistoryScope,
  { ignoreTab }: ClosedHistoryOptions = {}
): ((entry: HistoryEntry) => boolean) => {
  if (scope.isOpen) return scope.isOpen;
  if (scope.openKeys) {
    const openKeys = scope.openKeys;
    return (entry) => openKeys.has(entry.key);
  }
  const openTabs = (scope.tabs ?? []).filter((other) => other !== ignoreTab && !other.url && !other.verify);
  return (entry) =>
    openTabs.some(
      (other) =>
        other.key === entry.key &&
        historyEntryMatchesRequestedTab(entry, {
          cwd: other.cwd,
          targets: other.targets.map((target) => target.target),
          canonicalKey: tabCanonicalKey(other),
        })
    );
};

/** Find a closed file history entry whose requested paths exactly match `(cwd, files)`,
 *  excluding entries whose keys are currently held by visible open tabs. */
export function findClosedRequestedHistoryExact(
  state: ClosedHistoryScope | undefined,
  cwd: string,
  files: readonly Pick<FileTarget, 'target' | 'path'>[],
  canonicalKey = fileTargetsKey(files),
  options: ClosedHistoryOptions = {}
): HistoryEntry | undefined {
  if (!state) return undefined;
  const targetKey = targetIdentityKey(cwd, files);
  const isOpen = historyEntryIsOpen(state, options);
  return state.history.find(
    (entry) =>
      !isOpen(entry) && (entry.key === targetKey || exactRequestedHistoryMatch(entry, cwd, files, canonicalKey))
  );
}

/** Find a closed file history entry whose requested paths match `(cwd, files)` (exact matches
 *  across all closed entries before any Windows case-folded match), excluding entries whose keys
 *  are currently held by visible open tabs. */
export function findClosedRequestedHistory(
  state: ClosedHistoryScope | undefined,
  cwd: string,
  files: readonly Pick<FileTarget, 'target' | 'path'>[],
  canonicalKey = fileTargetsKey(files),
  options: ClosedHistoryOptions = {}
): HistoryEntry | undefined {
  if (!state) return undefined;
  const exact = findClosedRequestedHistoryExact(state, cwd, files, canonicalKey, options);
  if (exact) return exact;
  if (process.platform !== 'win32') return undefined;
  const isOpen = historyEntryIsOpen(state, options);
  return state.history.find((entry) => !isOpen(entry) && foldedRequestedHistoryMatch(entry, cwd, files, canonicalKey));
}

const matchesFoldedRequested = (
  candidate: TabState,
  foldedRequestedKey: string,
  canonicalKey: string,
  foldedCanonicalKey: string
): boolean =>
  requestedTargetsKey(candidate.cwd, candidate.targets).toLowerCase() === foldedRequestedKey &&
  (candidate.missing
    ? candidate.lastCanonicalKey?.toLowerCase() === foldedCanonicalKey
    : fileTargetsKey(candidate.targets) === canonicalKey);

/** Find an open file tab with strict exact-before-folded precedence across open tabs and closed
 *  history, falling back to a non-missing open tab with the canonical key (or resolved canonical
 *  targets) only when no closed history entry owns the requested path. */
export function findFileTab(
  tabs: readonly TabState[],
  cwd: string,
  files: readonly FileTarget[],
  canonicalKey = fileTargetsKey(files),
  history?: readonly HistoryEntry[],
  options: { ignoreVerify?: boolean } = {}
): TabState | undefined {
  const { ignoreVerify = false } = options;
  const candidates = ignoreVerify ? tabs.filter((candidate) => !candidate.verify) : tabs;
  const requestedKey = requestedTargetsKey(cwd, files);
  const byExactRequested = candidates.find(
    (candidate) =>
      !candidate.url &&
      !candidate.inline &&
      candidate.targets.length === files.length &&
      requestedTargetsKey(candidate.cwd, candidate.targets) === requestedKey
  );
  if (byExactRequested) return byExactRequested;
  if (history && findClosedRequestedHistoryExact({ tabs, history }, cwd, files, canonicalKey)) {
    return undefined;
  }
  if (process.platform === 'win32') {
    const foldedRequestedKey = requestedKey.toLowerCase();
    const foldedCanonicalKey = canonicalKey.toLowerCase();
    const byFoldedRequested = candidates.find(
      (candidate) =>
        !candidate.url &&
        !candidate.inline &&
        candidate.targets.length === files.length &&
        matchesFoldedRequested(candidate, foldedRequestedKey, canonicalKey, foldedCanonicalKey)
    );
    if (byFoldedRequested) return byFoldedRequested;
  }
  if (history && findClosedRequestedHistory({ tabs, history }, cwd, files, canonicalKey)) {
    return undefined;
  }
  return (
    candidates.find(
      (candidate) => !candidate.url && !candidate.inline && !candidate.missing && candidate.key === canonicalKey
    ) ??
    candidates.find(
      (candidate) =>
        !candidate.url &&
        !candidate.inline &&
        !candidate.missing &&
        (fileTargetsKey(candidate.targets) === canonicalKey || candidate.lastCanonicalKey === canonicalKey)
    )
  );
}

/** Find a hidden `verify` file tab whose requested path matches `(cwd, files)`
 *  (exact first, then Windows case-folded with matching canonical target). */
export function findVerifyRequestedTab(
  tabs: readonly TabState[],
  cwd: string,
  files: readonly FileTarget[],
  canonicalKey = fileTargetsKey(files)
): TabState | undefined {
  const requestedKey = requestedTargetsKey(cwd, files);
  const candidates = tabs.filter(
    (candidate) => candidate.verify && !candidate.url && !candidate.inline && candidate.targets.length === files.length
  );
  const byExact = candidates.find(
    (candidate) => requestedTargetsKey(candidate.cwd, candidate.targets) === requestedKey
  );
  if (byExact) return byExact;
  if (process.platform !== 'win32') return undefined;
  const foldedRequestedKey = requestedKey.toLowerCase();
  const foldedCanonicalKey = canonicalKey.toLowerCase();
  return candidates.find((candidate) =>
    matchesFoldedRequested(candidate, foldedRequestedKey, canonicalKey, foldedCanonicalKey)
  );
}

/** Resolve a collision-safe reuse key for a file tab (`tab` when updating an existing tab,
 *  omitted when creating a new tab) and migrate any matching history entry in lockstep. */
export function resolveFileTabKey(
  state: Pick<SessionState, 'tabs' | 'history'>,
  cwd: string,
  targets: readonly FileTarget[],
  options: { tab?: TabState; syncHistory?: boolean; promoteFromVerify?: boolean } = {}
): string {
  const { tab, syncHistory = !tab?.verify, promoteFromVerify = false } = options;
  const canonicalKey = fileTargetsKey(targets);
  if (!targets.length || targets.some((target) => !target.path)) return tab?.key ?? canonicalKey;
  const targetKey = targetIdentityKey(cwd, targets);
  const openKeys = new Set(state.tabs.filter((other) => other !== tab).map((other) => other.key));
  const useClosedHistory = !tab || promoteFromVerify;
  const matchedHistory = useClosedHistory
    ? findClosedRequestedHistory(state, cwd, targets, canonicalKey, { ignoreTab: tab })
    : undefined;
  const ownedKey = useClosedHistory ? matchedHistory?.key : tab.key;
  const isTaken = (candidate: string): boolean => {
    if (openKeys.has(candidate)) return true;
    if (candidate === ownedKey) return false;
    if (!state.history.some((entry) => entry.key === candidate)) return false;
    // A brand-new direct (non-symlink) open matching a closed history entry's canonical key reopens it.
    if (useClosedHistory && !matchedHistory && candidate === canonicalKey && isDirectTargetsRequest(cwd, targets)) {
      return false;
    }
    return true;
  };

  let nextKey: string;
  if (!isTaken(canonicalKey)) nextKey = canonicalKey;
  else if (!isTaken(targetKey)) nextKey = targetKey;
  else nextKey = ownedKey ?? targetKey;

  if (tab) {
    const prevKey = tab.key;
    if (nextKey !== prevKey) tab.key = nextKey;
    if (syncHistory) {
      const migrateFrom = promoteFromVerify ? matchedHistory?.key : prevKey;
      if (migrateFrom) state.history = rekeyHistory(state.history, migrateFrom, nextKey, canonicalKey);
    }
  } else if (matchedHistory && syncHistory) {
    state.history = rekeyHistory(state.history, matchedHistory.key, nextKey, canonicalKey);
  }
  return nextKey;
}

/** Update a file tab's reuse key when its resolved targets change, avoiding collisions with
 *  other open tabs or distinct history entries and migrating its matching history entry in lockstep. */
export function rekeyFileTab(
  state: Pick<SessionState, 'tabs' | 'history'>,
  tab: TabState,
  targets: readonly FileTarget[]
): boolean {
  const prevKey = tab.key;
  const nextKey = resolveFileTabKey(state, tab.cwd, targets, { tab });
  return nextKey !== prevKey;
}

/** Mark a file tab missing, clearing stale canonical target paths and migrating its key off
 *  any stale resolved destination onto its requested-path identity. */
export function markFileTabMissing(state: Pick<SessionState, 'tabs' | 'history'> | undefined, tab: TabState): void {
  if (tab.targets.length && tab.targets.every((target) => target.path)) {
    tab.lastCanonicalKey = fileTargetsKey(tab.targets);
  }
  tab.missing = true;
  tab.targets = tab.targets.map((target) => ({ ...target, path: '' }));
  if (!state || !tab.targets.length) return;
  const requestedKey = targetIdentityKey(tab.cwd, tab.targets);
  if (
    requestedKey === tab.key ||
    state.tabs.some((other) => other !== tab && other.key === requestedKey) ||
    state.history.some((entry) => entry.key === requestedKey)
  ) {
    return;
  }
  const prevKey = tab.key;
  tab.key = requestedKey;
  if (!tab.verify) state.history = rekeyHistory(state.history, prevKey, requestedKey);
}

/** Install freshly prepared valid live panes on `tab`, clearing any missing-file state. */
export function installLivePanes(tab: TabState, panes: VisualizePaneView[], fields?: Partial<TabState>): void {
  tab.panes = panes;
  tab.missing = false;
  if (fields) Object.assign(tab, fields);
  if (tab.targets.length && tab.targets.every((target) => target.path)) {
    tab.lastCanonicalKey = fileTargetsKey(tab.targets);
  }
}

/** True when `tab`'s missing live files are part of what is currently displayed (live view or compare mode). */
export const displaysMissingLive = (tab: Pick<TabState, 'missing' | 'shown' | 'compare'>): boolean =>
  tab.missing === true && (!tab.shown || tab.compare === true);

export const sameInline = (a: VisualizeInlineContent, b: VisualizeInlineContent): boolean =>
  a.kind === b.kind && a.source === b.source && a.title === b.title;

/** A target as a remote client may see it: relative to its root, or the file
 *  name when it is not representable that way. Pure path math: called on
 *  every publish. */
export function remoteTargetOf(target: FileTarget): string {
  if (!target.path) return target.label;
  const rel = relative(target.root, target.path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return basename(target.path);
  return rel.split(sep).join('/');
}

/** Absolute paths in free text: POSIX roots, drive letters, UNC shares, ~/. */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=,:;[])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~[\\/])/;

/** The tab label a remote client may see: the agent's label unless it names a
 *  host path (cwd, a raw target or any absolute path), else the panes. */
export function remoteLabelOf(tab: TabState, panes: Array<{ target: string; remoteTarget: string }>): string {
  const fallback = panes.map((pane) => pane.remoteTarget).join(' · ');
  const label = tab.label;
  const named = [tab.cwd, ...panes.filter((pane) => isAbsolute(pane.target)).map((pane) => pane.target)];
  if (ABSOLUTE_PATH.test(label) || named.some((path) => path && label.includes(path))) return fallback;
  return label;
}

/** Compare layout: version pane, live pane, version pane, live pane… */
export function interleave<T>(shown: T[], live: T[]): T[] {
  return shown.flatMap((pane, index) => (live[index] ? [pane, live[index]] : [pane]));
}

/** The tab's layout of anything per pane: `live` alone, the kept version's
 *  `old` alone, or both interleaved in compare. */
export function shownLayout<T>(tab: TabState, old: T[], live: T[]): T[] {
  if (!tab.shown) return live;
  return tab.compare ? interleave(old, live) : old;
}

/** What the tab draws: live panes, a kept version's, or both interleaved. */
export function displayedPanes(tab: TabState): VisualizePaneView[] {
  const shown = tab.shown;
  if (!shown) return tab.panes;
  const old = shown.panes.map((pane) => ({ ...pane, version: shown.n }));
  return tab.compare ? interleave(old, tab.panes) : old;
}

function versionFields(
  tab: TabState
): Pick<VisualizeTabView, 'versions' | 'version' | 'compare' | 'liveUnkept' | 'restoreAssets'> {
  if (!tab.versions) return {};
  return {
    versions: tab.versions,
    version: tab.shown?.n ?? null,
    ...(tab.shown && tab.compare ? { compare: true } : {}),
    ...(tab.liveUnkept || tab.historyFull ? { liveUnkept: true as const } : {}),
    ...(tab.shown?.restoreAssets.length ? { restoreAssets: tab.shown.restoreAssets } : {}),
  };
}

/** The tool result's note on a tab's history (once it has 2+ versions, or
 *  when the current files could not be kept). */
export function versionNote(tab: TabState): string {
  const full = tab.historyFull
    ? " The current files were not kept as a version: this session's version history is full (close visualize tabs to free it)."
    : '';
  const list = tab.versions ?? [];
  if (list.length < 2 && !tab.shown) return full;
  const range = list.length ? ` (v${list[0].n}–v${list.at(-1)?.n})` : '';
  if (tab.shown) {
    return ` Showing kept version v${tab.shown.n} of ${list.length}${range}, read-only; live reloads wait until the user goes back to live.${full}`;
  }
  return ` ${list.length} versions kept${range}; pass input.version to show an older one.${full}`;
}

export function view(tab: TabState): VisualizeTabView {
  return {
    id: tab.id,
    label: tab.label,
    revision: tab.revision,
    panes: displayedPanes(tab),
    ...(tab.missing && !tab.shown ? { missing: true as const } : {}),
    ...(tab.problems.length ? { problems: tab.problems } : {}),
    ...(tab.allowNetwork ? { networkAllowed: true as const } : {}),
    ...versionFields(tab),
    ...(tab.thumbnail ? { thumbnail: tab.thumbnail, thumbnailVersion: tab.thumbnailVersion ?? 0 } : {}),
    ...(currentAnnotations(tab).length ? { annotations: currentAnnotations(tab) } : {}),
  };
}

/** The tool result's problems section, appended to `text` when there is one. */
export function withProblems(tab: TabState, text: string): string {
  const section = formatProblemsSection(
    tab.id,
    tab.problems,
    displayedPanes(tab).map((pane) => pane.label)
  );
  return section ? `${text}\n${section}` : text;
}

export const problemsOf = (tab: TabState): Pick<VisualizeResult, 'problems'> =>
  tab.problems.length ? { problems: tab.problems } : {};
