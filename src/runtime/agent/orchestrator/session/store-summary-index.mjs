/**
 * Session summary index: the compact `session-summaries.json` sidecar that
 * lists every session's lightweight metadata (preview, counts, lifecycle) so
 * the status aggregator and session listers avoid parsing every full session
 * file. store.mjs re-exports these so
 * importers stay unchanged.
 */
import { appendFileSync, mkdirSync, truncateSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPluginData } from '../config.mjs';
import {
  withFileLock,
  withFileLockSync,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
} from '../../../shared/atomic-file.mjs';
import { applySummaryLogText, encodeSummaryOps, summaryLogPath } from './store-summary-log.mjs';
import { isSessionPreviewNoise, sessionMessageText } from '../runtime-core/session-text.mjs';
import { sessionVisibility } from './store-summary-visibility.mjs';
import { sessionModeOf } from './agent-mode.mjs';
import {
  importKey,
  inheritedFromSessionId,
  isStoredSessionId,
  positiveNumber as _positiveNumber,
  compactCount,
  compactCountField,
  realTurnCount,
  workspaceSummary,
} from './store-summary-fields.mjs';
import { isRealTurnMessage } from './compact/user-message-kind.mjs';
import { isRoutineResultMessage, normalizeRoutineProvenance, routineProvenance } from './routine-result.mjs';
import {
  INCOMING_TAIL_MAX,
  LAST_MESSAGE_PREVIEW_MAX,
  cleanSummaryPreview,
  isIncomingKind,
  normalizedIncomingTail,
  lastMessageRawText,
  wantsIncomingTail,
} from './store-summary-last-message.mjs';

export const SESSION_SUMMARY_INDEX_VERSION = 2;

// Pure path: every writer (lock acquisition and atomic write) creates the
// directory itself, and a reader treats a missing directory like a missing
// file, so no synchronous mkdir runs on each deferred flush.
export function summaryIndexPath() {
  return join(getPluginData(), 'session-summaries.json');
}

const _computeCleanPreview = cleanSummaryPreview;

// Every index flush re-normalizes EVERY row's stored title and preview, and
// cleaning runs a chain of regex replaces that each allocate a copy. Those
// short strings repeat from flush to flush, so the pure result is memoized per
// (max, text). Long raw message text is not kept here (see _previewFromMessage).
const CLEAN_PREVIEW_MEMO_TEXT_LIMIT = 2048;
const CLEAN_PREVIEW_MEMO_ENTRIES = 8192;
const cleanPreviewMemo = new Map(); // max → Map<text, cleaned>

function _cleanPreview(text, max = 240) {
  if (typeof text !== 'string' || text.length > CLEAN_PREVIEW_MEMO_TEXT_LIMIT) return _computeCleanPreview(text, max);
  let byText = cleanPreviewMemo.get(max);
  if (!byText) {
    byText = new Map();
    cleanPreviewMemo.set(max, byText);
  }
  let cleaned = byText.get(text);
  if (cleaned === undefined) {
    cleaned = _computeCleanPreview(text, max);
    if (byText.size >= CLEAN_PREVIEW_MEMO_ENTRIES) byText.clear();
    byText.set(text, cleaned);
  }
  return cleaned;
}

const sessionMessageProjectionMemo = new WeakMap();
// message → { raw, preview }. A session's first real user message is
// re-checked on every save; its text is re-derived (cheap) and the preview is
// recomputed only when that text actually changed, so an in-place content
// scrub still invalidates it while an unchanged (often huge) prompt is never
// re-cleaned.
const messagePreviewMemo = new WeakMap();

// Routine results (a schedule's output in its owner's home thread) follow ONE
// rule here: each is exactly one message of `messageCount` (so a thread's
// unread count, messageCount minus the read cursor, rises by one per result),
// never a real turn (`realTurnCount`), never the first-prompt `preview` the
// title falls back to, and shown as its notice line in `lastMessagePreview`.
function _previewFromMessage(message) {
  if (message?.role !== 'user' || isRoutineResultMessage(message)) return '';
  const raw = sessionMessageText(message.content);
  const memo = messagePreviewMemo.get(message);
  if (memo && memo.raw === raw) return memo.preview;
  const preview = isSessionPreviewNoise(raw) ? '' : _cleanPreview(raw);
  messagePreviewMemo.set(message, { raw, preview });
  return preview;
}

// message → { raw, preview } for the LAST conversational message, user or
// assistant alike (a messenger row's last-message line).
const lastMessagePreviewMemo = new WeakMap();

function _lastPreviewFromMessage(message) {
  const raw = lastMessageRawText(message);
  if (raw === null) return '';
  const memo = lastMessagePreviewMemo.get(message);
  if (memo && memo.raw === raw) return memo.preview;
  const preview = isSessionPreviewNoise(raw) ? '' : _cleanPreview(raw, LAST_MESSAGE_PREVIEW_MAX);
  lastMessagePreviewMemo.set(message, { raw, preview });
  return preview;
}

function _sessionMessageProjection(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const cached = session && typeof session === 'object' ? sessionMessageProjectionMemo.get(session) : null;
  let start = 0;
  let count = 0;
  let real = 0;
  let preview = '';
  let previewMessage = null;
  // Where the incoming messages with text sit among the counted ones (see
  // incomingTailOf), kept only for the threads that show an unread count.
  const wantsIncoming = wantsIncomingTail(session?.id);
  let incoming = [];
  // The totals ahead of the newest message, which a streamed reply fills in
  // place after it was counted: an append redoes that message from here.
  let ahead = null;
  const canAppend =
    cached &&
    messages.length >= cached.length &&
    (cached.length === 0 || messages[cached.length - 1] === cached.lastMessage);
  if (canAppend) {
    start = cached.length;
    count = cached.count;
    real = cached.real;
    incoming = cached.incoming.slice();
    if (cached.ahead) {
      start = cached.length - 1;
      ({ count, real } = cached.ahead);
      incoming = cached.ahead.incoming.slice();
    }
    preview = cached.preview;
    previewMessage = cached.previewMessage;
    // The first real user message is stable in normal append-only session
    // flow, but refresh it cheaply so an in-place content scrub still
    // invalidates the cached title source without rescanning the transcript.
    if (previewMessage) {
      const refreshed = _previewFromMessage(previewMessage);
      if (refreshed) preview = refreshed;
      else {
        start = 0;
        count = 0;
        real = 0;
        incoming = [];
        preview = '';
        previewMessage = null;
      }
    }
  }
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (index === messages.length - 1) ahead = { count, real, incoming: incoming.slice() };
    if (message && (message.role === 'user' || message.role === 'assistant')) {
      count += 1;
      if (wantsIncoming && isIncomingKind(message) && _lastPreviewFromMessage(message)) {
        incoming.push(count);
        if (incoming.length > INCOMING_TAIL_MAX) incoming.shift();
      }
    }
    if (isRealTurnMessage(message)) real += 1;
    if (!preview) {
      const candidate = _previewFromMessage(message);
      if (candidate) {
        preview = candidate;
        previewMessage = message;
      }
    }
  }
  // The newest line, read back from the tail every time: a streamed reply
  // fills its message in place. Tool-only and synthetic rows are skipped, and
  // each message's text is memoized, so this stays a few lookups per save.
  // The line's routine provenance rides along, so a client labels a routine
  // result by this marker and never by the line's wording.
  let last = '';
  let lastRoutine = null;
  for (let index = messages.length - 1; index >= 0 && !last; index -= 1) {
    last = _lastPreviewFromMessage(messages[index]);
    if (last) lastRoutine = routineProvenance(messages[index]);
  }
  if (session && typeof session === 'object') {
    sessionMessageProjectionMemo.set(session, {
      length: messages.length,
      lastMessage: messages[messages.length - 1] || null,
      count,
      real,
      incoming,
      ahead,
      preview,
      previewMessage,
    });
  }
  return { count, real, incoming: wantsIncoming ? incoming : null, preview, last, lastRoutine };
}

function _desktopSessionSummary(value, cwd = null) {
  if (!value || typeof value !== 'object') return null;
  if (value.classification === 'task') {
    return { classification: 'task', projectPath: null };
  }
  if (value.classification !== 'project') return null;
  const cleanPath = (path) => {
    if (typeof path !== 'string') return null;
    const trimmed = path.trim();
    return trimmed && !trimmed.includes('\0') ? trimmed : null;
  };
  const projectPath = cleanPath(value.projectPath) || cleanPath(cwd);
  return projectPath ? { classification: 'project', projectPath } : null;
}

export function _sessionSummary(session) {
  if (!session?.id) return null;
  const messageProjection = _sessionMessageProjection(session);
  return {
    id: String(session.id),
    updatedAt: _positiveNumber(session.updatedAt, Date.now()),
    // Conversation activity is intentionally separate from lifecycle
    // bookkeeping. Resume/detach saves can advance updatedAt without a
    // user-visible turn and must not reshuffle Recent session lists.
    lastUsedAt: _positiveNumber(session.lastUsedAt, 0),
    createdAt: _positiveNumber(session.createdAt, 0),
    lastHeartbeatAt: _positiveNumber(session.lastHeartbeatAt, 0),
    closed: session.closed === true,
    status: String(session.status || (session.closed === true ? 'closed' : 'idle')),
    owner: session.owner || 'user',
    agent: session.agent || null,
    // 'agent' | 'coding' (agent-mode.mjs); older records resolve it.
    sessionMode: sessionModeOf(session),
    sourceType: session.sourceType || null,
    sourceName: session.sourceName || null,
    scopeKey: session.scopeKey || null,
    parentSessionId: session.parentSessionId || null,
    ownerSessionId: session.ownerSessionId || session.parentSessionId || null,
    visibility: sessionVisibility(session),
    clientHostPid: _positiveNumber(session.clientHostPid, 0) || null,
    cwd: session.cwd || '',
    desktopSession: _desktopSessionSummary(session.desktopSession, session.cwd),
    ...(workspaceSummary(session.workspace) ? { workspace: workspaceSummary(session.workspace) } : {}),
    provider: session.provider || null,
    model: session.model || null,
    presetName: session.presetName || session.profileId || null,
    effort: session.effort || null,
    fast: session.fast === true,
    ...(session.autoEffort === false ? { autoEffort: false } : {}),
    modelParameters:
      session.modelParameters && typeof session.modelParameters === 'object' ? { ...session.modelParameters } : null,
    agentTag: session.agentTag || null,
    task_id: session.task_id || session.taskId || null,
    permission: session.permission || null,
    permissionMode: session.permissionMode || null,
    toolPermission: session.toolPermission || null,
    schemaAllowedTools: Array.isArray(session.schemaAllowedTools)
      ? session.schemaAllowedTools.map((name) => String(name))
      : null,
    taskType: session.taskType || null,
    messageCount: messageProjection.count,
    ...(messageProjection.incoming ? { incomingTail: messageProjection.incoming.slice() } : {}),
    // The numbering epoch of messageCount: a compaction restarts it.
    compactCount: compactCount(session.compaction) ?? 0,
    realTurnCount: messageProjection.real,
    title: _cleanPreview(session.title || '', 100),
    preview: messageProjection.preview,
    lastMessagePreview: messageProjection.last,
    lastMessageRoutine: messageProjection.lastRoutine,
    generation: typeof session.generation === 'number' ? session.generation : 0,
    storageMtimeMs: _positiveNumber(session.storageMtimeMs, 0),
    storageSize: _positiveNumber(session.storageSize, 0),
    // Lifecycle provenance for catalog filters: resume-machinery scratch
    // forks (detachedReason='cli-resume') must never surface in Recent.
    detachedReason: session.detachedReason || null,
    // Imported-conversation identity, so "already imported" is answered
    // from summaries without loading sessions.
    importKey: importKey(session),
    inheritedFromSessionId: inheritedFromSessionId(session),
  };
}

function _normalizeSummaryRow(row) {
  if (!row?.id || typeof row.id !== 'string' || !isStoredSessionId(row.id)) return null;
  return {
    id: row.id,
    updatedAt: _positiveNumber(row.updatedAt, 0),
    lastUsedAt: _positiveNumber(row.lastUsedAt, 0),
    createdAt: _positiveNumber(row.createdAt, 0),
    lastHeartbeatAt: _positiveNumber(row.lastHeartbeatAt, 0),
    closed: row.closed === true,
    status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
    owner: row.owner || 'user',
    agent: row.agent || null,
    sessionMode: sessionModeOf(row),
    sourceType: row.sourceType || null,
    sourceName: row.sourceName || null,
    scopeKey: row.scopeKey || null,
    parentSessionId: row.parentSessionId || null,
    ownerSessionId: row.ownerSessionId || row.parentSessionId || null,
    visibility: sessionVisibility(row),
    clientHostPid: _positiveNumber(row.clientHostPid, 0) || null,
    cwd: row.cwd || '',
    desktopSession: _desktopSessionSummary(row.desktopSession, row.cwd),
    ...(workspaceSummary(row.workspace) ? { workspace: workspaceSummary(row.workspace) } : {}),
    provider: row.provider || null,
    model: row.model || null,
    presetName: row.presetName || row.profileId || null,
    effort: row.effort || null,
    fast: row.fast === true,
    ...(row.autoEffort === false ? { autoEffort: false } : {}),
    modelParameters: row.modelParameters && typeof row.modelParameters === 'object' ? { ...row.modelParameters } : null,
    agentTag: row.agentTag || null,
    task_id: row.task_id || null,
    permission: row.permission || null,
    permissionMode: row.permissionMode || null,
    toolPermission: row.toolPermission || null,
    schemaAllowedTools: Array.isArray(row.schemaAllowedTools)
      ? row.schemaAllowedTools.map((name) => String(name))
      : null,
    taskType: row.taskType || null,
    messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
    ...(Array.isArray(row.incomingTail) ? { incomingTail: normalizedIncomingTail(row.incomingTail) } : {}),
    ...compactCountField(row),
    realTurnCount: realTurnCount(row),
    title: _cleanPreview(row.title || '', 100),
    preview: _cleanPreview(row.preview || ''),
    lastMessagePreview: _cleanPreview(row.lastMessagePreview || '', 160),
    lastMessageRoutine: normalizeRoutineProvenance(row.lastMessageRoutine),
    generation: typeof row.generation === 'number' ? row.generation : 0,
    storageMtimeMs: _positiveNumber(row.storageMtimeMs, 0),
    storageSize: _positiveNumber(row.storageSize, 0),
    detachedReason: row.detachedReason || null,
    importKey: importKey(row),
    inheritedFromSessionId: inheritedFromSessionId(row),
  };
}

export function _normalizeSummaryIndex(raw) {
  const rows = Array.isArray(raw?.rows) ? raw.rows.map(_normalizeSummaryRow).filter(Boolean) : [];
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { version: SESSION_SUMMARY_INDEX_VERSION, updatedAt: _positiveNumber(raw?.updatedAt, 0), rows };
}

export function _writeSummaryIndex(rows) {
  const cleanRows = (rows || [])
    .map(_normalizeSummaryRow)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // A full rewrite is authoritative: the delta log is emptied under the same
  // lock, or its older ops would replay over the fresh base.
  const path = summaryIndexPath();
  withFileLockSync(`${path}.lock`, () => {
    writeJsonAtomicSync(
      path,
      {
        version: SESSION_SUMMARY_INDEX_VERSION,
        updatedAt: Date.now(),
        rows: cleanRows,
      },
      { compact: true, lock: false }
    );
    try {
      truncateSync(summaryLogPath(path), 0);
    } catch {
      /* no log yet */
    }
  });
  return cleanRows;
}

// ── Non-blocking upsert/remove ──────────────────────────────────────────────
// The summary index is a best-effort sidecar, but its writers used to take
// the cross-process file lock with the DEFAULT 8s timeout — and
// withFileLockSync waits with Atomics.wait, which BLOCKS the main thread.
// Every session save calls _upsertSessionSummary, so with several mixdog
// processes (TUI + agent workers + memory service) contending on a multi-MB
// index, a busy lock froze typing/rendering for seconds at a time.
// Now: callers only QUEUE the mutation (O(1), no I/O) and the flush runs on
// a deferred tick with a ZERO-WAIT try-lock — if another process holds the
// lock we never sleep on it, we re-queue and retry on an unref'd timer. The
// caller's thread never blocks on this lock at all.
const SUMMARY_LOCK_TIMEOUT_MS = 0; // try-lock: acquire-or-fail, never wait
const SUMMARY_RETRY_DELAY_MS = 1000;
// Delta-log size that triggers folding it into the base (see store-summary-log.mjs).
const SUMMARY_LOG_COMPACT_BYTES = 1024 * 1024;
const _pendingUpserts = new Map(); // id → summary row (latest wins)
const _pendingRemovals = new Set(); // ids to drop (upsert/removal are mutually exclusive per id)
let _summaryRetryTimer = null;
let _summaryFlushScheduled = false;
let _summaryFlushInflight = 0;
// Ids whose ops the async flush in flight took (they are requeued if it fails).
const _inflightSummaryIds = new Set();
const _summarySettleWaiters = new Set(); // { ids: string[]|null, resolve }

export function _hasUnsettledSummaryOps() {
  return _pendingUpserts.size > 0 || _pendingRemovals.size > 0 || _summaryFlushScheduled || _summaryFlushInflight > 0;
}

/** The ids among `ids` whose summary ops are queued or being written. */
export function pendingSummaryIndexIds(ids) {
  return ids.filter((id) => _pendingUpserts.has(id) || _pendingRemovals.has(id) || _inflightSummaryIds.has(id));
}

function _waiterSettled({ ids }) {
  return ids ? pendingSummaryIndexIds(ids).length === 0 : !_hasUnsettledSummaryOps();
}

function _notifySummarySettled() {
  for (const waiter of _summarySettleWaiters) {
    if (_waiterSettled(waiter)) waiter.settle(true);
  }
}

/**
 * Resolves true once the queued summary-index mutations have landed — of
 * `ids` only when given, else every one with no flush scheduled or in flight;
 * from then on this process no longer touches the index for them. Callers
 * are told a save/sweep is done before its deferred index flush runs, so an
 * owner that removes or switches the data dir awaits this first. A flush
 * refused by a held lock (an overlapping flush of this process, or another
 * process) stays queued and settles when its retry lands. When `signal`
 * aborts first it resolves false and stops waiting; the ops stay queued.
 */
export function settleSummaryIndexWrites({ ids = null, signal = null } = {}) {
  const waiter = { ids, settle: null };
  if (_waiterSettled(waiter)) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  _summaryRetryTimer?.ref?.();
  return new Promise((resolve) => {
    const onAbort = () => waiter.settle(false);
    // The one exit, landed or abandoned: the waiter and its abort listener
    // both go, so a long-lived signal collects nothing per settle.
    waiter.settle = (landed) => {
      if (!_summarySettleWaiters.delete(waiter)) return;
      signal?.removeEventListener('abort', onAbort);
      // Only an awaited settlement keeps the process alive for the retry.
      if (_summarySettleWaiters.size === 0) _summaryRetryTimer?.unref?.();
      resolve(landed);
    };
    _summarySettleWaiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function _scheduleSummaryRetry() {
  if (_summaryRetryTimer) return;
  _summaryRetryTimer = setTimeout(() => {
    _summaryRetryTimer = null;
    _flushPendingSummaryOps();
    _notifySummarySettled();
  }, SUMMARY_RETRY_DELAY_MS);
  // Only an awaited settlement keeps the process alive for the retry.
  if (_summarySettleWaiters.size === 0) _summaryRetryTimer.unref?.();
}

// Defer the flush off the caller's stack: file I/O has no business on the
// keystroke/session-save path.
function _scheduleSummaryFlush() {
  // A scheduled retry will write whatever is pending; a flush in flight
  // schedules one follow-up when it settles. Either way, don't start another.
  if (_summaryFlushScheduled || _summaryRetryTimer || _summaryFlushInflight > 0) return;
  _summaryFlushScheduled = true;
  setImmediate(() => {
    _summaryFlushScheduled = false;
    _flushPendingSummaryOps();
    _notifySummarySettled();
  });
}

export function _flushPendingSummaryOps({ sync = false } = {}) {
  if (_pendingUpserts.size === 0 && _pendingRemovals.size === 0) return;
  // One async flush in flight per process; ops queued meanwhile stay pending
  // and are drained by the follow-up flush scheduled when it settles.
  if (!sync && _summaryFlushInflight > 0) return;
  // Snapshot + clear first: ops queued by other callers DURING the flush
  // must not be lost, and a failed flush re-queues only what it took
  // (without clobbering anything newer queued meanwhile).
  const upserts = new Map(_pendingUpserts);
  const removals = new Set(_pendingRemovals);
  _pendingUpserts.clear();
  _pendingRemovals.clear();
  const cleanUpserts = [];
  for (const row of upserts.values()) {
    const cleanRow = _normalizeSummaryRow(row);
    if (cleanRow) cleanUpserts.push(cleanRow);
  }
  const requeue = (error) => {
    if (error?.code === 'ELOCKCONTENDED' || error?.code === 'ELOCKTIMEOUT') _recordSummaryLockFailure();
    // Lock busy (or transient I/O failure) — re-queue what we took unless
    // a newer op for the same id arrived during the flush, then retry
    // asynchronously.
    for (const [id, row] of upserts) {
      if (!_pendingUpserts.has(id) && !_pendingRemovals.has(id)) _pendingUpserts.set(id, row);
    }
    for (const id of removals) {
      if (!_pendingUpserts.has(id)) _pendingRemovals.add(id);
    }
    _scheduleSummaryRetry();
  };
  // Exit-drain path needs the synchronous write (the loop may not pump
  // after 'exit'). Normal scheduled flushes on the lead/TUI main process
  // use the async try-lock: the lock WAIT is off the event loop, so a
  // busy multi-MB index never freezes typing/rendering.
  if (cleanUpserts.length === 0 && removals.size === 0) return;
  const text = encodeSummaryOps(cleanUpserts, removals);
  const path = summaryIndexPath();
  if (sync) {
    // Exit drain: append only (never compact — that is a full rewrite).
    try {
      withFileLockSync(
        `${path}.lock`,
        () => {
          mkdirSync(dirname(path), { recursive: true });
          appendFileSync(summaryLogPath(path), text, { mode: 0o600 });
        },
        { timeoutMs: SUMMARY_LOCK_TIMEOUT_MS }
      );
    } catch (error) {
      requeue(error);
    }
    _notifySummarySettled();
    return;
  }
  _summaryFlushInflight++;
  const taken = [...upserts.keys(), ...removals];
  for (const id of taken) _inflightSummaryIds.add(id);
  withFileLock(`${path}.lock`, () => _appendSummaryOpsLocked(path, text), { timeoutMs: SUMMARY_LOCK_TIMEOUT_MS })
    .then(() => _sweepStaleSummaryTempOnce(path))
    .catch(requeue)
    .finally(() => {
      _summaryFlushInflight--;
      for (const id of taken) _inflightSummaryIds.delete(id);
      if (_pendingUpserts.size > 0 || _pendingRemovals.size > 0) _scheduleSummaryFlush();
      _notifySummarySettled();
    });
}

// Append one batch of ops to the delta log; fold the log into the base once it
// outgrows SUMMARY_LOG_COMPACT_BYTES. Runs under the index lock.
async function _appendSummaryOpsLocked(path, text) {
  const logPath = summaryLogPath(path);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(logPath, text, { mode: 0o600 });
  // The ops are durable once appended; a failed compaction is retried by a
  // later flush and must not re-queue (and re-append) this batch.
  try {
    if ((await stat(logPath)).size >= SUMMARY_LOG_COMPACT_BYTES) await _compactSummaryIndexLocked(path);
  } catch {
    /* best effort */
  }
}

/** Fold base + log into a fresh base and empty the log. The caller holds the
 *  index lock, which every appender and full rewrite also takes. A crash
 *  between the two steps leaves ops in the log that the new base already
 *  has; replay is last-writer-wins per id, so that is harmless. */
async function _compactSummaryIndexLocked(path) {
  const logPath = summaryLogPath(path);
  let logText = '';
  try {
    logText = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let base = null;
  try {
    base = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const { rows } = _normalizeSummaryIndex(applySummaryLogText(base ?? {}, logText));
  await writeJsonAtomicAsync(
    path,
    { version: SESSION_SUMMARY_INDEX_VERSION, updatedAt: Date.now(), rows },
    { compact: true, lock: false }
  );
  await truncate(logPath, 0);
}

/** Fold the delta log into the base now (tests, maintenance). Resolves false
 *  when another process holds the index lock. */
export async function compactSummaryIndex() {
  const path = summaryIndexPath();
  try {
    await withFileLock(`${path}.lock`, () => _compactSummaryIndexLocked(path), { timeoutMs: SUMMARY_LOCK_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (error?.code === 'ELOCKCONTENDED' || error?.code === 'ELOCKTIMEOUT') {
      _recordSummaryLockFailure();
      return false;
    }
    throw error;
  }
}

// ── Try-lock failure accounting ─────────────────────────────────────────────
// A refused try-lock re-queues and retries every SUMMARY_RETRY_DELAY_MS; that
// used to be invisible. Failures are counted and reported at most once per
// SUMMARY_LOCK_FAILURE_LOG_INTERVAL_MS (the first one immediately).
const SUMMARY_LOCK_FAILURE_LOG_INTERVAL_MS = 60_000;
let _lockFailuresTotal = 0;
let _lockFailuresUnreported = 0;
let _lastLockFailureReportAt = 0;

function _recordSummaryLockFailure(now = Date.now()) {
  _lockFailuresTotal += 1;
  _lockFailuresUnreported += 1;
  if (_lastLockFailureReportAt !== 0 && now - _lastLockFailureReportAt < SUMMARY_LOCK_FAILURE_LOG_INTERVAL_MS) return;
  process.stderr.write(
    `[session-summaries] index lock busy: ${_lockFailuresUnreported} try-lock failure(s) since last report ` +
      `(${_lockFailuresTotal} total); retrying every ${SUMMARY_RETRY_DELAY_MS}ms\n`
  );
  _lastLockFailureReportAt = now;
  _lockFailuresUnreported = 0;
}

/** Diagnostic seam: try-lock failures seen by this process. */
export function summaryLockFailureStats() {
  return { total: _lockFailuresTotal, unreported: _lockFailuresUnreported };
}

// ── Stale temp sweep ────────────────────────────────────────────────────────
// A crash between an atomic write's temp file and its rename orphans
// `session-summaries.json.mixdog-tmp-<16 hex>` (multi-MB each; before the
// cloud-sync fix `.session-summaries.json.<24 hex>.tmp`). Only this store's
// pattern is touched. Deleted only when older than SUMMARY_TMP_MIN_AGE_MS and
// while holding the index lock: every writer of these temps (full rewrite,
// compaction) holds that lock for the whole write, so no live writer can own a
// temp file the sweep sees.
const SUMMARY_TMP_PATTERN =
  /^(?:\.session-summaries\.json\.[0-9a-f]{24}\.tmp|session-summaries\.json\.mixdog-tmp-[0-9a-f]{16,24})$/;
const SUMMARY_TMP_MIN_AGE_MS = 10 * 60 * 1000;
let _sweptSummaryDir = '';

export async function sweepStaleSummaryTempFiles({ now = Date.now(), minAgeMs = SUMMARY_TMP_MIN_AGE_MS } = {}) {
  const path = summaryIndexPath();
  const dir = dirname(path);
  return withFileLock(
    `${path}.lock`,
    async () => {
      let removed = 0;
      let names;
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      for (const name of names) {
        if (!SUMMARY_TMP_PATTERN.test(name)) continue;
        const file = join(dir, name);
        try {
          if (now - (await stat(file)).mtimeMs < minAgeMs) continue;
          await unlink(file);
          removed += 1;
        } catch {
          /* raced away or unremovable: leave it */
        }
      }
      return removed;
    },
    { timeoutMs: SUMMARY_LOCK_TIMEOUT_MS }
  );
}

// Once per process and data dir, after the first successful flush. A busy lock
// skips this round; the next flush tries again.
async function _sweepStaleSummaryTempOnce(path) {
  const dir = dirname(path);
  if (_sweptSummaryDir === dir) return;
  try {
    const removed = await sweepStaleSummaryTempFiles();
    _sweptSummaryDir = dir;
    if (removed > 0) process.stderr.write(`[session-summaries] removed ${removed} stale temp file(s)\n`);
  } catch {
    /* lock busy or I/O error: best effort */
  }
}

export function _upsertSessionSummary(session) {
  const row = _sessionSummary(session);
  _upsertSessionSummaryRow(row);
}

export function _upsertSessionSummaryRow(row) {
  if (!row) return;
  _pendingRemovals.delete(row.id);
  _pendingUpserts.set(row.id, row);
  _scheduleSummaryFlush();
}

export function _removeSessionSummary(id) {
  if (!id) return;
  _pendingUpserts.delete(id);
  _pendingRemovals.add(id);
  _scheduleSummaryFlush();
}

/**
 * Batch removal: prune MANY ids from the summary index in a single
 * read-modify-write. Bulk deleters (tombstone sweep) must use this instead
 * of per-id _removeSessionSummary — the index is O(sessions) in size, so
 * per-id rewrites make a large sweep quadratic in total I/O.
 */
export function _pruneSummaryIndexIds(ids) {
  if (!(ids instanceof Set) || ids.size === 0) return;
  for (const id of ids) {
    _pendingUpserts.delete(id);
    _pendingRemovals.add(id);
  }
  _scheduleSummaryFlush();
}
