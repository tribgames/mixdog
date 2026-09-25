// manager/session-crud.mjs
// Session read + mutate CRUD: lookup (getSession/listSessions/findSessionByScopeKey),
// message clear (with clear-fork), manual compaction, status update, and metric flush.
import {
  loadSession,
  saveSessionAsync,
  setLiveSession,
  evictLiveSession,
  listStoredSessionSummaries,
} from '../store.mjs';
import { estimateMessagesTokens, estimateTranscriptContextUsage } from '../context-utils.mjs';
import { runSessionCompaction, resolveSessionCompactionPolicy } from './compaction-runner.mjs';
import {
  currentContextEstimateTokens,
  invalidateContextUsageSnapshot,
  recordContextUsageSnapshot,
  resolveGaugeContextTokens,
} from '../loop/compact-policy.mjs';
import {
  hasUserConversationMessage,
  isSummaryAnchorMessage as isCompactSummaryMessage,
  promptContentText,
  resetSessionBp3Environment,
} from './prompt-utils.mjs';
import { getProvider } from '../../providers/registry.mjs';
import { isSessionCompactionBlocked, getSessionAbortSignal, _runtimeEntries } from './runtime-liveness.mjs';
import { mintSessionId } from './session-id.mjs';

/** Force-flush session metrics to disk. Used by watchdog terminal-reap (fix B). */
export async function flushSessionMetrics(sessionId) {
  if (!sessionId) return;
  const session = loadSession(sessionId);
  if (!session) return;
  session.updatedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
}

// Session lookup by scopeKey — used by CLI agent to resume a pinned
// scope session when the caller passes --scope (agent/<name>).
export function findSessionByScopeKey(scopeKey) {
  if (!scopeKey) return null;
  const summaries = listStoredSessionSummaries();
  // Exclude tombstoned sessions (`closed === true`) so callers never receive
  // a session whose controller was aborted by closeSession(). The `closed`
  // bit is the authoritative tombstone flag; `status === 'error'` is not,
  // since transient-error sessions remain resumable.
  const summary = summaries.find((s) => s.scopeKey === scopeKey && s.closed !== true) || null;
  return summary?.id ? loadSession(summary.id) : null;
}

// --- CRUD ---
export function getSession(id) {
  return loadSession(id);
}
export function listSessions(opts = {}) {
  const includeClosed = opts.includeClosed === true;
  const sessions = listStoredSessionSummaries({
    refreshFromStorage: opts.refreshFromStorage === true,
  });
  const hiddenIds = new Set([..._runtimeEntries()].filter(([, e]) => e.listHidden).map(([id]) => id));
  // Tombstoned sessions (closed===true) are excluded unless the caller opts in
  // (e.g. agent list includeClosed:true).
  return sessions.filter((s) => !hiddenIds.has(s.id) && (includeClosed || s.closed !== true));
}
function normalizeSessionTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
export async function updateSessionGeneratedTitle(id, title, stage) {
  const session = loadSession(id);
  if (!session || session.closed === true) return false;
  const normalized = normalizeSessionTitle(title);
  const normalizedStage = stage === 'third' || stage === 'first' ? stage : '';
  if (!normalized || !normalizedStage) return false;
  if (session.titleLocked === true) return false;
  if (session.generatedTitleStage === 'third') return false;
  if (normalizedStage === 'first' && session.generatedTitleStage === 'first') return false;
  if (session.title === normalized && session.generatedTitleStage === normalizedStage) return false;
  session.title = normalized;
  session.generatedTitleStage = normalizedStage;
  session.titleUpdatedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return true;
}
export async function updateSessionManualTitle(id, title) {
  const session = loadSession(id);
  if (!session || session.closed === true) return false;
  const normalized = normalizeSessionTitle(title);
  if (!normalized) return false;
  if (session.title === normalized && session.titleLocked === true) return false;
  session.title = normalized;
  session.titleLocked = true;
  session.titleUpdatedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return true;
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
function bestEffortStderr(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* best-effort */
  }
}

// Token/provider accounting a cleared transcript starts from; shared by the
// live session and the cold fork of its outgoing transcript.
function clearedTokenAccounting(now) {
  return {
    providerState: undefined,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reasoningUsage: null,
    totalCachedReadTokens: 0,
    totalCacheWriteTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCachedReadTokens: 0,
    lastCacheWriteTokens: 0,
    lastContextTokens: 0,
    lastContextTokensUpdatedAt: now,
    lastContextTokensStaleAfterCompact: false,
  };
}

// Optional pre-clear compaction. Returns the post-compaction messages and the
// compaction failure (if any); with requireCompactSuccess a failure stamps the
// session and throws so the conversation is kept.
async function compactBeforeClear(session, sessionId, clearOptions) {
  let messages = Array.isArray(session.messages) ? session.messages : [];
  let clearCompactError = null;
  if (messages.length >= 3) {
    try {
      const compactResult = await runSessionCompaction(session, { mode: 'manual', force: true, sessionId });
      if (compactResult?.error) clearCompactError = new Error(compactResult.error);
    } catch (err) {
      clearCompactError = err;
      bestEffortStderr(`[session] auto-clear pre-compact failed (sess=${sessionId}): ${err?.message || err}\n`);
    }
    messages = Array.isArray(session.messages) ? session.messages : [];
  }
  if (clearOptions.requireCompactSuccess !== true) return { messages, clearCompactError };
  if (!clearCompactError && !messages.some(isCompactSummaryMessage)) {
    clearCompactError = new Error('compact produced no retained summary');
  }
  if (!clearCompactError) return { messages, clearCompactError };
  const now = Date.now();
  session.compaction = {
    ...(session.compaction || {}),
    lastStage: 'auto_clear_failed',
    lastCheckedAt: now,
    lastChanged: false,
    lastClearAt: session.compaction?.lastClearAt || null,
    lastClearCompactError: clearCompactError?.message || String(clearCompactError),
  };
  session.updatedAt = now;
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  throw new Error(`auto-clear compact failed; conversation kept: ${session.compaction.lastClearCompactError}`);
}

// Messages that survive a clear: the system layer, plus the compact summary
// when it is carried forward. BP1/BP2/BP3 all ride `role:'system'` blocks, so
// the stable memory/meta layer is preserved unconditionally.
function retainedMessagesAfterClear(messages, preserveCompactSummary) {
  return messages.filter((m) => m && (m.role === 'system' || (preserveCompactSummary && isCompactSummaryMessage(m))));
}

// ONE scale with the context gauge: anchor the pre-clear number on the
// provider-billed prompt whenever a live baseline still covers this
// transcript, and fall back to the calibrated estimate otherwise.
function clearTokenAccounting(session, messages, keep, beforeMessageTokens) {
  const afterMessageTokens = estimateMessagesTokens(keep);
  const clearPolicy = resolveSessionCompactionPolicy(session);
  const beforeTokens =
    (clearPolicy
      ? resolveGaugeContextTokens(beforeMessageTokens, clearPolicy, { messages, sessionRef: session })
      : 0) || estimateTranscriptContextUsage(messages, session.tools || [], { provider: session.provider });
  const postClearPolicy = resolveSessionCompactionPolicy(session, keep);
  const afterTokens = postClearPolicy
    ? currentContextEstimateTokens(afterMessageTokens, postClearPolicy)
    : estimateTranscriptContextUsage(keep, session.tools || [], { provider: session.provider });
  return { beforeTokens, afterTokens, beforeMessageTokens, afterMessageTokens, postClearPolicy };
}

// Fork the outgoing transcript to a separate resumable session BEFORE the wipe,
// so the conversation about to be discarded stays reachable via /resume under a
// fresh id. Best-effort: any failure here must never block the clear itself.
function forkOutgoingTranscript(session, messages, now) {
  try {
    const forkId = mintSessionId();
    const fork = {
      ...session,
      id: forkId,
      messages: messages.map((m) => (m && typeof m === 'object' ? { ...m } : m)),
      closed: false,
      status: 'idle',
      generation: 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      lastHeartbeatAt: null,
      mcpPid: process.pid,
      // Strip runtime/liveness/routing state — the fork is a cold
      // snapshot, not a live process-owned session.
      clientHostPid: null,
      ...clearedTokenAccounting(now),
    };
    delete fork.liveTurnMessages;
    setLiveSession(fork);
    void saveSessionAsync(fork)
      .then(() => {
        // The fork is a cold snapshot kept for /resume. Once durable on
        // disk it must not pin a full transcript copy (image bytes
        // included) in the same-process cache for the rest of the
        // process lifetime — this was the largest _liveSessions leak
        // (one whole conversation retained per clear).
        evictLiveSession(forkId);
      })
      .catch((err) => {
        bestEffortStderr(`[session] clear-fork save failed (sess=${forkId}): ${err?.message || err}\n`);
      });
  } catch (err) {
    bestEffortStderr(`[session] clear-fork failed (sess=${session.id}): ${err?.message || err}\n`);
  }
}

export async function clearSessionMessages(sessionId, options = {}) {
  const session = loadSession(sessionId);
  if (!session) return false;
  // Don't resurrect a closed session just to clear its messages.
  if (session.closed === true) return false;
  const clearOptions = options && typeof options === 'object' ? options : {};
  const compact = clearOptions.compact === true;
  const currentMessages = Array.isArray(session.messages) ? session.messages : [];
  const beforeMessageTokens = estimateMessagesTokens(currentMessages);
  const { messages, clearCompactError } = compact
    ? await compactBeforeClear(session, sessionId, clearOptions)
    : { messages: currentMessages, clearCompactError: null };
  const keep = retainedMessagesAfterClear(messages, compact && clearOptions.keepCompactSummary !== false);
  const tokens = clearTokenAccounting(session, messages, keep, beforeMessageTokens);
  const now = Date.now();
  // The fork runs for every clear path (plain /clear, auto-clear,
  // compact_clear) using the ORIGINAL `messages` (post-compact-gating, i.e.
  // whatever survived the requireCompactSuccess throw). Skipped for scratch
  // sessions with no real user turn — nothing worth resuming. ALSO skipped
  // when the clear carries a compact summary forward (compact_clear /
  // auto-clear): the outgoing transcript is just the compact product whose
  // content the live session retains via the summary, so the fork duplicated
  // it as a confusing extra Recent row ("Re-attached after compaction…" —
  // user report). Plain /clear (no summary kept) still forks.
  const summaryCarriedForward = keep.some(isCompactSummaryMessage);
  if (hasUserConversationMessage(messages) && !summaryCarriedForward) forkOutgoingTranscript(session, messages, now);

  session.messages = keep;
  // Clear truncates the transcript wholesale; drop the provider prefix
  // snapshot so the next send re-baselines instead of history_shrink.
  delete session._providerPrefixGuardState;
  resetSessionBp3Environment(session);
  Object.assign(session, clearedTokenAccounting(now));
  session.compaction = {
    ...(session.compaction || {}),
    lastStage: 'auto_clear',
    lastBeforeTokens: tokens.beforeTokens,
    lastAfterTokens: tokens.afterTokens,
    lastBeforeMessageTokens: tokens.beforeMessageTokens,
    lastAfterMessageTokens: tokens.afterMessageTokens,
    lastPressureTokens: tokens.beforeTokens,
    currentEstimatedTokens: tokens.afterTokens,
    lastCheckedAt: now,
    lastChanged: tokens.beforeTokens !== tokens.afterTokens,
    lastClearAt: now,
    lastClearBeforeTokens: tokens.beforeTokens,
    lastClearAfterTokens: tokens.afterTokens,
    lastClearBeforeMessageTokens: tokens.beforeMessageTokens,
    lastClearAfterMessageTokens: tokens.afterMessageTokens,
    lastClearCompactError: clearCompactError?.message || null,
  };
  if (summaryCarriedForward && tokens.postClearPolicy) {
    recordContextUsageSnapshot(session, tokens.postClearPolicy, {
      messages: keep,
      usedTokens: tokens.afterTokens,
      messageTokensEst: tokens.afterMessageTokens,
      source: 'post_clear',
      updatedAt: now,
    });
  } else {
    invalidateContextUsageSnapshot(session);
  }
  session.updatedAt = now;
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return session;
}
export async function compactSessionMessages(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  if (session.closed === true) return null;
  if (isSessionCompactionBlocked(sessionId)) {
    return { changed: false, reason: 'compact skipped: turn in progress' };
  }
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    // One fresh-context path owns Main and Agent sessions. Main hydrates
    // its canonical Memory handoff; Agent generates a session-local one.
    filterOldHistoryForIngest: true,
    provider: getProvider(session.provider),
    sessionId,
    signal: getSessionAbortSignal(sessionId),
  });
  if (!result) return null;
  const now = Date.now();
  if (!result.error) {
    session.lastInputTokens = 0;
    session.lastOutputTokens = 0;
    session.lastCachedReadTokens = 0;
    session.lastCacheWriteTokens = 0;
    session.lastContextTokens = 0;
    session.lastContextTokensUpdatedAt = now;
    session.lastContextTokensStaleAfterCompact = false;
  }
  session.updatedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return result;
}
export async function updateSessionStatus(id, status) {
  const session = loadSession(id);
  if (!session) return false;
  // Respect tombstones — don't resurrect a closed session just to update a
  // status label (agent handler emits running→idle/error around askSession).
  if (session.closed === true) return false;
  session.status = status;
  session.updatedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return true;
}

// --- Rewind to a previous user message (message selector) ---
// "Restore conversation": the selected prompt and everything
// after it leave the model history so the user can edit and resubmit it.
// Earlier turns — including any compaction rewrite that precedes them — stay
// exactly as they are. Idle-only; the caller interrupts a live turn first.
export async function rewindSessionMessagesTo(sessionId, options = {}) {
  const session = loadSession(sessionId);
  if (!session || session.closed === true) return null;
  const target = String(options?.text ?? '').trim();
  if (!target) return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (promptContentText(message.content).trim() !== target) continue;
    start = index;
    break;
  }
  if (start < 0) return null;
  const removed = messages.length - start;
  session.messages = messages.slice(0, start);
  // The provider cache is keyed on the exact prefix we just truncated;
  // the prefix-guard snapshot describes it too and must go with it.
  session.providerState = undefined;
  delete session._providerPrefixGuardState;
  session.updatedAt = Date.now();
  session.lastUsedAt = Date.now();
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return { removed, remaining: session.messages.length };
}
