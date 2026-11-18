import {
  decodeSessionDiffFilePatch,
  parsedSessionDiff,
  parseSessionDiff,
  sessionDiffFileSlice,
  sameSessionDiffContent,
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
type CachedDiff = {
  result: SessionDiffResult;
  files?: Map<string, WeakRef<SessionDiffFilePatch>>;
};
const sessionDiffCache = new RendererLruCache<string, CachedDiff>({
  name: 'session-diff',
  maxEntries: SESSION_DIFF_CACHE_LIMIT,
  maxChars: SESSION_DIFF_CACHE_MAX_CHARS,
  measure: ({ result }) => estimateRetainedChars(result, SESSION_DIFF_CACHE_MAX_CHARS),
});
type DiffFlight = { inflight: Promise<SessionDiffResult>; queuedDirty: boolean };
const pendingDiffs = new Map<string, DiffFlight>();
/** Per session: bumps whenever the cached result changes, so a file patch
 *  read on its own is reused only against the result it was read for. */
const revisions = new Map<string, number>();
/** A settled list remembers only weak hints for its omitted files. Reads
 *  still running are shared independently of that list's cache budget. */
const FILE_PATCHES_PER_SESSION = 16;
const pendingFilePatches = new Map<string, Promise<SessionDiffFilePatch>>();
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
  answeredSignals.clear();
}

registerIdleReclaim(() => {
  sessionDiffCache.clear();
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

export { sameSessionDiffContent as sameSessionDiff };

/** Cache a session's result; a different one starts a new revision. A
 *  `reread` (a change signal or user refresh) always does: an omitted file's
 *  patch can change while its counts and metadata stay equal, so the lazily
 *  read file patches must not outlive any forced read. */
function storeSessionDiff(id: string, result: SessionDiffResult, reread = false): void {
  const held = sessionDiffCache.get(id);
  if (reread || !sameSessionDiffContent(held?.result ?? null, result)) {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
    sessionDiffCache.set(id, { result });
  } else {
    sessionDiffCache.set(id, { result, files: held?.files });
  }
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
  return sessionDiffCache.get(cleanSessionId(sessionId))?.result ?? null;
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
  answeredSignals.delete(id);
}

async function parsedDelivery(value: SessionDiffResult): Promise<SessionDiffResult> {
  await parseSessionDiff(value);
  return value;
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
  const result = sessionDiffCache.get(id)?.result;
  if (!force && result) return Promise.resolve(result);
  const next: DiffFlight = { inflight: Promise.resolve(emptySessionDiff()), queuedDirty: false };
  const run = async (): Promise<SessionDiffResult> => {
    let reread = force;
    for (;;) {
      next.queuedDirty = false;
      const value = await invokeSessionDiff(id);
      adoptHost();
      // Session released / host changed meanwhile: deliver, never retain.
      if (pendingDiffs.get(id) !== next) return parsedDelivery(value);
      if (next.queuedDirty) {
        reread = true;
        continue;
      }
      // Every delivered result is parsed once, here, in bounded tasks (input
      // runs between them); an answer equal to the held one shares its parse.
      await parseSessionDiff(value, sessionDiffCache.get(id)?.result ?? null);
      adoptHost();
      if (pendingDiffs.get(id) !== next) return value;
      // A change signal during the parse: this answer is already stale.
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
 *  read on its own; concurrent callers join and a surviving answer can
 *  be reused for that exact revision. */
export async function fetchSessionDiffFilePatchResult(
  sessionId: string,
  file: { id: string; path: string; oldPath?: string },
  binding: 'list' | 'standalone' = 'list'
): Promise<SessionDiffFilePatch> {
  const id = cleanSessionId(sessionId);
  // The settled result is the one the listed rows were read from: a file's slice comes from it at once. A whole-session
  // read running behind it (an agent editing re-reads every few seconds, each a full diff on the core) answers a later
  // list, whose rows ask for their slices again; waiting for it held every open of Changes for that read.
  const settled = binding === 'list' ? peekSessionDiff(id) : null;
  const result = settled ?? (await fetchSessionDiff(id));
  const parsed = parsedSessionDiff(result);
  const slice = sessionDiffFileSlice(parsed, file.path);
  if (slice || !id) return { patch: slice, tooLarge: false };
  // The listed file, looked up in the parse's index (by ID, else path).
  const position = parsed.index.byId.get(file.id) ?? parsed.index.byPath.get(file.path) ?? -1;
  if (parsed.rows[position]?.patchOmitted !== true) return { patch: '', tooLarge: false };
  const revision = sessionDiffRevision(id);
  const held = sessionDiffCache.peek(id);
  const files = held?.result === result ? (held.files ??= new Map()) : undefined;
  const cached = files?.get(file.id)?.deref();
  if (cached) return cached;
  const key = JSON.stringify([id, revision, file.id]);
  const pending = pendingFilePatches.get(key);
  if (pending) return pending;
  const read = invokeSessionDiffFilePatch(id, file);
  pendingFilePatches.set(key, read);
  try {
    const answer = await read;
    // A consumer owns the displayed patch. This reuse hint must not keep
    // its text alive after the consumer releases it.
    if (!files) return answer;
    files.set(file.id, new WeakRef(answer));
    while (files.size > FILE_PATCHES_PER_SESSION) files.delete(files.keys().next().value as string);
    return answer;
  } finally {
    pendingFilePatches.delete(key);
  }
}

/** The patch text of one file (see fetchSessionDiffFilePatchResult). */
export async function fetchSessionDiffFilePatch(sessionId: string, rel: string): Promise<string> {
  return (await fetchSessionDiffFilePatchResult(sessionId, { id: rel, path: rel }, 'standalone')).patch;
}
