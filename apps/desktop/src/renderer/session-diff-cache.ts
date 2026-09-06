import { sessionDiffFilePatch, type SessionDiffResult } from "./session-diff-model";
import { RendererLruCache } from "./renderer-lru-cache";
import { registerIdleReclaim } from "./idle-reclaim";
import { catalogStorageScope } from "./catalog-storage-scope";
import { estimateRetainedChars } from "./renderer-value-weight";

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
  name: "session-diff",
  maxEntries: SESSION_DIFF_CACHE_LIMIT,
  maxChars: SESSION_DIFF_CACHE_MAX_CHARS,
  measure: (result) => estimateRetainedChars(result, SESSION_DIFF_CACHE_MAX_CHARS),
});
const pendingDiffs = new Map<string, Promise<SessionDiffResult>>();
let boundHost: unknown;
let boundScope = "";

function adoptHost(): void {
  const host = typeof window === "undefined" ? undefined : window.mixdogDesktop;
  const scope = catalogStorageScope();
  if (host === boundHost && scope === boundScope) return;
  boundHost = host;
  boundScope = scope;
  sessionDiffCache.clear();
  pendingDiffs.clear();
}

registerIdleReclaim(() => {
  sessionDiffCache.clear();
  pendingDiffs.clear();
});

function cleanSessionId(sessionId: string): string {
  return String(sessionId || "").trim();
}

function emptySessionDiff(): SessionDiffResult {
  return { supported: false, files: [], patch: "" };
}

async function invokeSessionDiff(sessionId: string): Promise<SessionDiffResult> {
  const response = await window.mixdogDesktop?.invokeCapability?.({
    capability: "getSessionReviewDiff",
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
  sessionDiffCache.set(id, result);
}

/** Drop a session's cached diff (session deleted: no stale rows on reuse). */
export function releaseSessionDiff(sessionId: string): void {
  sessionDiffCache.delete(cleanSessionId(sessionId));
  pendingDiffs.delete(cleanSessionId(sessionId));
}

/** One round-trip per session at a time: concurrent callers share the same
 *  promise, and a settled result answers without one unless forced. */
export function fetchSessionDiff(
  sessionId: string,
  options?: { force?: boolean },
): Promise<SessionDiffResult> {
  adoptHost();
  const id = cleanSessionId(sessionId);
  if (!id) return Promise.resolve(emptySessionDiff());
  const pending = pendingDiffs.get(id);
  if (pending) return pending;
  const result = sessionDiffCache.get(id);
  if (options?.force !== true && result) return Promise.resolve(result);
  const task = invokeSessionDiff(id).then((value) => {
    adoptHost();
    if (pendingDiffs.get(id) === task) sessionDiffCache.set(id, value);
    return value;
  }).finally(() => {
    if (pendingDiffs.get(id) === task) pendingDiffs.delete(id);
  });
  pendingDiffs.set(id, task);
  return task;
}

/** The slice of a session's patch that belongs to ONE file, served from the
 *  shared cache so opening a file never recomputes the whole session diff. */
export async function fetchSessionDiffFilePatch(
  sessionId: string,
  rel: string,
): Promise<string> {
  const result = await fetchSessionDiff(sessionId);
  return sessionDiffFilePatch(typeof result?.patch === "string" ? result.patch : "", rel);
}
