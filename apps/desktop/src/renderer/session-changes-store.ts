import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DesktopGitFile } from '../shared/contract';
import { SESSION_CHANGES_SOURCE_KEY, type Snapshot, type TranscriptItem } from './desktop-types';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { t } from './i18n';
import { registerIdleReclaim } from './idle-reclaim';
import { carriedSum, placedHash, textHash } from './list-carry';
import { RendererLruCache } from './renderer-lru-cache';
import {
  fetchOmittedSessionDiffFilePatch,
  fetchSessionDiff,
  peekSessionDiff,
  sessionDiffBinding,
  sessionDiffRevision,
} from './session-diff-cache';
import {
  buildSessionDiffRows,
  decodeSessionDiffFilePatch,
  parsedSessionDiff,
  parseSessionDiff,
  sessionDiffFileSlice,
  sessionDiffPatchTooLarge,
  sessionDiffRowOverLineLimit,
  sessionDiffRowWithPatch,
  sessionDiffSetCapped,
  utf8ByteLength,
  type ParsedSessionDiff,
  type SessionDiffFilePatch,
  type SessionDiffResult,
  type SessionDiffRow,
} from './session-diff-model';
import { defaultSessionLaneStore, useSessionLane, useSessionLaneRevision } from './session-lane-store';
import { useSurfaceActive } from './surface-activity';
import {
  decodeTurnReviewCapabilityValue,
  resolveSessionRows,
  summarizeSessionDiffRows,
  fileChangeKey,
  transcriptReviewKey,
  TURN_REVIEW_CAPABILITY,
  type TurnReviewCapabilityValue,
} from './turn-review-model';
import type { TurnReviewFile } from './turn-review-cache';
import { useTurnChangesEpoch } from './turn-changes-model';
import { rowListIndex } from './session-diff-row-index';
import { useSessionDiffRefresh } from './use-session-diff-refresh';
import {
  readCachedDockGitState,
  requestDockGitState,
  retainDockGitState,
  useDockGitReady,
} from './utility-dock-git-state';

// ── Source preference ────────────────────────────────────────────────────
// One global choice shared by the composer chip and every Changes pane.

/** Menu order (Codex): the conversation's own sources (the last turn, the
 *  whole session), then — after a separator — Git's sources. */
export const SESSION_CHANGES_SOURCES = ['last-turn', 'session', 'branch', 'uncommitted', 'unstaged', 'staged'] as const;
export type SessionChangesSource = (typeof SESSION_CHANGES_SOURCES)[number];
export const DEFAULT_SESSION_CHANGES_SOURCE: SessionChangesSource = 'uncommitted';

/** The runtime's own-edit reviews: one per session, not per repository root. */
function sessionScopedSource(source: SessionChangesSource): boolean {
  return source === 'last-turn' || source === 'session';
}

function isSessionChangesSource(value: unknown): value is SessionChangesSource {
  return SESSION_CHANGES_SOURCES.includes(value as SessionChangesSource);
}

export function readSessionChangesSource(): SessionChangesSource {
  try {
    const stored = window.localStorage.getItem(SESSION_CHANGES_SOURCE_KEY);
    return isSessionChangesSource(stored) ? stored : DEFAULT_SESSION_CHANGES_SOURCE;
  } catch {
    return DEFAULT_SESSION_CHANGES_SOURCE;
  }
}

const sourceListeners = new Set<() => void>();

export function setSessionChangesSource(next: SessionChangesSource): void {
  try {
    window.localStorage.setItem(SESSION_CHANGES_SOURCE_KEY, next);
  } catch {
    /* persistence only */
  }
  for (const listener of [...sourceListeners]) listener();
}

function subscribeSource(listener: () => void) {
  sourceListeners.add(listener);
  // Another window of the app changed the choice.
  window.addEventListener('storage', listener);
  return () => {
    sourceListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSessionChangesSource(): SessionChangesSource {
  return useSyncExternalStore(subscribeSource, readSessionChangesSource, () => DEFAULT_SESSION_CHANGES_SOURCE);
}

export function sessionChangesSourceLabel(source: SessionChangesSource): string {
  switch (source) {
    case 'branch':
      return t('This branch');
    case 'staged':
      return t('Staged');
    case 'unstaged':
      return t('Unstaged');
    case 'last-turn':
      return t('Last turn');
    case 'session':
      return t('Current session');
    default:
      return t('Uncommitted');
  }
}

export function sessionChangesEmptyText(source: SessionChangesSource): string {
  switch (source) {
    case 'branch':
      return t('No branch changes.');
    case 'staged':
      return t('No staged changes.');
    case 'unstaged':
      return t('No unstaged changes.');
    case 'last-turn':
      return t('No changes in the last turn.');
    case 'session':
      return t('No changes from this session.');
    default:
      return t('No uncommitted changes.');
  }
}

// ── Shared Changes cache ─────────────────────────────────────────────────
// One entry per (root, source) — the last turn per session — shared by the
// chip and the pane, read single-flight and refreshed only by Git evidence.

type ChangesTarget = { cwd: string; source: SessionChangesSource; sessionId: string };

type ChangesEntry = {
  /** null: the first read failed, so whether this is a repository is unknown. */
  repository: boolean | null;
  root: string;
  base: string;
  rows: readonly SessionDiffRow[];
  untracked: ReadonlySet<string>;
  /** Per-file content revision from the review read (path → revision); a
   *  file whose content moved without moving its counts re-reads by it. */
  revisions: ReadonlyMap<string, string>;
  sessionDiffBinding?: ReturnType<typeof sessionDiffBinding>;
  /** No file's patch fit the last turn's reply (its rows still list counts). */
  diffTooLarge: boolean;
  /** Untracked files the Git read counted but did not list: `rows` is partial by this many. */
  untrackedOmitted: number;
  /** Bumps with every adopted read that may have moved a file's patch. */
  generation: number;
  /** Bumps with each explicit (foreground) refresh: the drawn files' patches
   *  are read afresh then, even where their counts did not move. */
  patchEpoch: number;
  /** Bumps with each Git-evidence refresh: the index sources carry no
   *  per-file revision, so their drawn files' patches are read afresh then. */
  evidenceEpoch: number;
  loading: boolean;
  error: string;
};

type ChangesRead = Pick<
  ChangesEntry,
  | 'repository'
  | 'root'
  | 'base'
  | 'rows'
  | 'untracked'
  | 'revisions'
  | 'sessionDiffBinding'
  | 'diffTooLarge'
  | 'untrackedOmitted'
>;

const NO_REVISIONS: ReadonlyMap<string, string> = new Map();
const NO_REPOSITORY: ChangesRead = {
  repository: false,
  root: '',
  base: '',
  rows: [],
  untracked: new Set(),
  revisions: NO_REVISIONS,
  diffTooLarge: false,
  untrackedOmitted: 0,
};
const EMPTY_ROWS: readonly SessionDiffRow[] = [];

const ENTRIES_CACHE_MAX_ENTRIES = 64;
const ENTRIES_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const CWD_ROOTS_MAX_ENTRIES = 128;

const requests = new Map<string, Promise<boolean>>();
const entryListeners = new Set<() => void>();
const scopedEntryReaders = new Map<string, number>();
let scopedGeneration = 0;
/** A cwd inside a repository resolves to its root once a read named it. */
const cwdRoots = new Map<string, string>();
/** Per session: the cwd its latest session-source read was started for. */
const sessionReadCwds = new Map<string, string>();

function setCwdRoot(cwd: string, root: string): void {
  if (!cwd || !root) return;
  cwdRoots.delete(cwd);
  cwdRoots.set(cwd, root);
  if (cwdRoots.size > CWD_ROOTS_MAX_ENTRIES) {
    const oldest = cwdRoots.keys().next().value;
    if (oldest !== undefined) cwdRoots.delete(oldest);
  }
}

function changesKey({ cwd, source, sessionId }: ChangesTarget): string {
  if (sessionScopedSource(source)) return `${source}\0${sessionId}\0${cwd}`;
  return `${cwdRoots.get(cwd) || cwd}\0${source}`;
}

function isEntryPinned(key: string): boolean {
  if (scopedEntryReaders.has(key)) return true;
  for (const { target } of views.values()) {
    if (!sessionScopedSource(target.source)) {
      if (changesKey(target) === key || `${target.cwd}\0${target.source}` === key) return true;
    }
  }
  return false;
}

function pruneEvictedTurnPatches(): void {
  for (const turnKey of turnPatches.keys()) {
    const cut = turnKey.lastIndexOf('\0');
    const baseKey = cut > 0 ? turnKey.slice(0, cut) : turnKey;
    if (!entries.peek(baseKey)) turnPatches.delete(turnKey);
  }
}

const rowListChars = new WeakMap<readonly SessionDiffRow[], number>();
/** A row list's size, measured once per list: an entry republished with the same rows (a loading flag) is not a pass
 *  over them. */
function measureRowList(rows: readonly SessionDiffRow[]): number {
  let chars = rowListChars.get(rows);
  if (chars === undefined) {
    chars = 0;
    for (const row of rows) chars += row.path.length + row.oldPath.length + inlineBytes(row) + 96;
    rowListChars.set(rows, chars);
  }
  return chars;
}

function measureChangesEntry(entry: ChangesEntry, key: string): number {
  const chars = key.length + entry.root.length + entry.base.length + 256 + measureRowList(entry.rows);
  return Math.min(ENTRIES_CACHE_MAX_CHARS, chars);
}

const entries = new RendererLruCache<string, ChangesEntry>({
  name: 'session-changes-entries',
  maxEntries: ENTRIES_CACHE_MAX_ENTRIES,
  maxChars: ENTRIES_CACHE_MAX_CHARS,
  measure: measureChangesEntry,
  isPinned: isEntryPinned,
  onTrim: () => {
    pruneEvictedTurnPatches();
    for (const listener of [...entryListeners]) listener();
  },
});

const staleKeys = new Set<string>();
const sessionDiffSettledListeners = new Set<() => void>();
const sessionDiffFailed = new Set<string>();

function subscribeSessionDiffSettled(listener: () => void) {
  sessionDiffSettledListeners.add(listener);
  return () => {
    sessionDiffSettledListeners.delete(listener);
  };
}

function notifySessionDiffSettled(): void {
  for (const listener of [...sessionDiffSettledListeners]) listener();
}

function readEntry(target: ChangesTarget): ChangesEntry | undefined {
  return entries.peek(changesKey(target));
}

function subscribeEntries(listener: () => void) {
  entryListeners.add(listener);
  return () => {
    entryListeners.delete(listener);
  };
}

function publish(key: string, entry: ChangesEntry): void {
  prepareRowList(entry.rows);
  entries.set(key, entry);
  for (const listener of [...entryListeners]) listener();
}

/** Purges all session-scoped cached Changes entries when a session is closed. */
export function purgeSessionChanges(sessionId: string): void {
  if (!sessionId) return;
  const prefixes = [`session\0${sessionId}\0`, `last-turn\0${sessionId}\0`];
  const matches = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
  const beforeEntries = entries.size;
  const beforePatches = patches.size;
  for (const prefix of prefixes) {
    entries.deletePrefix(prefix);
    patches.deletePrefix(prefix);
  }
  for (const key of [...requests.keys()]) if (matches(key)) requests.delete(key);
  for (const key of [...staleKeys]) if (matches(key)) staleKeys.delete(key);
  for (const key of [...lastTurnAdoptions.keys()]) {
    if (!matches(key)) continue;
    const validation = lastTurnAdoptions.get(key);
    if (validation) delete validation.pending;
    lastTurnAdoptions.delete(key);
  }
  lastTurnBarOwners.delete(sessionId);
  sessionReadCwds.delete(sessionId);
  const hadFailedDiff = sessionDiffFailed.delete(sessionId);
  for (const turnKey of [...turnPatches.keys()]) if (matches(turnKey)) turnPatches.delete(turnKey);
  if (patches.size !== beforePatches) {
    patchVersion += 1;
    for (const listener of [...patchListeners]) listener();
  }
  if (entries.size !== beforeEntries) {
    for (const listener of [...entryListeners]) listener();
  }
  if (hadFailedDiff) notifySessionDiffSettled();
}

/** Pins a session or last-turn entry while a view reads it; transient cleanups
 *  unpin it in the bounded LRU without purging the cached snapshot. */
function retainScopedEntry(target: ChangesTarget, switchedWorkspace: boolean): () => void {
  const key = changesKey(target);
  const readers = scopedEntryReaders.get(key) ?? 0;
  entries.get(key);
  if (target.source === 'last-turn' && readers === 0) {
    const owner = lastTurnBarOwners.get(target.sessionId);
    // A turn-review bar reply only names the session. Give the newly opened
    // workspace the bar, but do not cancel the other workspace's own reads.
    if (switchedWorkspace || owner !== undefined) {
      staleKeys.add(key);
      lastTurnAdoptions.set(key, { ticket: nextLastTurnRequest() });
    }
    lastTurnBarOwners.set(target.sessionId, key);
  }
  scopedEntryReaders.set(key, readers + 1);
  return () => {
    const count = (scopedEntryReaders.get(key) ?? 1) - 1;
    if (count > 0) {
      scopedEntryReaders.set(key, count);
      return;
    }
    scopedEntryReaders.delete(key);
    const validation = lastTurnAdoptions.get(key);
    if (validation) delete validation.pending;
    lastTurnAdoptions.delete(key);
    if (lastTurnBarOwners.get(target.sessionId) === key) lastTurnBarOwners.delete(target.sessionId);
  };
}

function reviewRows(files: ReadonlyArray<{ path: string; status: string; additions: number; deletions: number }>) {
  return buildSessionDiffRows({ files: files.map((file) => ({ ...file })) });
}

function gitStatusRows(files: DesktopGitFile[], staged: boolean): ChangesRead['rows'] {
  const listed = files.flatMap((file) => {
    if (staged) {
      if (file.untracked || file.index === ' ' || file.index === '?') return [];
      return [
        { path: file.path, status: file.index, additions: file.stagedAdditions, deletions: file.stagedDeletions },
      ];
    }
    if (!file.untracked && file.worktree === ' ') return [];
    return [
      {
        path: file.path,
        status: file.untracked ? 'A' : file.worktree,
        additions: file.unstagedAdditions,
        deletions: file.unstagedDeletions,
      },
    ];
  });
  return reviewRows(listed);
}

/** The turn's rows, parsed a file per task. */
async function lastTurnRows(decoded: { files: TurnReviewFile[]; leadPatch: string | null }) {
  return (await parseSessionDiff({ files: decoded.files, patch: decoded.leadPatch ?? '' })).rows;
}

async function readTurnReview(sessionId: string, summary: boolean, background: boolean) {
  const reply = await window.mixdogDesktop?.invokeCapability?.({
    capability: TURN_REVIEW_CAPABILITY,
    args: [{ refresh: true, ...(summary ? { summary } : {}), ...(background ? { poll: 'background' } : {}) }],
    sessionId,
  });
  return decodeTurnReviewCapabilityValue((reply?.value ?? null) as TurnReviewCapabilityValue);
}

async function readChanges({ cwd, source, sessionId }: ChangesTarget, mode: LoadMode): Promise<ChangesRead> {
  const api = window.mixdogDesktop;
  const background = mode !== 'foreground';
  if (source === 'uncommitted' || source === 'branch') {
    if (!api?.gitReview) return NO_REPOSITORY;
    const review = await api.gitReview(cwd, source);
    if (!review.repository) return NO_REPOSITORY;
    return {
      repository: true,
      root: review.root,
      base: review.base,
      rows: reviewRows(review.files.map((file) => ({ ...file, status: file.untracked ? 'A' : file.status }))),
      untracked: new Set(review.files.filter((file) => file.untracked).map((file) => file.path)),
      revisions: new Map(review.files.filter((file) => file.revision).map((file) => [file.path, file.revision])),
      diffTooLarge: false,
      untrackedOmitted: review.untrackedOmitted ?? 0,
    };
  }
  if (source === 'staged' || source === 'unstaged') {
    if (!api?.gitStatus) return NO_REPOSITORY;
    // Reused line stats are keyed by status only (not file content): evidence
    // and explicit refreshes count afresh; only an open intent's prefetch reuses them.
    const status = await api.gitStatus(cwd, { reuseLineStats: mode === 'warm' });
    if (!status.repository) return NO_REPOSITORY;
    return {
      repository: true,
      root: status.root,
      base: '',
      rows: gitStatusRows(status.files, source === 'staged'),
      untracked: new Set(status.files.filter((file) => file.untracked).map((file) => file.path)),
      revisions: NO_REVISIONS,
      diffTooLarge: false,
      // Staged rows never include untracked files; the omitted ones are unstaged changes.
      untrackedOmitted: source === 'unstaged' ? (status.untrackedOmitted ?? 0) : 0,
    };
  }
  // The last turn and the whole session are the runtime's own-edit reviews;
  // the repository question is answered by the dock's shared status snapshot.
  const cached = readCachedDockGitState(cwd);
  const dockState = cached.ready && !cached.error ? Promise.resolve(cached) : requestDockGitState(cwd);
  if (source === 'session') {
    const join = sessionReadCwds.get(sessionId) === cwd;
    sessionReadCwds.set(sessionId, cwd);
    const [dock, result] = await Promise.all([dockState, fetchSessionDiff(sessionId, { force: true, join })]);
    if (dock.error) throw new Error(dock.error);
    if (!dock.status?.repository) return NO_REPOSITORY;
    // Parsed (a file per task) by the read itself.
    const { rows, digests } = parsedSessionDiff(result);
    // A file's patch can move while its counts hold: an inline patch's digest
    // does; a file listed without its patch is re-read with every fresh result
    // (the cache's revision), as the non-Git session diff does.
    const binding = sessionDiffBinding(result);
    const revision = `r${binding?.revision ?? sessionDiffRevision(sessionId)}`;
    return {
      repository: true,
      root: dock.status.root,
      base: '',
      rows,
      untracked: new Set(),
      revisions: new Map(
        rows.map((row) => [row.path, row.parts.length ? (digests.get(row.path) ?? revision) : revision])
      ),
      sessionDiffBinding: binding,
      diffTooLarge: result?.diffTooLarge === true,
      untrackedOmitted: 0,
    };
  }
  const [dock, decoded] = await Promise.all([dockState, readTurnReview(sessionId, true, background)]);
  if (dock.error) throw new Error(dock.error);
  if (!dock.status?.repository) return NO_REPOSITORY;
  return {
    repository: true,
    root: dock.status.root,
    base: '',
    rows: decoded ? await lastTurnRows(decoded) : [],
    untracked: new Set(),
    revisions: NO_REVISIONS,
    diffTooLarge: decoded?.diffTooLarge === true,
    untrackedOmitted: 0,
  };
}

/** foreground: asked for now; activity: Git evidence; warm: an open intent's
 *  prefetch, which reuses the line counts an unchanged status still holds. */
type LoadMode = 'foreground' | 'activity' | 'warm';

const ROW_FIELDS = [
  'id',
  'path',
  'outside',
  'oldPath',
  'status',
  'additions',
  'deletions',
  'binary',
  'reason',
  'unmeasured',
  'patchOmitted',
] as const;

function sameRow(left: SessionDiffRow, right: SessionDiffRow): boolean {
  return (
    ROW_FIELDS.every((field) => left[field] === right[field]) &&
    left.parts.length === right.parts.length &&
    left.parts.every((part, index) => part.patch === right.parts[index]?.patch)
  );
}

/** A re-read keeps the row objects (and the list) it did not move, so every
 *  memo keyed by row — a drawn file, its patch, the summary — holds. */
function keepRows(previous: readonly SessionDiffRow[] | undefined, next: readonly SessionDiffRow[]) {
  if (!previous) return next;
  if (!previous.length) return next.length ? next : previous;
  const byId = new Map(previous.map((row) => [row.id, row]));
  let moved = previous.length !== next.length;
  const rows = next.map((row, index) => {
    const known = byId.get(row.id);
    if (known && sameRow(known, row)) {
      if (previous[index] !== known) moved = true;
      return known;
    }
    moved = true;
    return row;
  });
  return moved ? rows : previous;
}

function adopt(target: ChangesTarget, read: ChangesRead, mode: LoadMode): void {
  const rawKey = sessionScopedSource(target.source) ? '' : `${target.cwd}\0${target.source}`;
  if (read.root && !sessionScopedSource(target.source)) setCwdRoot(target.cwd, read.root);
  const key = changesKey(target);
  if (rawKey && rawKey !== key) {
    entries.delete(rawKey);
    staleKeys.delete(rawKey);
    patches.deletePrefix(`${rawKey}\0`);
  }
  const previous = entries.peek(key);
  const wasStale = staleKeys.delete(key);
  const rows = keepRows(previous?.rows, read.rows);
  const changed =
    !previous ||
    previous.rows !== rows ||
    previous.repository !== read.repository ||
    previous.root !== read.root ||
    previous.base !== read.base ||
    previous.diffTooLarge !== read.diffTooLarge ||
    previous.untrackedOmitted !== read.untrackedOmitted ||
    rows.some(
      ({ path }) =>
        previous.revisions.get(path) !== read.revisions.get(path) ||
        previous.untracked.has(path) !== read.untracked.has(path)
    );
  // A prefetch that found nothing new keeps the shown entry (no render).
  if (!changed && mode === 'warm' && !wasStale && !previous.loading && !previous.error) return;
  let generation = previous?.generation ?? 0;
  if (changed || mode !== 'warm') {
    generation = sessionScopedSource(target.source) ? ++scopedGeneration : generation + 1;
  }
  const next = {
    ...read,
    rows,
    generation,
    patchEpoch: (previous?.patchEpoch ?? 0) + (mode === 'foreground' ? 1 : 0),
    evidenceEpoch: (previous?.evidenceEpoch ?? 0) + (mode === 'activity' ? 1 : 0),
    loading: false,
    error: '',
  };
  publish(key, next);
}

function markLoading(target: ChangesTarget): void {
  const key = changesKey(target);
  const previous = entries.peek(key);
  if (!previous || previous.loading) return;
  const next = { ...previous, loading: true };
  publish(key, next);
}

/** One read per (root, source) at a time; resolves true when its answer was adopted. */
function loadChanges(target: ChangesTarget, mode: LoadMode): Promise<boolean> {
  const key = changesKey(target);
  if (sessionScopedSource(target.source) && !scopedEntryReaders.has(key)) return Promise.resolve(false);
  if (mode === 'foreground') markLoading(target);
  const pending = requests.get(key);
  if (pending) return pending;
  const ticket = target.source === 'last-turn' ? nextLastTurnRequest() : undefined;
  const validation: LastTurnAdoption | undefined = ticket === undefined ? undefined : { ticket };
  if (validation) {
    lastTurnAdoptions.set(key, validation);
    // Only a fresh read can reclaim the bar after its workspace closed. Its
    // ticket rejects replies issued for the old owner.
    if (!lastTurnBarOwners.has(target.sessionId)) lastTurnBarOwners.set(target.sessionId, key);
  }
  const superseded = (): boolean =>
    requests.get(key) !== request || (ticket !== undefined && lastTurnAdoptions.get(key)?.ticket !== ticket);
  const request = readChanges(target, mode).then(
    (read) => {
      if (superseded()) return false;
      const bar = validation?.pending;
      if (validation) delete validation.pending;
      if (bar && validation && read.repository) {
        validation.ticket = bar.ticket;
        adopt(target, { ...read, rows: bar.rows, diffTooLarge: bar.diffTooLarge }, mode);
      } else adopt(target, read, mode);
      return true;
    },
    (reason: unknown) => {
      if (superseded()) return false;
      if (validation) delete validation.pending;
      staleKeys.delete(key);
      const previous = entries.peek(key);
      publish(key, {
        ...(previous ?? { ...NO_REPOSITORY, repository: null, generation: 0, patchEpoch: 0, evidenceEpoch: 0 }),
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return false;
    }
  );
  requests.set(key, request);
  void request.finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  return request;
}

/** A read that must start after now: one already running answers an earlier
 *  state (a history mutation it predates), so this one follows it. */
function reloadChanges(target: ChangesTarget): Promise<boolean> {
  const pending = requests.get(changesKey(target));
  if (!pending) return loadChanges(target, 'foreground');
  return pending.then(() => loadChanges(target, 'foreground'));
}

const watches = new Map<string, { count: number; stop(): void }>();
const views = new Map<string, { count: number; target: ChangesTarget; releaseDock: () => void }>();

/** Pins a mounted view's cached entry in the bounded LRU; transient cleanups
 *  (such as `<Activity mode="hidden">`) unpin it without deleting it. */
function retainChangesView(target: ChangesTarget): () => void {
  const id = `${target.cwd}\0${target.source}`;
  entries.get(changesKey(target));
  let view = views.get(id);
  if (!view) {
    view = { count: 0, target, releaseDock: retainDockGitState(target.cwd) };
    views.set(id, view);
  }
  const held = view;
  held.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0) return;
    views.delete(id);
    held.releaseDock();
  };
}
/** Ref-counted Git evidence watch per (cwd, source): the chip and the pane
 *  share one scheduler, which also performs the first read. */
function retainChangesWatch(target: ChangesTarget): () => void {
  const id = `${target.cwd}\0${target.source}\0${sessionScopedSource(target.source) ? target.sessionId : ''}`;
  let watch = watches.get(id);
  if (!watch) {
    const stop = watchGitRefreshEvidence(
      target.cwd,
      createGitRefreshScheduler(async () => {
        if (!(await loadChanges(target, 'activity'))) throw new Error(t('The Changes read failed.'));
      })
    );
    watch = { count: 0, stop };
    watches.set(id, watch);
  }
  const retained = watch;
  retained.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained.count -= 1;
    if (retained.count > 0) return;
    watches.delete(id);
    retained.stop();
  };
}

// Order physical reads, not replies (a mounted bar can join an older prefetch).
let lastTurnRequest = 0;
export function nextLastTurnRequest(): number {
  return ++lastTurnRequest;
}
type LastTurnAdoption = {
  ticket: number;
  pending?: { ticket: number; rows: ChangesRead['rows']; diffTooLarge: boolean };
};
const lastTurnAdoptions = new Map<string, LastTurnAdoption>();
const lastTurnBarOwners = new Map<string, string>();

/** The turn review bar's own read answered: the session's last-turn entry follows it. */
export function adoptLastTurnReview(
  sessionId: string,
  decoded: { files: TurnReviewFile[]; leadPatch: string | null; diffTooLarge?: boolean },
  ticket: number
): Promise<void> | undefined {
  const key = lastTurnBarOwners.get(sessionId);
  if (key === undefined) return;
  // Only the scheduler reads the workspace's repository status. A bar
  // answer (including an unchanged or failed read) cannot validate it.
  const validation = lastTurnAdoptions.get(key);
  if (!scopedEntryReaders.has(key) || !validation || ticket < validation.ticket) return;
  if (!staleKeys.has(key) && entries.peek(key)?.repository !== true) return;
  return lastTurnRows(decoded).then((rows) => {
    if (
      lastTurnBarOwners.get(sessionId) !== key ||
      lastTurnAdoptions.get(key) !== validation ||
      ticket < (validation.pending?.ticket ?? validation.ticket)
    )
      return;
    const diffTooLarge = decoded.diffTooLarge === true;
    if (staleKeys.has(key)) {
      // Keep the rows with this validation, not the session. A switch
      // replaces the record, and only a successful repository read uses it.
      validation.pending = { ticket, rows, diffTooLarge };
      return;
    }
    const previous = entries.peek(key);
    if (previous?.repository !== true) return;
    validation.ticket = ticket;
    const read = { ...previous, rows: keepRows(previous.rows, rows), diffTooLarge };
    if (
      previous.rows === read.rows &&
      previous.diffTooLarge === read.diffTooLarge &&
      !previous.loading &&
      !previous.error
    )
      return;
    publish(key, { ...read, loading: false, error: '', generation: ++scopedGeneration });
  });
}

// ── Lazy per-file patches ────────────────────────────────────────────────

// An uncapped set (≤ 12 MiB of patch text, ≤ 128 files) is read whole and
// must fit, or an evicted file would wait on "Loading diff…".
const PATCH_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const PATCH_CACHE_MAX_ENTRIES = 4096;
/** File patch reads in flight at once (each is a Git process in main). */
const PATCH_READ_CONCURRENCY = 4;
/** Landed patches are announced together, at most once per this window. */
const PATCH_NOTIFY_MS = 100;
const activePatchKeys = new Map<string, number>();

function retainActivePatchKeys(keys: readonly string[]): () => void {
  for (const cacheKey of keys) {
    activePatchKeys.set(cacheKey, (activePatchKeys.get(cacheKey) ?? 0) + 1);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const cacheKey of keys) {
      const count = (activePatchKeys.get(cacheKey) ?? 1) - 1;
      if (count > 0) activePatchKeys.set(cacheKey, count);
      else activePatchKeys.delete(cacheKey);
    }
  };
}

let patchEvictionEpoch = 0;

function notifyPatchEviction(immediate: boolean): void {
  patchEvictionEpoch += 1;
  if (immediate) {
    patchVersion += 1;
    for (const listener of [...patchListeners]) listener();
  } else {
    notifyPatches();
  }
}

const patches = new RendererLruCache<
  string,
  { stamp: string; seq: number; bytes: number; failed?: boolean; hadPatch?: boolean } & SessionDiffFilePatch
>({
  name: 'session-changes-patch',
  maxEntries: PATCH_CACHE_MAX_ENTRIES,
  maxChars: PATCH_CACHE_MAX_CHARS,
  measure: (value, key) => value.patch.length + key.length,
  isPinned: (cacheKey) => (activePatchKeys.get(cacheKey) ?? 0) > 0,
  onTrim: () => notifyPatchEviction(false),
});
const patchRequests = new Set<string>();
let patchSeq = 0;
/** The newest read asked for per file: an older queued read is dropped. */
const patchWanted = new Map<string, number>();
const patchQueue: Array<() => Promise<void>> = [];
let patchReadsRunning = 0;
const turnPatches = new Map<string, Promise<ParsedSessionDiff>>();
const patchListeners = new Set<() => void>();
let patchVersion = 0;
let patchNotifyTimer: ReturnType<typeof setTimeout> | 0 = 0;

registerIdleReclaim(() => {
  const hadTurn = turnPatches.size > 0;
  if (!patches.size && !hadTurn) return;
  const before = patches.size;
  turnPatches.clear();
  patches.trim(0);
  if (hadTurn || patches.size !== before) notifyPatchEviction(true);
});

function subscribePatches(listener: () => void) {
  patchListeners.add(listener);
  return () => {
    patchListeners.delete(listener);
  };
}

/** One render per burst of landed patches, not one per file. */
function notifyPatches(): void {
  if (patchNotifyTimer) return;
  patchNotifyTimer = setTimeout(() => {
    patchNotifyTimer = 0;
    patchVersion += 1;
    for (const listener of [...patchListeners]) listener();
  }, PATCH_NOTIFY_MS);
}

function pumpPatchReads(): void {
  while (patchReadsRunning < PATCH_READ_CONCURRENCY && patchQueue.length > 0) {
    const run = patchQueue.shift() as () => Promise<void>;
    patchReadsRunning += 1;
    void run().finally(() => {
      patchReadsRunning -= 1;
      pumpPatchReads();
    });
  }
}

const textPatch = (patch: string | undefined): SessionDiffFilePatch => ({ patch: patch ?? '', tooLarge: false });

function readFilePatch(
  target: ChangesTarget,
  key: string,
  entry: ChangesEntry,
  row: SessionDiffRow
): Promise<SessionDiffFilePatch> {
  const api = window.mixdogDesktop;
  const root = entry.root || target.cwd;
  const { path } = row;
  const untracked = entry.untracked.has(path);
  switch (target.source) {
    case 'staged':
      return (api?.gitDiff?.(root, path, true) ?? Promise.resolve('')).then(textPatch);
    case 'unstaged':
      return (api?.gitDiff?.(root, path, false, true, untracked) ?? Promise.resolve('')).then(textPatch);
    case 'last-turn': {
      // A file the turn's reply listed without its patch (too large for it)
      // is read on its own.
      if (row.patchOmitted) {
        return Promise.resolve(
          api?.invokeCapability?.({ capability: 'getTurnReviewFilePatch', args: [path], sessionId: target.sessionId })
        ).then((reply) => decodeSessionDiffFilePatch(reply?.value));
      }
      // One full turn read per generation serves every other file's slice.
      const turnKey = `${key}\0${entry.generation}`;
      let turn = turnPatches.get(turnKey);
      if (!turn) {
        turn = readTurnReview(target.sessionId, false, false).then((decoded) =>
          parseSessionDiff({ patch: decoded?.leadPatch ?? '' })
        );
        if (entries.peek(key)?.generation === entry.generation) {
          turnPatches.clear();
          turnPatches.set(turnKey, turn);
        }
      }
      return turn.then((parsed) => textPatch(sessionDiffFileSlice(parsed, path)));
    }
    case 'session':
      // The displayed row is authoritative even when its list did not fit the LRU.
      return row.patchOmitted
        ? fetchOmittedSessionDiffFilePatch(target.sessionId, row, entry.sessionDiffBinding?.revision)
        : Promise.resolve(textPatch(''));
    default:
      return (api?.gitReviewDiff?.(root, path, untracked, target.source) ?? Promise.resolve('')).then(textPatch);
  }
}

type PatchJob = { cacheKey: string; stamp: string; seq: number; requestKey: string };

/** Claims one file's read for `stamp`; null when that stamp's patch is held
 *  (or already being read). */
function claimPatch(cacheKey: string, stamp: string): PatchJob | null {
  const held = patches.peek(cacheKey);
  if (held?.stamp === stamp && !held.failed) return null;
  const requestKey = `${cacheKey}\0${stamp}`;
  if (patchRequests.has(requestKey)) return null;
  patchRequests.add(requestKey);
  patchSeq += 1;
  patchWanted.set(cacheKey, patchSeq);
  return { cacheKey, stamp, seq: patchSeq, requestKey };
}

/** A newer read was asked for while this one queued, or its patch arrived. */
function patchJobStale({ cacheKey, stamp, seq }: PatchJob): boolean {
  if ((patchWanted.get(cacheKey) ?? 0) > seq) return true;
  const held = patches.peek(cacheKey);
  return held?.stamp === stamp && !held.failed;
}

/** Adopts a read's answer (null: the read failed). Listeners hear (batched)
 *  only when a file's patch text actually moved. */
function landPatch({ cacheKey, stamp, seq }: PatchJob, answer: SessionDiffFilePatch | null): void {
  const current = patches.peek(cacheKey);
  if (current && current.seq > seq) return;
  if (answer === null) {
    // A failed read is never "no textual differences" and never passes for
    // the current text: record the failure, keeping the last good text (if
    // any) to draw beside the notice.
    const hadPatch = Boolean(current && (!current.failed || current.hadPatch === true));
    const kept = hadPatch && current ? current : null;
    patches.set(cacheKey, {
      stamp,
      seq,
      failed: true,
      hadPatch,
      patch: kept?.patch ?? '',
      bytes: kept?.bytes ?? 0,
      tooLarge: kept?.tooLarge ?? false,
    });
    notifyPatches();
    return;
  }
  // Text past the per-file limits is never kept: the file says it is too large.
  const value = !answer.tooLarge && sessionDiffPatchTooLarge(answer.patch) ? { patch: '', tooLarge: true } : answer;
  if (current && !current.failed && current.patch === value.patch && current.tooLarge === value.tooLarge) {
    // Same text re-read: the drawn row stays as it is (no render).
    current.stamp = stamp;
    current.seq = seq;
    return;
  }
  patches.set(cacheKey, { stamp, seq, bytes: utf8ByteLength(value.patch), ...value });
  notifyPatches();
}

function releasePatch({ cacheKey, seq, requestKey }: PatchJob): void {
  patchRequests.delete(requestKey);
  if (patchWanted.get(cacheKey) === seq) patchWanted.delete(cacheKey);
}

function enqueuePatchRead(run: () => Promise<void>): void {
  patchQueue.push(run);
  pumpPatchReads();
}

/** Read one file's patch for `stamp` once, through the bounded queue. */
function requestPatch(cacheKey: string, stamp: string, read: () => Promise<SessionDiffFilePatch>): void {
  const job = claimPatch(cacheKey, stamp);
  if (!job) return;
  enqueuePatchRead(async () => {
    try {
      if (patchJobStale(job)) return;
      landPatch(job, await read().catch(() => null));
    } finally {
      releasePatch(job);
    }
  });
}

type BatchFile = { cacheKey: string; stamp: string; path: string; untracked: boolean };

/** Every file of one refresh that needs its patch, read as ONE batch; a path
 *  the batch could not serve (`omitted`) is read on its own. */
function requestPatchBatch(
  files: readonly BatchFile[],
  read: (
    files: { path: string; untracked: boolean }[]
  ) => Promise<{ patches: readonly { path: string; patch: string }[]; omitted: readonly string[] }>,
  readOne: (file: BatchFile) => Promise<SessionDiffFilePatch>
): void {
  const claimed = files.flatMap((file) => {
    const job = claimPatch(file.cacheKey, file.stamp);
    return job ? [{ job, file }] : [];
  });
  if (claimed.length === 0) return;
  enqueuePatchRead(async () => {
    const handedOff = new Set<PatchJob>();
    try {
      const live = claimed.filter(({ job }) => !patchJobStale(job));
      if (live.length === 0) return;
      const answer = await read(live.map(({ file }) => ({ path: file.path, untracked: file.untracked }))).catch(
        () => null
      );
      const omitted = new Set(answer?.omitted ?? []);
      // A Map over the entries: paths such as `__proto__` or `constructor` are
      // file names, and a path the answer does not carry is unread, not unchanged.
      const patchOf = new Map((answer?.patches ?? []).map((entry) => [entry.path, entry.patch]));
      for (const { job, file } of live) {
        if (!answer) landPatch(job, null);
        else if (!omitted.has(file.path)) {
          const patch = patchOf.get(file.path);
          landPatch(job, patch === undefined ? null : textPatch(patch));
        } else {
          handedOff.add(job);
          enqueuePatchRead(async () => {
            try {
              if (!patchJobStale(job)) landPatch(job, await readOne(file).catch(() => null));
            } finally {
              releasePatch(job);
            }
          });
        }
      }
    } finally {
      for (const { job } of claimed) if (!handedOff.has(job)) releasePatch(job);
    }
  });
}

const inlineByteCounts = new WeakMap<SessionDiffRow, number>();
/** A row's own patch parts in UTF-8 bytes, measured once per row object. */
function inlineBytes(row: SessionDiffRow): number {
  let bytes = inlineByteCounts.get(row);
  if (bytes === undefined) {
    bytes = 0;
    for (const part of row.parts) bytes += utf8ByteLength(part.patch);
    inlineByteCounts.set(row, bytes);
  }
  return bytes;
}

/** A Git file's patch moves with its status, counts and content revision (or
 *  an explicit refresh); the index sources carry no revision, so theirs moves
 *  with Git evidence. The last turn's and the session diff's with their result. */
function gitPatchStamp(target: ChangesTarget, entry: ChangesEntry, row: SessionDiffRow): string {
  if (sessionScopedSource(target.source)) return `g${entry.generation}`;
  const untracked = entry.untracked.has(row.path) ? 'u' : '';
  const content =
    target.source === 'staged' || target.source === 'unstaged'
      ? `a${entry.evidenceEpoch}`
      : (entry.revisions.get(row.path) ?? '');
  return `e${entry.patchEpoch}\0${content}\0${row.status}${untracked}\0${row.additions}\0${row.deletions}\0${row.oldPath}`;
}

/** Asks for these Git files' patches (single-flight per file and stamp, so the
 *  pane's own request for the same files joins a prefetch instead of repeating it). */
function requestGitPatches(target: ChangesTarget, key: string, entry: ChangesEntry, rows: readonly SessionDiffRow[]) {
  const api = window.mixdogDesktop;
  const root = entry.root || target.cwd;
  const source = target.source;
  const cacheKeyOf = (row: SessionDiffRow) => `${key}\0${row.path}`;
  const readBatch = api?.gitReviewDiffs;
  if ((source === 'uncommitted' || source === 'branch') && readBatch) {
    const batch = rows.map((row) => ({
      cacheKey: cacheKeyOf(row),
      stamp: gitPatchStamp(target, entry, row),
      path: row.path,
      untracked: entry.untracked.has(row.path),
    }));
    const rowOf = new Map(rows.map((row) => [cacheKeyOf(row), row]));
    requestPatchBatch(
      batch,
      (files) => readBatch(root, files, source),
      (file) => readFilePatch(target, key, entry, rowOf.get(file.cacheKey) as SessionDiffRow)
    );
    return;
  }
  for (const row of rows) {
    requestPatch(cacheKeyOf(row), gitPatchStamp(target, entry, row), () => readFilePatch(target, key, entry, row));
  }
}

const wantedSets = new WeakMap<
  readonly SessionDiffRow[],
  Map<string, { version: number; capped: boolean; wanted: SessionDiffRow[] }>
>();

function wantedPatchRows(
  rows: readonly SessionDiffRow[],
  /** Names `lazy` and `rowKey` (the reader's source and key). */
  kind: string,
  lazy: (row: SessionDiffRow) => boolean,
  rowKey: (row: SessionDiffRow) => string,
  selectedId: string
): { capped: boolean; wantedRows: SessionDiffRow[] } {
  let byKind = wantedSets.get(rows);
  if (!byKind) {
    byKind = new Map();
    wantedSets.set(rows, byKind);
  }
  let set = byKind.get(kind);
  if (set?.version !== patchVersion) {
    // The set's patch text in UTF-8 bytes: inline parts, plus what the lazy
    // files read so far. Summed only for a set within the file limit, so a
    // set of any size past it costs nothing per file here.
    const capped = sessionDiffSetCapped(rows, () => {
      let bytes = 0;
      for (const row of rows) bytes += lazy(row) ? (patches.peek(rowKey(row))?.bytes ?? 0) : inlineBytes(row);
      return bytes;
    });
    set = { version: patchVersion, capped, wanted: capped ? [] : rows.filter((row) => wantedRow(lazy, row)) };
    byKind.set(kind, set);
  }
  if (!set.capped) return { capped: false, wantedRows: set.wanted };
  const selected = rows[rowListIndex(rows).byId.get(selectedId) ?? -1];
  return { capped: true, wantedRows: selected && wantedRow(lazy, selected) ? [selected] : [] };
}

const wantedRow = (lazy: (row: SessionDiffRow) => boolean, row: SessionDiffRow) =>
  lazy(row) && !sessionDiffRowOverLineLimit(row);

const publishedSelections = new Map<string, { sessionId: string; path: string }>();

/** A mounted pane publishes its current pick; the returned function
 *  unpublishes it. Nothing flows back into the pane. */
export function publishPaneSelection(paneKey: string, sessionId: string, path: string): () => void {
  const published = { sessionId, path };
  publishedSelections.set(paneKey, published);
  return () => {
    if (publishedSelections.get(paneKey) === published) publishedSelections.delete(paneKey);
  };
}

/** What the pane of this key draws for the session: its published pick, or ''
 *  (the first row) for a pane that is not mounted — what a fresh pane picks. */
function publishedSelection(paneKey: string, sessionId: string): string {
  const published = publishedSelections.get(paneKey);
  return published?.sessionId === sessionId ? published.path : '';
}
/** The file the pane of `paneKey` will draw for a capped set when an entry
 *  opens it: the entry's own file, else the pane's published pick. */
export function intentSelectedRow<Row extends { path: string }>(
  rows: readonly Row[],
  sessionId: string,
  paneKey: string,
  focusPath: string
): Row | null {
  const focusRow = focusPath ? (rows[rowListIndex(rows).byPath.get(focusPath) ?? -1] ?? null) : null;
  return resolveSelectedRow(rows, focusRow, publishedSelection(paneKey, sessionId));
}

/** The file a capped set draws: the focused file tab, else the retained
 *  pick, else the first row. */
export function resolveSelectedRow<Row extends { path: string }>(
  rows: readonly Row[],
  focusRow: Row | null,
  selectedPath: string
): Row | null {
  return (
    focusRow ?? (selectedPath ? rows[rowListIndex(rows).byPath.get(selectedPath) ?? -1] : undefined) ?? rows[0] ?? null
  );
}

/** Per session: the workspaces its Changes readers are reading, counted per
 *  reader. An entry lives only while a reader does, so intent never reads a
 *  workspace nothing shows any more. */
const changesReaders = new Map<string, Map<string, number>>();

function registerChangesReader(session: string, cwd: string): () => void {
  let byCwd = changesReaders.get(session);
  if (!byCwd) {
    byCwd = new Map();
    changesReaders.set(session, byCwd);
  }
  byCwd.set(cwd, (byCwd.get(cwd) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = changesReaders.get(session);
    const count = (current?.get(cwd) ?? 0) - 1;
    if (!current) return;
    if (count > 0) current.set(cwd, count);
    else current.delete(cwd);
    if (current.size === 0) changesReaders.delete(session);
  };
}

/** The user signalled intent to open Changes (menu open, press or focus on an
 *  entry): do what the open itself will do first — read the list (a failed or
 *  absent one is read again, as the open does) and ask for the same patches in
 *  the same batch — so the open finds them landed. Safe to call repeatedly:
 *  the list read and every patch are single-flight, and the open's own
 *  requests join them. `paneKey`: the pane whose dock the entry opens (its
 *  published pick decides a capped set's file; a pane not mounted opens on the
 *  first row). `focusPath`: the file the entry opens on, if it names one. */
export function prefetchSessionChanges(
  sessionId: string | undefined,
  { paneKey = '', focusPath = '' }: { paneKey?: string; focusPath?: string } = {}
): void {
  const session = String(sessionId || '');
  for (const cwd of changesReaders.get(session)?.keys() ?? []) {
    const target: ChangesTarget = { cwd, source: readSessionChangesSource(), sessionId: session };
    const warm = () => {
      const entry = readEntry(target);
      if (entry?.repository !== true) return;
      const key = changesKey(target);
      const selected = intentSelectedRow(entry.rows, session, paneKey, focusPath);
      const { wantedRows } = wantedPatchRows(
        entry.rows,
        `git\0${key}`,
        (row) => row.parts.length === 0 && !row.reason,
        (row) => `${key}\0${row.path}`,
        selected?.id ?? ''
      );
      requestGitPatches(target, key, entry, wantedRows);
    };
    const held = readEntry(target);
    if (held && !held.error && !staleKeys.has(changesKey(target))) warm();
    else void loadChanges(target, 'warm').then(warm);
  }
}

/** Completes the pane's rows with their own patches: a Git row listed with
 *  counts only, or a session-diff row its reply listed without its patch for
 *  size. Codex's model: an uncapped set reads every file's patch at once (one
 *  batch per refresh for the review sources); a capped one reads only the
 *  selected file. A file whose stamp held keeps its patch without a read.
 *  `withPatch` returns the row to draw (stable per input row and patch). */
export function useSessionChangePatches({
  cwd,
  sessionId,
  diff = null,
  rows,
  selectedId,
}: {
  cwd: string | undefined;
  sessionId: string;
  diff?: SessionDiffResult | null;
  rows: readonly SessionDiffRow[];
  /** The one file a capped set reads and draws. */
  selectedId: string;
}): { withPatch(row: SessionDiffRow): SessionDiffRow; capped: boolean } {
  const surfaceActive = useSurfaceActive();
  const source = useSessionChangesSource();
  const target = useMemo(() => ({ cwd: String(cwd || ''), source, sessionId }), [cwd, source, sessionId]);
  const entry = useSyncExternalStore(subscribeEntries, () => (target.cwd ? readEntry(target) : undefined));
  const version = useSyncExternalStore(subscribePatches, () => patchVersion);
  const evictionEpoch = useSyncExternalStore(subscribePatches, () => patchEvictionEpoch);
  const git = entry?.repository === true;
  // Without a repository the rows are the runtime's session diff.
  const sessionDiff = !git && (!target.cwd || entry?.repository === false) && Boolean(sessionId);
  const key = git ? changesKey(target) : `session\0${sessionId}`;
  // Every adopted read re-checks the wanted files: a missing or failed patch
  // is asked for again; one whose stamp held reads nothing.
  const generation = git ? entry.generation : (sessionDiffBinding(diff)?.revision ?? sessionDiffRevision(sessionId));
  const lazy = (row: SessionDiffRow) =>
    row.parts.length === 0 && ((git && !row.reason) || (sessionDiff && row.patchOmitted === true));
  const rowKey = (row: SessionDiffRow) => `${key}\0${git ? row.path : row.id}`;
  const stampOf = (row: SessionDiffRow) => (git ? gitPatchStamp(target, entry, row) : `r${generation}`);
  let patchScope = 'none';
  if (git) patchScope = 'git';
  else if (sessionDiff) patchScope = 'session';
  const kind = `${patchScope}\0${key}`;
  const { capped, wantedRows } = wantedPatchRows(rows, kind, lazy, rowKey, selectedId);
  // The reads' names, once per wanted set and entry (a data change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the wanted set, the entry and the generation are what the stamps read
  const wantedKey = useMemo(
    () => wantedRows.map((row) => `${rowKey(row)}\0${stampOf(row)}`).join('\0\0'),
    [wantedRows, entry, generation, kind]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedRows and kind determine the active cache keys
  const activeKeys = useMemo(() => wantedRows.map((row) => rowKey(row)), [wantedRows, kind]);
  const activeKeysToken = activeKeys.join('\0\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKeysToken tracks the exact key set
  useEffect(() => {
    if (!surfaceActive || activeKeys.length === 0) return;
    return retainActivePatchKeys(activeKeys);
  }, [surfaceActive, activeKeysToken]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedKey (rows and stamps) with generation, selectedId, evictionEpoch and surfaceActive names the reads
  useEffect(() => {
    if (!surfaceActive) return;
    if (git && entry) {
      requestGitPatches(target, key, entry, wantedRows);
      return;
    }
    if (!sessionDiff) return;
    for (const row of wantedRows) {
      requestPatch(rowKey(row), stampOf(row), () => fetchOmittedSessionDiffFilePatch(sessionId, row, generation));
    }
  }, [wantedKey, generation, git, sessionDiff, selectedId, evictionEpoch, surfaceActive]);
  const memo = useRef(new WeakMap<SessionDiffRow, { held: object | null; row: SessionDiffRow }>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger; the patch cache is read at call time
  const withPatch = useCallback(
    (row: SessionDiffRow) => {
      if (!lazy(row)) return row;
      const held = patches.get(rowKey(row)) ?? null;
      const known = memo.current.get(row);
      if (known && known.held === held) return known.row;
      let next: SessionDiffRow;
      if (held === null) next = { ...row, patchPending: true };
      else {
        if (held.tooLarge) next = { ...row, patchTooLarge: true };
        else if (held.failed && !held.hadPatch) next = row;
        else next = sessionDiffRowWithPatch(row, held.patch);
        if (held.failed) next = { ...next, patchFailed: true };
      }
      memo.current.set(row, { held, row: next });
      return next;
    },
    [git, sessionDiff, key, version]
  );
  return { withPatch, capped };
}

// ── The hook ─────────────────────────────────────────────────────────────

/** A digest of every transcript item's completion state and place, so a tool finishing anywhere in the transcript (not
 *  only at the last item) moves the key when the lane carries no publication revision (remote / mobile lanes), and so
 *  does a row that comes, goes or changes place. */
export function completionDigest(items: readonly TranscriptItem[]): string {
  return (completionStates(items).sum >>> 0).toString(36);
}

/** An item's completion state, read once per item object. */
const completionHashes = new WeakMap<TranscriptItem, number>();
/** Summed per list, each with its place, and carried on from the list a frame made it from: a frame's unchanged items are
 *  not read again. */
const completionStates = carriedSum((item: TranscriptItem, index: number) => {
  let hash = item ? completionHashes.get(item) : undefined;
  if (hash === undefined) {
    hash = textHash(
      `${item?.id ?? ''}|${item?.completedAt ?? ''}|${item?.completedCount ?? ''}|${item?.status ?? ''}|${
        item?.streaming ? 1 : 0
      }|${item?.isError ? 1 : 0}|${item?.result === undefined ? 0 : 1}`
    );
    if (item) completionHashes.set(item, hash);
  }
  return placedHash(hash, index);
});

/** `revision` is the lane's authoritative content revision (publication
 *  envelope); the transcript fields alone miss a tool completing before the
 *  last item. Without one, the completion digest stands in for it. */
function activityKey(snapshot: Snapshot | null, revision: number | null = null): string {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const last = items.at(-1);
  return [
    items.length,
    String(last?.id || ''),
    String(last?.completedAt || last?.completedCount || ''),
    revision === null ? `d${completionDigest(items)}` : String(revision),
    snapshot?.busy ? '1' : '0',
    snapshot?.commandBusy ? '1' : '0',
  ].join(':');
}

/** Lane equality for one session: with a publication revision the revision
 *  stands for content, so no transcript is scanned; without one the memoized
 *  completion digest decides. */
function sessionDiffSnapshotsEqualFor(session: string) {
  // The revision last seen: a moved revision is a change even when the
  // snapshots look alike.
  let seen = defaultSessionLaneStore.revision(session);
  return (left: Snapshot, right: Snapshot): boolean => {
    const revision = defaultSessionLaneStore.revision(session);
    const moved = revision !== seen;
    seen = revision;
    return !moved && activityKey(left, revision) === activityKey(right, revision);
  };
}

// Every reader of one list (the chip, each pane that opens) shares one
// summary and one resolved list per data change: a pane's mount never walks
// the files again.
const EMPTY_ITEMS: TranscriptItem[] = [];
const summaries = new WeakMap<readonly SessionDiffRow[], ReturnType<typeof summarizeSessionDiffRows>>();
function rowsSummary(rows: readonly SessionDiffRow[]) {
  let summary = summaries.get(rows);
  if (!summary) {
    summary = summarizeSessionDiffRows(rows);
    summaries.set(rows, summary);
  }
  return summary;
}
/** Everything a list's readers look up, built when the list is adopted (a
 *  data change), never when a reader opens. */
function prepareRowList(rows: readonly SessionDiffRow[]): void {
  rowListIndex(rows);
  rowsSummary(rows);
}
const resolvedRows = new WeakMap<SessionDiffResult, { review: string; project: string; rows: SessionDiffRow[] }>();
function resolvedSessionRows(result: SessionDiffResult | null, items: TranscriptItem[], project: string) {
  if (!result) return resolveSessionRows(result, items, project);
  const known = resolvedRows.get(result);
  // The transcript completes the rows from the items its review reads, in their order: a frame that changed none of
  // them, and moved none, resolves nothing.
  const review = transcriptReviewKey(items);
  if (known && known.review === review && known.project === project) return known.rows;
  const rows = resolveSessionRows(result, items, project);
  prepareRowList(rows);
  resolvedRows.set(result, { review, project, rows });
  return rows;
}

/** The session's Changes: the selected Git source for a repository root, else
 *  the runtime's session diff completed with the transcript's own edits. */
export function useSessionChanges({
  cwd,
  sessionId,
  active,
  gitOnly = false,
}: {
  cwd: string | undefined;
  sessionId: string | undefined;
  active: boolean;
  gitOnly?: boolean;
}) {
  const source = useSessionChangesSource();
  const project = String(cwd || '');
  const session = String(sessionId || '');
  const target = useMemo(() => ({ cwd: project, source, sessionId: session }), [project, source, session]);
  // The workspace moved (a merge or removal back to the project folder): the
  // new cwd's cached counts predate the move, so none render until it is read.
  const seenCwd = useRef(project);
  if (seenCwd.current !== project) {
    if (seenCwd.current && project && source !== 'last-turn') {
      const key = changesKey(target);
      staleKeys.add(key);
    }
    seenCwd.current = project;
  }
  const entry = useSyncExternalStore(subscribeEntries, () => (project ? readEntry(target) : undefined));
  // A project folder is a Git candidate until a read answers otherwise.
  const git = Boolean(project) && entry?.repository !== false;
  const watchable = git && (!sessionScopedSource(source) || Boolean(session));
  const sameLane = useMemo(() => sessionDiffSnapshotsEqualFor(session), [session]);
  const lane = useSessionLane(session, defaultSessionLaneStore, sameLane, active);
  const laneRevision = useSessionLaneRevision(session, defaultSessionLaneStore, active);
  const revision = activityKey(lane, laneRevision);
  const busy = Boolean(lane?.busy || lane?.commandBusy);
  // The session diff re-reads on what can change files (a finished tool that
  // may write, a turn's end via `busy`), not on every lane publication.
  const laneItemsForKey = lane?.items;
  const changeRevision = useMemo(() => `${fileChangeKey(laneItemsForKey)}:${busy ? 1 : 0}`, [laneItemsForKey, busy]);
  const fallback = !gitOnly && !git;
  const diff = useSessionDiffRefresh({ sessionId: fallback ? session : '', active, revision: changeRevision });
  let diffOutcome: '' | 'ok' | 'err' = '';
  if (fallback && session) {
    if (diff.result) diffOutcome = 'ok';
    else if (diff.error) diffOutcome = 'err';
  }
  // Notify parent rail hydration checks when a non-Git workspace's fallback
  // session diff finishes loading so `useSessionChangesSettled` exits settling.
  useLayoutEffect(() => {
    if (!diffOutcome || !session) return;
    if (diffOutcome === 'ok') sessionDiffFailed.delete(session);
    else sessionDiffFailed.add(session);
    notifySessionDiffSettled();
  }, [diffOutcome, session]);
  const lastScopedTarget = useRef<ChangesTarget | null>(null);
  useEffect(() => {
    if (!active || !project || !session || !sessionScopedSource(source)) return;
    const previous = lastScopedTarget.current;
    lastScopedTarget.current = target;
    return retainScopedEntry(target, previous?.sessionId === session && previous.cwd !== project);
  }, [active, project, session, source, target]);
  useEffect(() => {
    if (!active || !project) return;
    return retainChangesView(target);
  }, [active, project, target]);
  useEffect(() => {
    if (!active || !watchable) return;
    return retainChangesWatch(target);
  }, [active, target, watchable]);
  // A reader of this session and workspace, whatever the source: a source
  // change is no gap in it, so what the session retained survives one.
  useEffect(() => {
    if (!active || !watchable || !project || !session) return;
    return registerChangesReader(session, project);
  }, [active, watchable, project, session]);
  // Undo/Reapply and Delete history move the session review without touching
  // Git evidence, so its entry re-reads on the session's history epoch.
  const mutations = useTurnChangesEpoch(session);
  const seenMutations = useRef(mutations);
  useEffect(() => {
    if (seenMutations.current === mutations) return;
    seenMutations.current = mutations;
    if (active && watchable && source === 'session') void reloadChanges(target);
  }, [active, mutations, source, target, watchable]);
  const laneItems = lane?.items;
  const latestCheckpoint = useMemo(() => latestTurnCheckpoint(laneItems), [laneItems]);
  const rows = useMemo(() => {
    if (!fallback) return entry?.rows ?? EMPTY_ROWS;
    const items = Array.isArray(laneItems) ? laneItems : EMPTY_ITEMS;
    return resolvedSessionRows(diff.result, items, project);
  }, [fallback, diff.result, laneItems, project, entry?.rows]);
  const summary = rowsSummary(rows);
  const diffRefresh = diff.refresh;
  const refresh = useCallback(
    async (force = true, background = false): Promise<boolean> => {
      if (!git) return diffRefresh(force, background);
      if (!active || !watchable || document.visibilityState === 'hidden') return false;
      return loadChanges(target, background ? 'activity' : 'foreground');
    },
    [active, diffRefresh, git, target, watchable]
  );
  return {
    repository: git && entry?.repository === true,
    root: entry?.root ?? '',
    base: entry?.base ?? '',
    source,
    setSource: setSessionChangesSource,
    rows,
    summary,
    loading: git ? (watchable && !entry) || Boolean(entry?.loading) : diff.loading,
    error: git ? (entry?.error ?? '') : diff.error,
    refresh,
    /** A read has answered (Git entry, or the session diff). An entry whose
     *  reads have only failed is unknown, not an empty answer. */
    ready: fallback ? Boolean(diff.result) : entry !== undefined && entry.repository !== null,
    /** Adopted reads, so a waiter can tell a refresh it did not issue landed. */
    adoptions: git ? (entry?.generation ?? 0) : diff.adoptions,
    /** The non-Git session diff (null for a Git root). */
    diff: git ? null : diff.result,
    /** No file's patch fit the reply; the rows still list every file's counts. */
    diffTooLarge: git ? entry?.diffTooLarge === true : diff.result?.diffTooLarge === true,
    /** Untracked files a Git source counted but did not list in `rows`. */
    untrackedOmitted: git ? (entry?.untrackedOmitted ?? 0) : 0,
    revision,
    /** What the latest turn's review moves with while the session is idle:
     *  its checkpoint and the history epoch (Undo/Reapply/Delete). Lane
     *  republishes (agent status reaching an idle Lead) leave it alone. */
    turnReviewKey: `${mutations}:${latestCheckpoint}`,
    busy,
  };
}

/** Whether the initial Changes/Git hydration for `(cwd, sessionId)` has settled
 *  (without starting watches or IPCs). */
export function useSessionChangesSettled(cwd: string, sessionId: string, enabled: boolean): boolean {
  const source = useSessionChangesSource();
  const project = String(cwd || '');
  const session = String(sessionId || '');
  const entry = useSyncExternalStore(
    subscribeEntries,
    () => (enabled && project ? readEntry({ cwd: project, source, sessionId: session }) : undefined),
    () => undefined
  );
  const needsSessionDiff = enabled && Boolean(project) && Boolean(session) && entry?.repository === false;
  const sessionDiffReady = useSyncExternalStore(
    subscribeSessionDiffSettled,
    () => (!needsSessionDiff ? true : peekSessionDiff(session) !== null || sessionDiffFailed.has(session)),
    () => !needsSessionDiff
  );
  const needsDockStatus =
    enabled &&
    Boolean(project) &&
    entry?.repository === true &&
    entry.rows.length === 0 &&
    entry.untrackedOmitted === 0;
  const dockReady = useDockGitReady(needsDockStatus ? project : '');
  if (!enabled || !project) return true;
  if (sessionScopedSource(source) && !session) return true;
  if (!entry) return false;
  if (entry.repository === false) return sessionDiffReady;
  if (needsDockStatus) return dockReady;
  return true;
}

/** The checkpoint the newest turn opened or closed ('' before any turn). */
function latestTurnCheckpoint(items: readonly TranscriptItem[] | undefined): string {
  if (!Array.isArray(items)) return '';
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const checkpointId = items[index]?.checkpointId;
    if (typeof checkpointId === 'string' && checkpointId) return checkpointId;
  }
  return '';
}
