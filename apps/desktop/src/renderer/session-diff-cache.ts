import {
  decodeSessionDiffFilePatch,
  sessionDiffFileOmitted,
  sessionDiffFilePatch,
  type SessionDiffFilePatch,
  type SessionDiffResult,
} from './session-diff-model';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import { catalogStorageScope } from './catalog-storage-scope';
import { estimateRetainedChars } from './renderer-value-weight';

/** Shared renderer cache for the session review diff (user: 세션디프 불러오는
 *  게 너무 느림). The backend rebuilds ONE full patch per `getSessionReviewDiff`
 *  round-trip, and both the Session Diff list and every session file slice
 *  used to trigger their own: opening a file cost a second full computation.
 *  This module keeps one settled result per session with single-flight
 *  refresh, so the list and the file slices share a single round-trip and a
 *  revisited session paints its cached rows instantly while revalidating. */
const SESSION_DIFF_CACHE_LIMIT = 32;
export const SESSION_DIFF_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const sessionDiffCache = new RendererLruCache<string, SessionDiffResult>({
  name: 'session-diff',
  maxEntries: SESSION_DIFF_CACHE_LIMIT,
  maxChars: SESSION_DIFF_CACHE_MAX_CHARS,
  measure: (result) => estimateRetainedChars(result, SESSION_DIFF_CACHE_MAX_CHARS),
});
type DiffFlight = { inflight: Promise<SessionDiffResult>; queuedDirty: boolean };
const pendingDiffs = new Map<string, DiffFlight>();
/** Per session: bumps whenever the cached result changes, so a file patch
 *  read on its own is reused only against the result it was read for. */
const revisions = new Map<string, number>();
/** Per session: the file patches read on their own for its current revision. */
const FILE_PATCHES_PER_SESSION = 16;
const filePatches = new Map<string, { revision: number; files: Map<string, Promise<SessionDiffFilePatch>> }>();
/** Per session: the change signal its last successful read answered. Bounded
 *  like the result cache (oldest dropped) and cleared with it. */
const answeredSignals = new Map<string, string>();
let boundHost: unknown;
let boundScope = '';

function adoptHost(): void {
  const host = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const scope = catalogStorageScope();
  if (host === boundHost && scope === boundScope) return;
  boundHost = host;
  boundScope = scope;
  sessionDiffCache.clear();
  pendingDiffs.clear();
  filePatches.clear();
  answeredSignals.clear();
}

registerIdleReclaim(() => {
  sessionDiffCache.clear();
  pendingDiffs.clear();
  filePatches.clear();
  answeredSignals.clear();
});

/** The signal this session's last successful read answered, if any. */
export function answeredSessionDiffSignal(sessionId: string): string | undefined {
  adoptHost();
  return answeredSignals.get(cleanSessionId(sessionId));
}

export function answerSessionDiffSignal(sessionId: string, signal: string): void {
  adoptHost();
  const id = cleanSessionId(sessionId);
  if (!id) return;
  answeredSignals.delete(id);
  answeredSignals.set(id, signal);
  while (answeredSignals.size > SESSION_DIFF_CACHE_LIMIT)
    answeredSignals.delete(answeredSignals.keys().next().value as string);
}

/** Same diff content, compared without re-serialising the (large) patch. */
export function sameSessionDiff(left: SessionDiffResult | null, right: SessionDiffResult | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.patch !== right.patch) return false;
  return JSON.stringify({ ...left, patch: undefined }) === JSON.stringify({ ...right, patch: undefined });
}

/** Cache a session's result; a different one starts a new revision. A
 *  `reread` (a change signal or user refresh) always does: an omitted file's
 *  patch can change while its counts and metadata stay equal, so the lazily
 *  read file patches must not outlive any forced read. */
function storeSessionDiff(id: string, result: SessionDiffResult, reread = false): void {
  if (reread || !sameSessionDiff(sessionDiffCache.get(id) ?? null, result)) {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
    filePatches.delete(id);
  }
  sessionDiffCache.set(id, result);
}

/** The revision of a session's cached result (fingerprints file patches). */
export function sessionDiffRevision(sessionId: string): number {
  return revisions.get(cleanSessionId(sessionId)) ?? 0;
}

function cleanSessionId(sessionId: string): string {
  return String(sessionId || '').trim();
}

function emptySessionDiff(): SessionDiffResult {
  return { supported: false, files: [], patch: '' };
}

async function invokeSessionDiff(sessionId: string): Promise<SessionDiffResult> {
  const response = await window.mixdogDesktop?.invokeCapability?.({
    capability: 'getSessionReviewDiff',
    args: [],
    sessionId,
  });
  return (response?.value ?? emptySessionDiff()) as SessionDiffResult;
}

/** The last settled result for a session, if any — paints instantly while a
 *  refresh runs behind it. */
export function peekSessionDiff(sessionId: string): SessionDiffResult | null {
  adoptHost();
  return sessionDiffCache.get(cleanSessionId(sessionId)) ?? null;
}

/** Seed the cache without a round-trip (tests, optimistic restores). */
export function primeSessionDiff(sessionId: string, result: SessionDiffResult): void {
  adoptHost();
  const id = cleanSessionId(sessionId);
  if (!id) return;
  pendingDiffs.delete(id);
  storeSessionDiff(id, result);
}

/** Drop a session's cached diff (session deleted: no stale rows on reuse). */
export function releaseSessionDiff(sessionId: string): void {
  const id = cleanSessionId(sessionId);
  sessionDiffCache.delete(id);
  pendingDiffs.delete(id);
  filePatches.delete(id);
  answeredSignals.delete(id);
}

/** One round-trip per session at a time: concurrent callers share the same
 *  promise, and a settled result answers without one unless forced. A forced
 *  `join` read (a periodic re-check, not a change signal) is answered by a
 *  read already running instead of queueing another full read behind it. */
export function fetchSessionDiff(
  sessionId: string,
  options?: { force?: boolean; join?: boolean }
): Promise<SessionDiffResult> {
  adoptHost();
  const id = cleanSessionId(sessionId);
  if (!id) return Promise.resolve(emptySessionDiff());
  const force = options?.force === true;
  const flight = pendingDiffs.get(id);
  if (flight) {
    // A change signal during a running read queues exactly one follow-up.
    if (force && options?.join !== true) flight.queuedDirty = true;
    return flight.inflight;
  }
  const result = sessionDiffCache.get(id);
  if (!force && result) return Promise.resolve(result);
  const next: DiffFlight = { inflight: Promise.resolve(emptySessionDiff()), queuedDirty: false };
  const run = async (): Promise<SessionDiffResult> => {
    let reread = force;
    for (;;) {
      next.queuedDirty = false;
      const value = await invokeSessionDiff(id);
      adoptHost();
      // Session released / host changed meanwhile: deliver, never retain.
      if (pendingDiffs.get(id) !== next) return value;
      if (next.queuedDirty) {
        reread = true;
        continue;
      }
      storeSessionDiff(id, value, reread);
      return value;
    }
  };
  next.inflight = run().finally(() => {
    if (pendingDiffs.get(id) === next) pendingDiffs.delete(id);
  });
  pendingDiffs.set(id, next);
  return next.inflight;
}

async function invokeSessionDiffFilePatch(
  sessionId: string,
  file: { id: string; oldPath?: string }
): Promise<SessionDiffFilePatch> {
  const response = await window.mixdogDesktop?.invokeCapability?.({
    capability: 'getSessionReviewFilePatch',
    args: file.oldPath ? [file.id, file.oldPath] : [file.id],
    sessionId,
  });
  return decodeSessionDiffFilePatch(response?.value);
}

/** One file's patch: its slice of the session's patch, served from the
 *  shared cache so opening a file never recomputes the whole session diff.
 *  A file the result listed without its patch (too large for the reply) is
 *  read on its own, once per file and result revision. */
export async function fetchSessionDiffFilePatchResult(
  sessionId: string,
  file: { id: string; path: string; oldPath?: string }
): Promise<SessionDiffFilePatch> {
  const id = cleanSessionId(sessionId);
  const result = await fetchSessionDiff(id);
  const slice = sessionDiffFilePatch(typeof result?.patch === 'string' ? result.patch : '', file.path);
  if (slice || !id) return { patch: slice, tooLarge: false };
  const clean = (value: unknown) => String(value || '').replace(/\\/g, '/');
  const listed = (Array.isArray(result?.files) ? result.files : []).find(
    (entry) => clean(entry?.id || entry?.path) === file.id || clean(entry?.path) === file.path
  );
  if (!sessionDiffFileOmitted(listed)) return { patch: '', tooLarge: false };
  const revision = sessionDiffRevision(id);
  let held = filePatches.get(id);
  if (held?.revision !== revision) {
    held = { revision, files: new Map() };
    filePatches.set(id, held);
  }
  let read = held.files.get(file.id);
  if (!read) {
    read = invokeSessionDiffFilePatch(id, file);
    const files = held.files;
    // A failed read is not kept: the next open asks again.
    read.catch(() => files.delete(file.id));
    files.set(file.id, read);
    while (files.size > FILE_PATCHES_PER_SESSION) files.delete(files.keys().next().value as string);
  }
  return read;
}

/** The patch text of one file (see fetchSessionDiffFilePatchResult). */
export async function fetchSessionDiffFilePatch(sessionId: string, rel: string): Promise<string> {
  return (await fetchSessionDiffFilePatchResult(sessionId, { id: rel, path: rel })).patch;
}
