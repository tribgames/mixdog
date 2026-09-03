import { sessionDiffFilePatch, type SessionDiffResult } from "./session-diff-model";

/** Shared renderer cache for the session review diff (user: 세션디프 불러오는
 *  게 너무 느림). The backend rebuilds ONE full patch per `getSessionReviewDiff`
 *  round-trip, and both the Session Diff list and every session file slice
 *  used to trigger their own: opening a file cost a second full computation.
 *  This module keeps one settled result per session with single-flight
 *  refresh, so the list and the file slices share a single round-trip and a
 *  revisited session paints its cached rows instantly while revalidating. */
const SESSION_DIFF_CACHE_LIMIT = 32;

interface SessionDiffCacheEntry {
  result: SessionDiffResult | null;
  promise: Promise<SessionDiffResult> | null;
}

const sessionDiffCache = new Map<string, SessionDiffCacheEntry>();

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

function evictSessionDiffs(): void {
  while (sessionDiffCache.size > SESSION_DIFF_CACHE_LIMIT) {
    let victim: string | null = null;
    for (const [id, entry] of sessionDiffCache) {
      if (!entry.promise) {
        victim = id;
        break;
      }
    }
    if (victim === null) break;
    sessionDiffCache.delete(victim);
  }
}

/** The last settled result for a session, if any — paints instantly while a
 *  refresh runs behind it. */
export function peekSessionDiff(sessionId: string): SessionDiffResult | null {
  return sessionDiffCache.get(cleanSessionId(sessionId))?.result ?? null;
}

/** Seed the cache without a round-trip (tests, optimistic restores). */
export function primeSessionDiff(sessionId: string, result: SessionDiffResult): void {
  const id = cleanSessionId(sessionId);
  if (!id) return;
  const entry = sessionDiffCache.get(id) ?? { result: null, promise: null };
  entry.result = result;
  sessionDiffCache.set(id, entry);
  evictSessionDiffs();
}

/** Drop a session's cached diff (session deleted: no stale rows on reuse). */
export function releaseSessionDiff(sessionId: string): void {
  sessionDiffCache.delete(cleanSessionId(sessionId));
}

/** One round-trip per session at a time: concurrent callers share the same
 *  promise, and a settled result answers without one unless forced. */
export function fetchSessionDiff(
  sessionId: string,
  options?: { force?: boolean },
): Promise<SessionDiffResult> {
  const id = cleanSessionId(sessionId);
  if (!id) return Promise.resolve(emptySessionDiff());
  let entry = sessionDiffCache.get(id);
  if (!entry) {
    entry = { result: null, promise: null };
    sessionDiffCache.set(id, entry);
  }
  if (entry.promise) return entry.promise;
  if (options?.force !== true && entry.result) return Promise.resolve(entry.result);
  const task = invokeSessionDiff(id).then(
    (result) => {
      const live = sessionDiffCache.get(id);
      if (live) live.promise = null;
      primeSessionDiff(id, result);
      return result;
    },
    (error) => {
      const live = sessionDiffCache.get(id);
      if (live) live.promise = null;
      throw error;
    },
  );
  entry.promise = task;
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
