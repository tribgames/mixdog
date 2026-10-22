import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from './i18n';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import type { DesktopCapability } from '../shared/contract-capabilities';
import type { TranscriptItem } from './desktop-types';
import { summarizeSessionTranscriptReview } from './turn-review-model';

/** Per-turn changed files: the runtime's `getTurnChanges` /
 *  `revertTurnChanges` / `reapplyTurnChanges` reply (one shape for all three). */
export type TurnChangesFile = {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  binary?: boolean;
  /** The runtime dropped this file's patch for size. */
  patchOmitted?: true;
  state: 'applied' | 'reverted';
  revertable: boolean;
  reason?: string;
  /** The record kept no counts for this file; the transcript may complete them. */
  unmeasured?: boolean;
  /** Git ignores this file. The record lists only the agent's own tool writes,
   *  so it is still a turn artifact. */
  ignored?: true;
};
export type TurnChangesReply = {
  status: 'ready' | 'pending' | 'none' | 'missing';
  checkpointId: string;
  revision: number;
  root: string;
  files: TurnChangesFile[];
  patch?: string;
  canUndo: boolean;
  canReapply: boolean;
  reason?: string;
};
/** Where a turn's card sits: the checkpoint, the last turndone that closed it
 *  (a newer one means the runtime may hold a newer change set), and whether
 *  no visible prompt follows it (its turn may still be running). */
export type TurnChangesRef = { checkpointId: string; boundary: string; trailing: boolean };

export const TURN_CHANGES_CAPABILITY = 'getTurnChanges' satisfies DesktopCapability;
export const REVERT_TURN_CHANGES_CAPABILITY = 'revertTurnChanges' satisfies DesktopCapability;
export const REAPPLY_TURN_CHANGES_CAPABILITY = 'reapplyTurnChanges' satisfies DesktopCapability;
export type TurnChangesCapability =
  | typeof TURN_CHANGES_CAPABILITY
  | typeof REVERT_TURN_CHANGES_CAPABILITY
  | typeof REAPPLY_TURN_CHANGES_CAPABILITY;
/** Bounded backoff while the runtime is still recording the turn. */
export const TURN_CHANGES_PENDING_DELAYS_MS = [400, 800, 1600, 3200, 6400, 12800];

const STATUSES = new Set(['ready', 'pending', 'none', 'missing']);
const FILE_STATUSES = new Set(['A', 'M', 'D', 'R']);

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** Normalized repository-relative path: forward slashes, no leading `./`. */
export function normalizeChangePath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function decodeTurnChangesReply(value: unknown): TurnChangesReply | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const status = String(record.status || '');
  if (!STATUSES.has(status)) return null;
  const files = (Array.isArray(record.files) ? record.files : []).flatMap((entry): TurnChangesFile[] => {
    if (!entry || typeof entry !== 'object') return [];
    const file = entry as Record<string, unknown>;
    const path = normalizeChangePath(String(file.path || ''));
    if (!path) return [];
    const fileStatus = String(file.status || 'M').toUpperCase();
    return [
      {
        path,
        ...(typeof file.oldPath === 'string' && file.oldPath ? { oldPath: normalizeChangePath(file.oldPath) } : {}),
        status: (FILE_STATUSES.has(fileStatus) ? fileStatus : 'M') as TurnChangesFile['status'],
        additions: count(file.additions),
        deletions: count(file.deletions),
        ...(file.binary === true ? { binary: true } : {}),
        ...(file.patchOmitted === true ? { patchOmitted: true as const } : {}),
        ...(file.unmeasured === true ? { unmeasured: true } : {}),
        ...(file.ignored === true ? { ignored: true as const } : {}),
        state: file.state === 'reverted' ? 'reverted' : 'applied',
        revertable: file.revertable === true,
        ...(typeof file.reason === 'string' && file.reason ? { reason: file.reason } : {}),
      },
    ];
  });
  return {
    status: status as TurnChangesReply['status'],
    checkpointId: String(record.checkpointId || ''),
    revision: Number.isFinite(Number(record.revision)) ? Number(record.revision) : 0,
    root: String(record.root || ''),
    files,
    ...(typeof record.patch === 'string' ? { patch: record.patch } : {}),
    canUndo: record.canUndo === true,
    canReapply: record.canReapply === true,
    ...(typeof record.reason === 'string' && record.reason ? { reason: record.reason } : {}),
  };
}

export async function invokeTurnChanges(capability: TurnChangesCapability, args: unknown[], sessionId: string) {
  const reply = await window.mixdogDesktop.invokeCapability?.({ capability, args, sessionId });
  const decoded = decodeTurnChangesReply(reply?.value);
  if (!decoded) throw new Error(t('Invalid turn changes reply.'));
  return decoded;
}

// ── Session mutation epochs ──────────────────────────────────────────────
// Undo/Reapply on one card can change what every other card of the session
// reports, so a mutation bumps the session's epoch and every card refetches.
const epochs = new Map<string, number>();
const epochListeners = new Set<() => void>();

export function turnChangesEpoch(sessionId: string): number {
  return epochs.get(sessionId) ?? 0;
}

/** Every card and session diff of the session re-reads (a mutation landed). */
export function bumpTurnChangesEpoch(sessionId: string): number {
  const next = turnChangesEpoch(sessionId) + 1;
  epochs.set(sessionId, next);
  for (const listener of epochListeners) listener();
  return next;
}

function subscribeEpochs(listener: () => void) {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

export function useTurnChangesEpoch(sessionId: string): number {
  return useSyncExternalStore(
    subscribeEpochs,
    () => turnChangesEpoch(sessionId),
    () => turnChangesEpoch(sessionId)
  );
}

// ── Reply cache ──────────────────────────────────────────────────────────
// Settled replies per (session, checkpoint), each carrying its revision and
// the turndone boundary + epoch it answered. `pending` is never cached.
type CachedReply = { boundary: string; epoch: number; reply: TurnChangesReply };
const replyCache = new RendererLruCache<string, CachedReply>({
  name: 'turn-changes',
  maxEntries: 400,
  maxChars: 2 * 1024 * 1024,
  measure: (value, key) => key.length + JSON.stringify(value).length,
});
registerIdleReclaim(() => {
  replyCache.clear();
});

export function turnChangesKey(sessionId: string, checkpointId: string): string {
  return `${sessionId}\u0000${checkpointId}`;
}

function cachedTurnChanges(sessionId: string, checkpointId: string, boundary: string, epoch: number) {
  const cached = replyCache.get(turnChangesKey(sessionId, checkpointId));
  return cached && cached.boundary === boundary && cached.epoch === epoch ? cached.reply : null;
}

function rememberTurnChanges(
  sessionId: string,
  checkpointId: string,
  boundary: string,
  epoch: number,
  reply: TurnChangesReply
) {
  if (reply.status === 'pending') return;
  replyCache.set(turnChangesKey(sessionId, checkpointId), { boundary, epoch, reply });
}

/** Test seam: forget every cached reply and epoch. */
export function resetTurnChangesCache() {
  replyCache.clear();
  epochs.clear();
}

/** The card's reply: cached when this boundary/epoch already answered, else
 *  fetched once mounted; `pending` retries with bounded backoff. `unread` is
 *  true until the first read answers (or fails, or reports `pending`): the
 *  card's final height is not known yet. */
export function useTurnChanges({
  sessionId,
  checkpointId,
  boundary,
  enabled,
}: {
  sessionId: string;
  checkpointId: string;
  boundary: string;
  enabled: boolean;
}) {
  const epoch = useTurnChangesEpoch(sessionId);
  // Bumped by `invalidate`: a refused mutation drops the cached reply so the
  // card rereads the runtime's current revision.
  const [reads, setReads] = useState(0);
  const readKey = (readEpoch: number) =>
    `${turnChangesKey(sessionId, checkpointId)}\u0000${boundary}\u0000${readEpoch}\u0000${reads}`;
  const key = readKey(epoch);
  const [state, setState] = useState<{ key: string; reply: TurnChangesReply | null }>(() => ({
    key,
    reply: cachedTurnChanges(sessionId, checkpointId, boundary, epoch),
  }));
  // The first read answered without a reply to show: a failure, or a turn
  // the runtime is still recording (its card is new content when it lands).
  const [unanswered, setUnanswered] = useState(true);
  // A newer boundary or epoch keeps the last settled reply on screen until
  // its refetch answers (the card is keyed per session + checkpoint).
  const reply =
    state.key === key ? state.reply : (cachedTurnChanges(sessionId, checkpointId, boundary, epoch) ?? state.reply);
  useEffect(() => {
    if (!enabled || !sessionId || !checkpointId) return undefined;
    const cached = cachedTurnChanges(sessionId, checkpointId, boundary, epoch);
    if (cached) {
      setState({ key, reply: cached });
      return undefined;
    }
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (retry: number) => {
      void invokeTurnChanges(TURN_CHANGES_CAPABILITY, [{ checkpointId }], sessionId).then(
        (next) => {
          if (stale) return;
          if (next.status === 'pending') {
            const delay = TURN_CHANGES_PENDING_DELAYS_MS[retry];
            setUnanswered(false);
            if (delay !== undefined) timer = setTimeout(() => attempt(retry + 1), delay);
            return;
          }
          rememberTurnChanges(sessionId, checkpointId, boundary, epoch, next);
          setState({ key, reply: next });
        },
        () => {
          // A failed read leaves no card; the next boundary or mutation retries.
          if (!stale) setUnanswered(false);
        }
      );
    };
    attempt(0);
    return () => {
      stale = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, sessionId, checkpointId, boundary, epoch, key]);
  /** A mutation's reply replaces this card's state and invalidates the
   *  session's other cards. */
  const adopt = (next: TurnChangesReply) => {
    const nextEpoch = bumpTurnChangesEpoch(sessionId);
    rememberTurnChanges(sessionId, checkpointId, boundary, nextEpoch, next);
    setState({ key: readKey(nextEpoch), reply: next });
  };
  /** Forget this checkpoint's cached reply and read it again; the last reply
   *  stays on screen until the read answers. */
  const invalidate = () => {
    replyCache.delete(turnChangesKey(sessionId, checkpointId));
    setReads((value) => value + 1);
  };
  const unread = enabled && Boolean(sessionId && checkpointId) && reply === null && unanswered;
  return { reply, unread, adopt, invalidate };
}

// ── Presentation helpers ─────────────────────────────────────────────────
const TURN_CHANGES_COLLAPSED_ROWS = 3;

export function splitChangePath(path: string): { directory: string; base: string } {
  const normalized = normalizeChangePath(path);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0
    ? { directory: normalized.slice(0, slash + 1), base: normalized.slice(slash + 1) }
    : { directory: '', base: normalized };
}

export function turnChangesTitle(files: readonly TurnChangesFile[]): string {
  return t('Turn changes: {{count}} files changed', { count: files.length });
}

const LOCATION_MAX_CHARS = 32;

/** The directory of an outside file with its middle dropped, so both the
 *  drive/root and the folder the file sits in stay readable. */
export function middleTruncatedDirectory(path: string): string {
  const directory = splitChangePath(path).directory.replace(/\/$/, '');
  if (directory.length <= LOCATION_MAX_CHARS) return directory;
  const tail = Math.ceil((LOCATION_MAX_CHARS - 1) * 0.6);
  return `${directory.slice(0, LOCATION_MAX_CHARS - 1 - tail)}\u2026${directory.slice(directory.length - tail)}`;
}

export function turnChangesTotals(files: readonly TurnChangesFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/** The rows a card lists: every file up to three, the first three of more
 *  unless expanded. */
export function visibleTurnChangeRows(files: readonly TurnChangesFile[], expanded: boolean) {
  if (files.length <= TURN_CHANGES_COLLAPSED_ROWS || expanded) return { rows: [...files], hidden: 0 };
  return {
    rows: files.slice(0, TURN_CHANGES_COLLAPSED_ROWS),
    hidden: files.length - TURN_CHANGES_COLLAPSED_ROWS,
  };
}

/** A file's identity: its full path resolved against the record's root (a
 *  changed file is root-relative, a visualized target is root-relative or
 *  absolute), separators and `.`/`..` normalized, and case-folded on drive
 *  paths (Windows). Two names are one file only when these are equal, so
 *  `index.html` is never `site/index.html`. */
export function fileIdentity(root: string, path: string): string {
  const clean = (value: string) => value.replace(/\\/g, '/');
  let full = clean(path);
  if (!full.startsWith('/') && !/^[a-z]:\//i.test(full) && root) full = `${clean(root).replace(/\/+$/, '')}/${full}`;
  const parts: string[] = [];
  for (const part of full.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const resolved = `${full.startsWith('/') ? '/' : ''}${parts.join('/')}`;
  return /^[a-z]:\//i.test(full) ? resolved.toLowerCase() : resolved;
}

/** The files a turn's changes card lists: those its visualize cards did not
 *  already show (a visualized file stands as its card, not as a diff). `root`
 *  is the reply's root the changed paths are relative to. */
export function unvisualizedChanges(
  files: readonly TurnChangesFile[],
  visualized: readonly string[] | undefined,
  root: string
): readonly TurnChangesFile[] {
  if (!visualized?.length) return files;
  const shown = new Set(visualized.map((target) => fileIdentity(root, target)));
  return files.filter((file) => !shown.has(fileIdentity(root, file.path)));
}

/** Whether every changed file was shown as a visualize card (the changes card
 *  is then not drawn; Undo moves onto the visualize card). */
export function allChangesVisualized(
  files: readonly TurnChangesFile[],
  visualized: readonly string[] | undefined,
  root: string
) {
  return files.length > 0 && unvisualizedChanges(files, visualized, root).length === 0;
}

/** Whether the file exists on disk in its current state. */
export function turnChangeFileExists(file: TurnChangesFile): boolean {
  if (file.status === 'D') return file.state === 'reverted';
  if (file.status === 'A') return file.state === 'applied';
  return true;
}

/** The path to open for the file in its current state: a reverted rename is
 *  back at its old path; null when the file does not exist on disk. */
export function turnChangeOpenPath(file: TurnChangesFile): string | null {
  if (!turnChangeFileExists(file)) return null;
  return file.state === 'reverted' && file.status === 'R' && file.oldPath ? file.oldPath : file.path;
}

/** Files the runtime could not count (old records) take the counts of the
 *  transcript's own edit — the same fallback the session pane and the island
 *  use, so a turn card agrees with them. */
export function withTranscriptCounts(
  files: readonly TurnChangesFile[],
  items: TranscriptItem[] | undefined,
  root: string
): readonly TurnChangesFile[] {
  if (!items || !files.some((file) => file.unmeasured)) return files;
  const transcript = summarizeSessionTranscriptReview(items, root);
  return files.map((file) => {
    const entry = file.unmeasured ? transcript.files.get(file.path) : undefined;
    return entry ? { ...file, additions: entry.additions, deletions: entry.deletions, unmeasured: false } : file;
  });
}
