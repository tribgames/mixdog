import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DesktopGitFile } from '../shared/contract';
import { SESSION_CHANGES_SOURCE_KEY, type Snapshot, type TranscriptItem } from './desktop-types';
import { createGitRefreshScheduler, watchGitRefreshEvidence, type GitRefreshReason } from './git-refresh-scheduler';
import { t } from './i18n';
import { RendererLruCache } from './renderer-lru-cache';
import { fetchSessionDiff, fetchSessionDiffFilePatchResult, sessionDiffRevision } from './session-diff-cache';
import {
  buildSessionDiffRows,
  decodeSessionDiffFilePatch,
  sessionDiffFilePatch,
  sessionDiffPatchTooLarge,
  sessionDiffRowOverLineLimit,
  sessionDiffRowWithPatch,
  sessionDiffSetCapped,
  utf8ByteLength,
  type SessionDiffFilePatch,
  type SessionDiffRow,
} from './session-diff-model';
import { defaultSessionLaneStore, useSessionLane, useSessionLaneRevision } from './session-lane-store';
import {
  decodeTurnReviewCapabilityValue,
  resolveSessionRows,
  summarizeSessionDiffRows,
  TURN_REVIEW_CAPABILITY,
  type TurnReviewCapabilityValue,
} from './turn-review-model';
import type { TurnReviewFile } from './turn-review-cache';
import { useTurnChangesEpoch } from './turn-changes-model';
import { useSessionDiffRefresh } from './use-session-diff-refresh';
import { readCachedDockGitState, requestDockGitState } from './utility-dock-git-state';

// ── Source preference ────────────────────────────────────────────────────
// One global choice shared by the composer chip and every Changes pane.

/** Menu order (Codex): the conversation's own sources (the last turn, the
 *  whole session), then — after a separator — Git's sources. */
export const SESSION_CHANGES_SOURCES = ['last-turn', 'session', 'branch', 'uncommitted', 'unstaged', 'staged'] as const;
export type SessionChangesSource = (typeof SESSION_CHANGES_SOURCES)[number];
const DEFAULT_SOURCE: SessionChangesSource = 'uncommitted';

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
    return isSessionChangesSource(stored) ? stored : DEFAULT_SOURCE;
  } catch {
    return DEFAULT_SOURCE;
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
  return useSyncExternalStore(subscribeSource, readSessionChangesSource, () => DEFAULT_SOURCE);
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
  /** No file's patch fit the last turn's reply (its rows still list counts). */
  diffTooLarge: boolean;
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
  'repository' | 'root' | 'base' | 'rows' | 'untracked' | 'revisions' | 'diffTooLarge'
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
};
const EMPTY_ROWS: readonly SessionDiffRow[] = [];

// The dock's Git cadence: watch bursts debounce, runs keep a gap at least as
// long as the last read, and the safety lane is slow.
const CHANGES_REFRESH_OPTIONS = {
  safetyIntervalMs: 30_000,
  activityDebounceMs: 125,
  activityMinGapMs: 3_000,
  slowTaskMultiplier: 5,
};

const entries = new Map<string, ChangesEntry>();
const requests = new Map<string, Promise<boolean>>();
const entryListeners = new Set<() => void>();
/** A cwd inside a repository resolves to its root once a read named it. */
const cwdRoots = new Map<string, string>();
/** Per session: the cwd its latest session-source read was started for. */
const sessionReadCwds = new Map<string, string>();

function changesKey({ cwd, source, sessionId }: ChangesTarget): string {
  if (source === 'last-turn') return `last-turn\0${sessionId}`;
  // The session review is read for the session's current workspace: a read
  // still running for the previous one must not answer the new one.
  if (source === 'session') return `session\0${sessionId}\0${cwd}`;
  return `${cwdRoots.get(cwd) || cwd}\0${source}`;
}

/** Entries whose cwd was just switched to: what they hold was read for an
 *  earlier workspace of the session, so it is not shown until a read of the
 *  new cwd lands (a merge returning to the project folder must not flash the
 *  worktree's — or the folder's old — counts). */
const staleKeys = new Set<string>();

function readEntry(target: ChangesTarget): ChangesEntry | undefined {
  const key = changesKey(target);
  return staleKeys.has(key) ? undefined : entries.get(key);
}

function subscribeEntries(listener: () => void) {
  entryListeners.add(listener);
  return () => {
    entryListeners.delete(listener);
  };
}

function publish(key: string, entry: ChangesEntry): void {
  entries.set(key, entry);
  for (const listener of [...entryListeners]) listener();
}

function rowsSignature(read: ChangesRead): string {
  return JSON.stringify([
    read.repository,
    read.root,
    read.base,
    read.diffTooLarge,
    read.rows.map((row) => [
      row.path,
      row.status,
      row.additions,
      row.deletions,
      row.parts.length,
      read.revisions.get(row.path) ?? '',
    ]),
  ]);
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

/** FNV-1a over a row's inline patch text: a short stand-in for it in the
 *  entry signature. */
function patchDigest(row: SessionDiffRow): string {
  let hash = 0x811c9dc5;
  for (const part of row.parts) {
    for (let index = 0; index < part.patch.length; index += 1) {
      hash = Math.imul(hash ^ part.patch.charCodeAt(index), 0x01000193);
    }
    hash = Math.imul(hash ^ 0x7c, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function lastTurnRows(decoded: { files: TurnReviewFile[]; leadPatch: string | null }): ChangesRead['rows'] {
  return buildSessionDiffRows({ files: decoded.files, patch: decoded.leadPatch ?? '' });
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
    };
  }
  if (source === 'staged' || source === 'unstaged') {
    if (!api?.gitStatus) return NO_REPOSITORY;
    // Reused line stats are keyed by status only (not file content): evidence
    // and explicit refreshes count afresh; only the safety tick reuses them.
    const status = await api.gitStatus(cwd, { reuseLineStats: mode === 'safety' });
    if (!status.repository) return NO_REPOSITORY;
    return {
      repository: true,
      root: status.root,
      base: '',
      rows: gitStatusRows(status.files, source === 'staged'),
      untracked: new Set(status.files.filter((file) => file.untracked).map((file) => file.path)),
      revisions: NO_REVISIONS,
      diffTooLarge: false,
    };
  }
  // The last turn and the whole session are the runtime's own-edit reviews;
  // the repository question is answered by the dock's shared status snapshot.
  const cached = readCachedDockGitState(cwd);
  const dockState = cached.ready && !cached.error ? Promise.resolve(cached) : requestDockGitState(cwd);
  if (source === 'session') {
    // The session's net change: its earliest baseline against the worktree,
    // scoped to the files it touched (getSessionReviewDiff).
    // Every scheduler pass re-reads, but it is a re-check, not a change
    // signal: a read already running (the Session Diff pane's) answers it.
    // A read begun for another workspace of the session is never joined: it
    // queues a follow-up instead, which starts after the switch.
    const join = sessionReadCwds.get(sessionId) === cwd;
    sessionReadCwds.set(sessionId, cwd);
    const [dock, result] = await Promise.all([dockState, fetchSessionDiff(sessionId, { force: true, join })]);
    if (dock.error) throw new Error(dock.error);
    if (!dock.status?.repository) return NO_REPOSITORY;
    const rows = buildSessionDiffRows(result);
    // A file's patch can move while its counts hold: an inline patch's digest
    // does; a file listed without its patch is re-read with every fresh result
    // (the cache's revision), as the non-Git session diff does.
    const revision = `r${sessionDiffRevision(sessionId)}`;
    return {
      repository: true,
      root: dock.status.root,
      base: '',
      rows,
      untracked: new Set(),
      revisions: new Map(rows.map((row) => [row.path, row.parts.length ? patchDigest(row) : revision])),
      diffTooLarge: result?.diffTooLarge === true,
    };
  }
  const [dock, decoded] = await Promise.all([dockState, readTurnReview(sessionId, true, background)]);
  if (dock.error) throw new Error(dock.error);
  if (!dock.status?.repository) return NO_REPOSITORY;
  return {
    repository: true,
    root: dock.status.root,
    base: '',
    rows: decoded ? lastTurnRows(decoded) : [],
    untracked: new Set(),
    revisions: NO_REVISIONS,
    diffTooLarge: decoded?.diffTooLarge === true,
  };
}

type LoadMode = 'foreground' | GitRefreshReason;

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
  if (!previous?.length) return next;
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
  if (read.root && !sessionScopedSource(target.source)) cwdRoots.set(target.cwd, read.root);
  const key = changesKey(target);
  const previous = entries.get(key);
  const wasStale = staleKeys.delete(key);
  const changed = !previous || rowsSignature(previous) !== rowsSignature(read);
  // A safety pass that found nothing new keeps the shown entry (no render).
  if (!changed && mode === 'safety' && !wasStale && !previous.loading && !previous.error) return;
  publish(key, {
    ...read,
    rows: keepRows(previous?.rows, read.rows),
    generation: (previous?.generation ?? 0) + (changed || mode !== 'safety' ? 1 : 0),
    patchEpoch: (previous?.patchEpoch ?? 0) + (mode === 'foreground' ? 1 : 0),
    evidenceEpoch: (previous?.evidenceEpoch ?? 0) + (mode === 'activity' ? 1 : 0),
    loading: false,
    error: '',
  });
}

function markLoading(target: ChangesTarget): void {
  const key = changesKey(target);
  const previous = entries.get(key);
  if (previous && !previous.loading) publish(key, { ...previous, loading: true });
}

/** One read per (root, source) at a time; resolves true when its answer was adopted. */
function loadChanges(target: ChangesTarget, mode: LoadMode): Promise<boolean> {
  const key = changesKey(target);
  if (mode === 'foreground') markLoading(target);
  const pending = requests.get(key);
  if (pending) return pending;
  const request = readChanges(target, mode).then(
    (read) => {
      adopt(target, read, mode);
      return true;
    },
    (reason: unknown) => {
      // A failed read of a switched cwd must not bring back the old cwd's rows.
      const previous = staleKeys.delete(key) ? undefined : entries.get(key);
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

/** Ref-counted Git evidence watch per (cwd, source): the chip and the pane
 *  share one scheduler, which also performs the first read. */
function retainChangesWatch(target: ChangesTarget): () => void {
  const id = `${target.cwd}\0${target.source}\0${sessionScopedSource(target.source) ? target.sessionId : ''}`;
  let watch = watches.get(id);
  if (!watch) {
    const stop = watchGitRefreshEvidence(
      target.cwd,
      createGitRefreshScheduler(async (reason) => {
        await loadChanges(target, reason);
      }, CHANGES_REFRESH_OPTIONS)
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

/** The turn review bar's own read answered: the session's last-turn entry follows it. */
export function adoptLastTurnReview(
  sessionId: string,
  decoded: { files: TurnReviewFile[]; leadPatch: string | null; diffTooLarge?: boolean }
): void {
  const key = `last-turn\0${sessionId}`;
  const previous = entries.get(key);
  if (previous?.repository !== true) return;
  const read = {
    ...previous,
    rows: keepRows(previous.rows, lastTurnRows(decoded)),
    diffTooLarge: decoded.diffTooLarge === true,
  };
  if (rowsSignature(previous) === rowsSignature(read)) return;
  publish(key, { ...read, generation: previous.generation + 1 });
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
/** `stamp`: what the patch was read for (a Git row's status and counts, or a
 *  result revision); a file whose stamp did not move keeps it without a read.
 *  `seq` orders reads of one file, so an older answer never replaces a newer.
 *  `failed`: that read errored; the next refresh or request asks again.
 *  `patch`/`tooLarge` then hold the last good text, if any (`hadPatch`),
 *  shown beside the failure notice. `bytes`: `patch`'s UTF-8 length, summed
 *  against the set's byte limit. */
const patches = new RendererLruCache<
  string,
  { stamp: string; seq: number; bytes: number; failed?: boolean; hadPatch?: boolean } & SessionDiffFilePatch
>({
  name: 'session-changes-patch',
  maxEntries: PATCH_CACHE_MAX_ENTRIES,
  maxChars: PATCH_CACHE_MAX_CHARS,
  measure: (value, key) => value.patch.length + key.length,
});
const patchRequests = new Set<string>();
let patchSeq = 0;
/** The newest read asked for per file: an older queued read is dropped. */
const patchWanted = new Map<string, number>();
const patchQueue: Array<() => Promise<void>> = [];
let patchReadsRunning = 0;
const turnPatches = new Map<string, Promise<string>>();
const patchListeners = new Set<() => void>();
let patchVersion = 0;
let patchNotifyTimer: ReturnType<typeof setTimeout> | 0 = 0;

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
        turn = readTurnReview(target.sessionId, false, false).then((decoded) => decoded?.leadPatch ?? '');
        turnPatches.clear();
        turnPatches.set(turnKey, turn);
      }
      return turn.then((patch) => textPatch(sessionDiffFilePatch(patch, path)));
    }
    case 'session':
      // Served from the shared session-diff cache the list read filled.
      return fetchSessionDiffFilePatchResult(target.sessionId, { id: row.id, path, oldPath: row.oldPath });
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

/** Completes the pane's rows with their own patches: a Git row listed with
 *  counts only, or a session-diff row its reply listed without its patch for
 *  size. Codex's model: an uncapped set reads every file's patch at once (one
 *  batch per refresh for the review sources); a capped one reads only the
 *  selected file. A file whose stamp held keeps its patch without a read.
 *  `withPatch` returns the row to draw (stable per input row and patch). */
export function useSessionChangePatches({
  cwd,
  sessionId,
  rows,
  selectedId,
}: {
  cwd: string | undefined;
  sessionId: string;
  rows: readonly SessionDiffRow[];
  /** The one file a capped set reads and draws. */
  selectedId: string;
}): { withPatch(row: SessionDiffRow): SessionDiffRow; capped: boolean } {
  const source = useSessionChangesSource();
  const target = useMemo(() => ({ cwd: String(cwd || ''), source, sessionId }), [cwd, source, sessionId]);
  const entry = useSyncExternalStore(subscribeEntries, () => (target.cwd ? readEntry(target) : undefined));
  const version = useSyncExternalStore(subscribePatches, () => patchVersion);
  const git = entry?.repository === true;
  // Without a repository the rows are the runtime's session diff.
  const sessionDiff = !git && (!target.cwd || entry?.repository === false) && Boolean(sessionId);
  const key = git ? changesKey(target) : `session\0${sessionId}`;
  // Every adopted read re-checks the wanted files: a missing or failed patch
  // is asked for again; one whose stamp held reads nothing.
  const generation = git ? entry.generation : sessionDiffRevision(sessionId);
  const lazy = (row: SessionDiffRow) =>
    row.parts.length === 0 && ((git && !row.reason) || (sessionDiff && row.patchOmitted === true));
  const rowKey = (row: SessionDiffRow) => `${key}\0${git ? row.path : row.id}`;
  // A Git file's patch moves with its status, counts and content revision (or
  // an explicit refresh); the index sources carry no revision, so theirs moves
  // with Git evidence. The last turn's and the session diff's with their result.
  const stampOf = (row: SessionDiffRow) => {
    if (!git) return `r${generation}`;
    if (sessionScopedSource(target.source)) return `g${generation}`;
    const untracked = entry.untracked.has(row.path) ? 'u' : '';
    const content =
      target.source === 'staged' || target.source === 'unstaged'
        ? `a${entry.evidenceEpoch}`
        : (entry.revisions.get(row.path) ?? '');
    return `e${entry.patchEpoch}\0${content}\0${row.status}${untracked}\0${row.additions}\0${row.deletions}\0${row.oldPath}`;
  };
  // The set's patch text in UTF-8 bytes: inline parts, plus what the lazy
  // files read so far.
  let bytes = 0;
  for (const row of rows) bytes += lazy(row) ? (patches.peek(rowKey(row))?.bytes ?? 0) : inlineBytes(row);
  const capped = sessionDiffSetCapped(rows, bytes);
  const wantedRows = rows.filter(
    (row) => lazy(row) && !sessionDiffRowOverLineLimit(row) && (!capped || row.id === selectedId)
  );
  const wantedKey = wantedRows.map((row) => `${rowKey(row)}\0${stampOf(row)}`).join('\0\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedKey (rows and stamps) with generation names the reads
  useEffect(() => {
    const api = window.mixdogDesktop;
    if (git && entry) {
      const root = entry.root || target.cwd;
      const source = target.source;
      const readBatch = api?.gitReviewDiffs;
      if ((source === 'uncommitted' || source === 'branch') && readBatch) {
        const batch = wantedRows.map((row) => ({
          cacheKey: rowKey(row),
          stamp: stampOf(row),
          path: row.path,
          untracked: entry.untracked.has(row.path),
        }));
        const rowOf = new Map(wantedRows.map((row) => [rowKey(row), row]));
        requestPatchBatch(
          batch,
          (files) => readBatch(root, files, source),
          (file) => readFilePatch(target, key, entry, rowOf.get(file.cacheKey) as SessionDiffRow)
        );
        return;
      }
      for (const row of wantedRows) {
        requestPatch(rowKey(row), stampOf(row), () => readFilePatch(target, key, entry, row));
      }
      return;
    }
    if (!sessionDiff) return;
    for (const row of wantedRows) {
      requestPatch(rowKey(row), stampOf(row), () =>
        fetchSessionDiffFilePatchResult(sessionId, { id: row.id, path: row.path, oldPath: row.oldPath })
      );
    }
  }, [wantedKey, generation, git, sessionDiff]);
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

/** A digest of every transcript item's completion state, so a tool finishing
 *  anywhere in the transcript (not only at the last item) moves the key when
 *  the lane carries no publication revision (remote / mobile lanes). */
const digests = new WeakMap<readonly TranscriptItem[], string>();
function completionDigest(items: readonly TranscriptItem[]): string {
  const known = digests.get(items);
  if (known !== undefined) return known;
  const digest = scanCompletionDigest(items);
  digests.set(items, digest);
  return digest;
}

function scanCompletionDigest(items: readonly TranscriptItem[]): string {
  let hash = 0x811c9dc5;
  for (const item of items) {
    const state = `${item?.id ?? ''}|${item?.completedAt ?? ''}|${item?.completedCount ?? ''}|${item?.status ?? ''}|${
      item?.streaming ? 1 : 0
    }|${item?.isError ? 1 : 0}|${item?.result === undefined ? 0 : 1}`;
    for (let index = 0; index < state.length; index += 1) {
      hash = Math.imul(hash ^ state.charCodeAt(index), 0x01000193);
    }
    hash = Math.imul(hash ^ 0x7c, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

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

/** The session's Changes: the selected Git source for a repository root, else
 *  the runtime's session diff completed with the transcript's own edits. */
export function useSessionChanges({
  cwd,
  sessionId,
  active,
}: {
  cwd: string | undefined;
  sessionId: string | undefined;
  active: boolean;
}) {
  const source = useSessionChangesSource();
  const project = String(cwd || '');
  const session = String(sessionId || '');
  const target = useMemo(() => ({ cwd: project, source, sessionId: session }), [project, source, session]);
  // The workspace moved (a merge or removal back to the project folder): the
  // new cwd's cached counts predate the move, so none render until it is read.
  const seenCwd = useRef(project);
  if (seenCwd.current !== project) {
    if (seenCwd.current && project) staleKeys.add(changesKey(target));
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
  const diff = useSessionDiffRefresh({ sessionId: git ? '' : session, active, revision, busy });
  useEffect(() => {
    if (!active || !watchable) return;
    return retainChangesWatch(target);
  }, [active, target, watchable]);
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
  const fallbackRows = useMemo(() => {
    if (git) return EMPTY_ROWS;
    return resolveSessionRows(diff.result, Array.isArray(laneItems) ? laneItems : [], project);
  }, [git, diff.result, laneItems, project]);
  const rows = git ? (entry?.rows ?? EMPTY_ROWS) : fallbackRows;
  const summary = useMemo(() => summarizeSessionDiffRows(rows), [rows]);
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
    /** A read has answered (Git entry, or the session diff). */
    ready: git ? Boolean(entry) : Boolean(diff.result),
    /** Adopted reads, so a waiter can tell a refresh it did not issue landed. */
    adoptions: git ? (entry?.generation ?? 0) : diff.adoptions,
    /** The non-Git session diff (null for a Git root). */
    diff: git ? null : diff.result,
    /** No file's patch fit the reply; the rows still list every file's counts. */
    diffTooLarge: git ? entry?.diffTooLarge === true : diff.result?.diffTooLarge === true,
    revision,
    busy,
  };
}
