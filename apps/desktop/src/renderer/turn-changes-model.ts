import { useEffect, useState, useSyncExternalStore } from 'react';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import type { DesktopCapability } from '../shared/contract-capabilities';
import type { TranscriptItem } from './desktop-types';
import { summarizeSessionTranscriptReview } from './turn-review-model';
import type { TranscriptRowModel } from './transcript-rows';
import { flattenedToolActivityItems } from './transcript-tool-core';

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
 *  that is the transcript's last turn end with no visible prompt after it
 *  (only its turn may still be running). */
export type TurnChangesRef = {
  checkpointId: string;
  boundary: string;
  trailing: boolean;
  /** A trailing card whose checkpoint an earlier end had closed (a completion wake closes it again): it stood before. */
  reclosed?: boolean;
};

/** A card is held back while its turn runs only when it is new with the transcript's last end: one that stood on an
 *  earlier end of the same checkpoint stays, read again at the newer end. When `checkpointShown` is false (the
 *  checkpoint never stood while idle), a reclosed end still stays held until the loop finishes. */
export function turnCardHeld(
  ref: TurnChangesRef | undefined,
  turnRunning: boolean | undefined,
  checkpointShown?: boolean
): boolean {
  if (!ref?.trailing || !turnRunning) return false;
  if (ref.reclosed && checkpointShown !== false) return false;
  return true;
}

const TURN_CHANGES_CAPABILITY = 'getTurnChanges' satisfies DesktopCapability;
export const REVERT_TURN_CHANGES_CAPABILITY = 'revertTurnChanges' satisfies DesktopCapability;
export const REAPPLY_TURN_CHANGES_CAPABILITY = 'reapplyTurnChanges' satisfies DesktopCapability;
export type TurnChangesCapability =
  | typeof TURN_CHANGES_CAPABILITY
  | typeof REVERT_TURN_CHANGES_CAPABILITY
  | typeof REAPPLY_TURN_CHANGES_CAPABILITY;
/** Bounded backoff while the runtime is still recording the turn. */
const TURN_CHANGES_PENDING_DELAYS_MS = [400, 800, 1600, 3200, 6400, 12800];

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

/** One turn's changes with their patch text: every file's, or only `file`'s
 *  (not cached: the pane reads it on open). */
export function readTurnChangesPatch(sessionId: string, checkpointId: string, file = '') {
  return invokeTurnChanges(
    TURN_CHANGES_CAPABILITY,
    [{ checkpointId, patch: true, ...(file ? { file } : {}) }],
    sessionId
  );
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

function turnChangesEpoch(sessionId: string): number {
  return epochs.get(sessionId) ?? 0;
}

/** Every card and session diff of the session re-reads (a mutation landed). */
export function bumpTurnChangesEpoch(sessionId: string): number {
  const next = turnChangesEpoch(sessionId) + 1;
  epochs.set(sessionId, next);
  for (const listener of epochListeners) listener();
  return next;
}

/** A deleted session's epoch goes with it. */
export function releaseTurnChangesEpoch(sessionId: string): void {
  epochs.delete(sessionId);
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
const TURN_CHANGES_IDLE_RETAINED_CHARS = 64 * 1024;
registerIdleReclaim(() => {
  replyCache.trim(TURN_CHANGES_IDLE_RETAINED_CHARS);
});

function turnChangesKey(sessionId: string, checkpointId: string): string {
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

/** One capability read per card, shared by the mounted card and an earlier
 *  prefetch of the same card (a session about to open). */
const readsInFlight = new Map<string, Promise<TurnChangesReply>>();

function readTurnChanges(sessionId: string, checkpointId: string, boundary: string, epoch: number) {
  const key = `${turnChangesKey(sessionId, checkpointId)}\u0000${boundary}\u0000${epoch}`;
  const shared = readsInFlight.get(key);
  if (shared) return shared;
  const read = invokeTurnChanges(TURN_CHANGES_CAPABILITY, [{ checkpointId }], sessionId)
    .then((reply) => {
      rememberTurnChanges(sessionId, checkpointId, boundary, epoch, reply);
      return reply;
    })
    .finally(() => {
      readsInFlight.delete(key);
    });
  readsInFlight.set(key, read);
  return read;
}

/** Reads a card's reply ahead of its mount, so the row that mounts it paints
 *  the card (or its absence) in its first commit. A held or in-flight reply is
 *  never read twice. */
export function prefetchTurnChanges(sessionId: string, checkpointId: string, boundary: string): void {
  if (!sessionId || !checkpointId) return;
  const epoch = turnChangesEpoch(sessionId);
  if (cachedTurnChanges(sessionId, checkpointId, boundary, epoch)) return;
  readTurnChanges(sessionId, checkpointId, boundary, epoch).catch(() => undefined);
}

/** Test seam: forget every cached reply, read in flight and epoch. */
export function resetTurnChangesCache() {
  replyCache.clear();
  readsInFlight.clear();
  epochs.clear();
}

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
  // A card mounted on a newer end of a checkpoint it stood on before (a wake closed it again and moved the card to
  // another row) starts from the reply held of the earlier end, as one that stayed mounted keeps it: under no key, so
  // it is read again.
  const [state, setState] = useState<{ key: string; reply: TurnChangesReply | null }>(() => {
    const cached = cachedTurnChanges(sessionId, checkpointId, boundary, epoch);
    if (cached) return { key, reply: cached };
    const earlier = replyCache.peek(turnChangesKey(sessionId, checkpointId))?.reply ?? null;
    return earlier ? { key: '', reply: earlier } : { key, reply: null };
  });
  // How the reads stand while there is no reply to show: none answered yet,
  // the runtime is still recording the turn (its card is new content when it
  // lands), or the read failed.
  const [waiting, setWaiting] = useState<{
    key: string;
    phase: 'recording' | 'failed';
    error: string;
    /** The last re-ask was answered "still recording": no other is scheduled. */
    last?: boolean;
  } | null>(null);
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
      void readTurnChanges(sessionId, checkpointId, boundary, epoch).then(
        (next) => {
          if (stale) return;
          if (next.status === 'pending') {
            const delay = TURN_CHANGES_PENDING_DELAYS_MS[retry];
            setWaiting({ key, phase: 'recording', error: '', last: delay === undefined });
            if (delay !== undefined) timer = setTimeout(() => attempt(retry + 1), delay);
            return;
          }
          setState({ key, reply: next });
        },
        (reason: unknown) => {
          // A failed read leaves no card; the next boundary or mutation retries.
          if (!stale) setWaiting({ key, phase: 'failed', error: errorMessageText(reason) });
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
  // Of the read asked for now, until it answers: a newer boundary, epoch or `invalidate` is read again.
  const answered = state.key === key && state.reply !== null;
  const now = waiting?.key === key && !answered ? waiting : null;
  const asked = enabled && Boolean(sessionId && checkpointId);
  const unread = asked && reply === null && now === null;
  const fresh = answered || cachedTurnChanges(sessionId, checkpointId, boundary, epoch) !== null;
  return {
    reply,
    unread,
    /** `reply` answers the read asked for now, not an earlier boundary, epoch or `invalidate` kept on screen. */
    fresh,
    /** The read asked for now is out: the core has neither answered it nor said the turn is still recording. */
    reading: asked && !fresh && now === null,
    /** The runtime is still recording this turn: there is no answer yet. */
    recording: now?.phase === 'recording',
    /** Still recording at the last re-ask: nothing asks again until `invalidate` or a newer end. */
    stalled: now?.phase === 'recording' && now.last === true,
    /** Why the read asked for now failed ('' when it did not). */
    error: now?.phase === 'failed' ? now.error : '',
    adopt,
    invalidate,
  };
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
function turnChangeFileExists(file: TurnChangesFile): boolean {
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

/** What a turn's changes card lists, and so what the diff pane shows for that
 *  turn: the record's files with old records' counts completed from the
 *  transcript, less the files its visualize cards showed. */
export function listedTurnChanges(
  files: readonly TurnChangesFile[],
  items: TranscriptItem[] | undefined,
  visualized: readonly string[] | undefined,
  root: string
): readonly TurnChangesFile[] {
  return unvisualizedChanges(withTranscriptCounts(files, items, root), visualized, root);
}

/** A tool row as the forms the transcript's diff reader reads (turn-review-model.ts), newest first: the row itself (a
 *  call, or a card of several whose patches it carries), and, of a card of several, each `write` call in it: a
 *  write publishes no patch, so the card does not carry what it wrote. */
function editsOf(item: TranscriptItem): TranscriptItem[] {
  if (item.aggregate !== true) return [item];
  const writes = flattenedToolActivityItems([item]).filter(
    (member) => String(member.name || '').toLowerCase() === 'write'
  );
  return [...writes.reverse(), item];
}

/** What a turn's own rows say it changed: the files its edit and write calls name, with the lines their diffs count,
 *  as a reply the card can draw before the core's read answers. The turn is the rows of the card's own turn up to the
 *  row the card stands on; rows of it the transcript does not hold are not read.
 *  Null when they name no file. The read then says what only the core knows: files changed by other means (a shell
 *  command), the counts of a file the calls did not diff, and what can be undone. */
export function recordedTurnChanges(
  rows: readonly TranscriptRowModel[],
  checkpointId: string,
  root: string
): TurnChangesReply | null {
  const names = (row: TranscriptRowModel | undefined): string | undefined =>
    row && (row._tag === 'AssistantPart' || row._tag === 'Error') ? row.turnChanges?.checkpointId : undefined;
  let end = rows.length - 1;
  while (end >= 0 && names(rows[end]) !== checkpointId) end -= 1;
  if (end < 0) return null;
  // The card's own turn: the rows before it that the transcript gives its turn's key, whatever its checkpoint is
  // named after (its prompt, or the end's own id).
  const turnKey = rows[end]?.turnKey;
  const items: TranscriptItem[] = [];
  for (let at = end; at >= 0; at -= 1) {
    const row = rows[at];
    if (row?.turnKey !== turnKey || (at < end && names(row) !== undefined)) break;
    if (row._tag !== 'ToolActivity') continue;
    for (let k = row.items.length - 1; k >= 0; k -= 1) {
      const member = row.items[k];
      if (member) items.push(...editsOf(member));
    }
  }
  if (items.length === 0) return null;
  items.reverse();
  const files: TurnChangesFile[] = [];
  for (const [name, entry] of summarizeSessionTranscriptReview(items, root).files) {
    const path = normalizeChangePath(name);
    if (!path) continue;
    const status = String(entry.status || 'M').toUpperCase();
    files.push({
      path,
      status: (FILE_STATUSES.has(status) ? status : 'M') as TurnChangesFile['status'],
      additions: entry.additions,
      deletions: entry.deletions,
      ...(entry.binary ? { binary: true } : {}),
      state: 'applied',
      revertable: false,
    });
  }
  if (files.length === 0) return null;
  return { status: 'ready', checkpointId, revision: 0, root, files, canUndo: false, canReapply: false };
}

/** A turn's recorded changes as its card reads them (transcript-rows.ts): the
 *  checkpoint (the last kept turndone's, else its prompt's) and the boundary
 *  of the end its card stands on, the last one that carries the checkpoint.
 *  `checkpointId` is '' for a turn still running. */
export type TurnRecord = { checkpointId: string; boundary: string };
const NO_RECORD: TurnRecord = { checkpointId: '', boundary: '' };
const turnRecordMaps = new WeakMap<readonly string[], Map<string, TurnRecord>>();
export function turnRecordOf(
  items: readonly TranscriptItem[],
  turnKeys: readonly string[],
  turnKey: string
): TurnRecord {
  let records = turnRecordMaps.get(turnKeys);
  if (!records) {
    const checkpoints = new Map<string, string>();
    const boundaries = new Map<string, string>();
    const prompts = new Map<string, string>();
    let openKeys: string[] = [];
    let openPromptCheckpoint = '';
    items.forEach((item, index) => {
      const key = turnKeys[index] || '';
      if (item?.kind === 'user') {
        const steered = item.steered === true || Boolean(item.steer);
        const id = item.checkpointId ?? item.id;
        const promptId = id !== undefined && id !== null && id !== '' ? String(id) : '';
        if (!steered) {
          if (key && !prompts.has(key) && promptId) prompts.set(key, promptId);
          openKeys = key ? [key] : [];
          openPromptCheckpoint = promptId;
        } else {
          if (key && !openKeys.includes(key)) openKeys.push(key);
          if (!openPromptCheckpoint && promptId) openPromptCheckpoint = promptId;
        }
      } else {
        if (key && !openKeys.includes(key)) openKeys.push(key);
        if (item?.kind === 'turndone' && item.archived !== true) {
          const checkpointId =
            typeof item.checkpointId === 'string' && item.checkpointId
              ? item.checkpointId
              : openPromptCheckpoint || prompts.get(key);
          if (checkpointId) {
            for (const openKey of openKeys) checkpoints.set(openKey, checkpointId);
            const id = item.id;
            boundaries.set(checkpointId, id !== undefined && id !== null ? String(id) : `${checkpointId}:${index}`);
          }
          openKeys = [];
          openPromptCheckpoint = '';
        }
      }
    });
    records = new Map(
      [...checkpoints].map(([key, checkpointId]) => [
        key,
        { checkpointId, boundary: boundaries.get(checkpointId) ?? '' },
      ])
    );
    turnRecordMaps.set(turnKeys, records);
  }
  return records.get(turnKey) ?? NO_RECORD;
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
