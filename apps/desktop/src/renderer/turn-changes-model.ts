import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from './i18n';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import type { DesktopCapability } from '../shared/contract-capabilities';

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
/** A preview patch larger than this is not rendered in a hover tooltip. */
export const TURN_CHANGES_PREVIEW_MAX_CHARS = 200_000;

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

function bumpTurnChangesEpoch(sessionId: string): number {
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
const previewCache = new RendererLruCache<string, string>({
  name: 'turn-changes-preview',
  maxEntries: 64,
  maxChars: 2 * 1024 * 1024,
  measure: (value, key) => key.length + value.length,
});
registerIdleReclaim(() => {
  replyCache.clear();
  previewCache.clear();
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

/** Test seam: forget every cached reply, preview and epoch. */
export function resetTurnChangesCache() {
  replyCache.clear();
  previewCache.clear();
  epochs.clear();
}

/** The card's reply: cached when this boundary/epoch already answered, else
 *  fetched once mounted; `pending` retries with bounded backoff. */
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
            if (delay !== undefined) timer = setTimeout(() => attempt(retry + 1), delay);
            return;
          }
          rememberTurnChanges(sessionId, checkpointId, boundary, epoch, next);
          setState({ key, reply: next });
        },
        () => {
          // A failed read leaves no card; the next boundary or mutation retries.
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
  return { reply, adopt, invalidate };
}

/** One file's patch for the hover preview, cached per revision. */
export async function fetchTurnChangesPreview(
  sessionId: string,
  checkpointId: string,
  revision: number,
  file: string
): Promise<string> {
  const key = `${turnChangesKey(sessionId, checkpointId)}\u0000${revision}\u0000${file}`;
  const cached = previewCache.get(key);
  if (cached !== undefined) return cached;
  const reply = await invokeTurnChanges(TURN_CHANGES_CAPABILITY, [{ checkpointId, patch: true, file }], sessionId);
  const patch = reply.patch ?? '';
  previewCache.set(key, patch);
  return patch;
}

/** Why a fetched preview patch cannot be rendered, or null when it can: a
 *  binary file, a patch the runtime dropped for size (`patchOmitted`) or one
 *  past the tooltip's own cap, or any other empty patch. */
export function turnChangesPreviewGap(file: TurnChangesFile, patch: string): 'binary' | 'large' | 'empty' | null {
  if (file.binary === true) return 'binary';
  if (file.patchOmitted === true || patch.length > TURN_CHANGES_PREVIEW_MAX_CHARS) return 'large';
  return patch.length > 0 ? null : 'empty';
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
  if (files.length === 1) return t('Edited {{file}}', { file: splitChangePath(files[0]?.path ?? '').base });
  return t('Edited {{count}} files', { count: files.length });
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

/** The rows a card lists: none for one file (the header names it), all of
 *  two or three, the first three of more unless expanded. */
export function visibleTurnChangeRows(files: readonly TurnChangesFile[], expanded: boolean) {
  if (files.length <= 1) return { rows: [] as TurnChangesFile[], hidden: 0 };
  if (files.length <= TURN_CHANGES_COLLAPSED_ROWS || expanded) return { rows: [...files], hidden: 0 };
  return {
    rows: files.slice(0, TURN_CHANGES_COLLAPSED_ROWS),
    hidden: files.length - TURN_CHANGES_COLLAPSED_ROWS,
  };
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
