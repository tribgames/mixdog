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

const SESSION_DIFF_CACHE_LIMIT = 32;
export const SESSION_DIFF_CACHE_MAX_CHARS = 8 * 1024 * 1024;
type CachedDiff = {
  result: SessionDiffResult;
  revision: number;
  files?: Map<string, WeakRef<SessionDiffFilePatch>>;
};
const sessionDiffCache = new RendererLruCache<string, CachedDiff>({
  name: 'session-diff',
  maxEntries: SESSION_DIFF_CACHE_LIMIT,
  maxChars: SESSION_DIFF_CACHE_MAX_CHARS,
  measure: ({ result }) => {
    const rawChars = estimateRetainedChars(result, SESSION_DIFF_CACHE_MAX_CHARS);
    if (rawChars > SESSION_DIFF_CACHE_MAX_CHARS) return rawChars;
    // Holding the result keeps its weak-keyed parse alive as well. A normal
    // fetch has already parsed it in bounded tasks; a synchronous prime
    // measures its parse before entering the cache.
    return rawChars + parsedSessionDiff(result).retainedPatchChars;
  },
});
type DiffFlight = { inflight: Promise<SessionDiffResult>; queuedDirty: boolean };
const pendingDiffs = new Map<string, DiffFlight>();
/** Per session: bumps whenever the cached result changes, so a file patch
 *  read on its own is reused only against the result it was read for. */
const revisions = new Map<string, number>();
type OmittedFile = { id: string; oldPath: string };
type SessionDiffBinding = {
  revision: number;
  omitted: ReadonlyMap<string, OmittedFile>;
};
const resultBindings = new WeakMap<SessionDiffResult, SessionDiffBinding>();
// The displayed list or the LRU owns the binding, not this standalone lookup.
const latestBindings = new Map<string, WeakRef<SessionDiffBinding>>();
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
  pendingFilePatches.clear();
  latestBindings.clear();
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

function storeSessionDiff(id: string, result: SessionDiffResult, reread = false): void {
  const held = sessionDiffCache.get(id);
  const changed = reread || !sameSessionDiffContent(held?.result ?? null, result);
  const revision = (revisions.get(id) ?? 0) + (changed ? 1 : 0);
  revisions.set(id, revision);
  const { rows, index } = parsedSessionDiff(result);
  const omitted = new Map<string, OmittedFile>();
  rows.forEach(({ id: fileId, path, oldPath, patchOmitted }, position) => {
    if (!patchOmitted) return;
    const file = { id: fileId, oldPath };
    if (index.byId.get(fileId) === position) omitted.set(fileId, file);
    if (!index.byId.has(path) && index.byPath.get(path) === position) omitted.set(path, file);
  });
  const binding = { revision, omitted };
  resultBindings.set(result, binding);
  if (omitted.size) latestBindings.set(id, new WeakRef(binding));
  else latestBindings.delete(id);
  sessionDiffCache.set(id, { result, revision, files: changed ? undefined : held?.files });
}

export function sessionDiffBinding(result: SessionDiffResult | null): SessionDiffBinding | undefined {
  return result ? resultBindings.get(result) : undefined;
}

function omittedFileKey(id: string, revision: number, fileId: string): string {
  return JSON.stringify([id, revision, fileId]);
}

/** A file already known to be omitted can use the displayed revision without
 *  finding its list in the LRU. Only an in-flight request owns the promise. */
export function fetchOmittedSessionDiffFilePatch(
  sessionId: string,
  file: { id: string; oldPath?: string },
  revision = sessionDiffRevision(sessionId)
): Promise<SessionDiffFilePatch> {
  adoptHost();
  const id = cleanSessionId(sessionId);
  if (!id) return Promise.resolve({ patch: '', tooLarge: false });
  const key = omittedFileKey(id, revision, file.id);
  const pending = pendingFilePatches.get(key);
  if (pending) return pending;
  const held = sessionDiffCache.peek(id);
  if (held?.revision === revision) held.files ??= new Map();
  const files = held?.revision === revision ? held.files : undefined;
  const cached = files?.get(file.id)?.deref();
  if (cached) return Promise.resolve(cached);
  const read = invokeSessionDiffFilePatch(id, file)
    .then((answer) => {
      if (files && pendingFilePatches.get(key) === read) {
        files.set(file.id, new WeakRef(answer));
        while (files.size > FILE_PATCHES_PER_SESSION) files.delete(files.keys().next().value as string);
      }
      return answer;
    })
    .finally(() => {
      if (pendingFilePatches.get(key) === read) pendingFilePatches.delete(key);
    });
  pendingFilePatches.set(key, read);
  return read;
}

function latestOmittedFile(id: string, input: { id: string; path: string }) {
  const binding = latestBindings.get(id)?.deref();
  if (!binding) {
    latestBindings.delete(id);
    return;
  }
  const file = binding.omitted.get(input.id) ?? binding.omitted.get(input.path);
  return file && { file, revision: binding.revision };
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
  latestBindings.delete(id);
  answeredSignals.delete(id);
  revisions.delete(id);
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
  adoptHost();
  // A standalone open still follows an ongoing list refresh. Otherwise a
  // live displayed list can identify an omitted file without re-reading it.
  if (!pendingDiffs.has(id)) {
    const omitted = latestOmittedFile(id, file);
    if (omitted) return fetchOmittedSessionDiffFilePatch(id, omitted.file, omitted.revision);
  }
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
  const row = parsed.rows[position];
  if (row?.patchOmitted !== true) return { patch: '', tooLarge: false };
  return fetchOmittedSessionDiffFilePatch(id, row, sessionDiffBinding(result)?.revision);
}

/** The patch text of one file (see fetchSessionDiffFilePatchResult). */
export async function fetchSessionDiffFilePatch(sessionId: string, rel: string): Promise<string> {
  return (await fetchSessionDiffFilePatchResult(sessionId, { id: rel, path: rel }, 'standalone')).patch;
}
