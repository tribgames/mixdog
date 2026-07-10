/**
 * src/tui/engine/agent-job-feed.mjs — agent-job / runtime-notification plumbing
 * extracted from createEngineSession (engine.mjs) as a dependency-injection
 * factory.
 *
 * Owns: the agent-job card result patch (updateAgentJobCard), the
 * execution-pending-resume kick trio (kick / flushDeferred / schedule), and the
 * runtime.onNotification subscription that routes runtime notifications into the
 * store (status refresh, execution-ui synthetic items, model-visible enqueue).
 *
 * These handlers mutate live session state and drive the queue, so
 * state/set/enqueue/drain/pushUserOrSyntheticItem/patchItem/etc are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots. Every body
 * is the original engine.mjs logic verbatim.
 */
import {
  parseAgentJob,
  agentJobResultText,
  agentArgsWithResultMetadata,
} from './agent-envelope.mjs';
import { toolErrorDisplay } from './tool-result-text.mjs';
import {
  notificationQueueKey,
  executionCardKey,
  resolveTuiRuntimeNotificationDelivery,
} from './notification-plan.mjs';
import { shortTextFingerprint } from './queue-helpers.mjs';
import { readImageAttachmentFromPath } from '../paste-attachments.mjs';
import {
  isDeliveredCompletion,
  recordDeliveredCompletion,
} from '../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';

// Channel inbound images arrive as a JSON-array-of-paths meta value (stringified
// across the notify IPC boundary). Parse defensively; a malformed value simply
// yields no images and the notification degrades to its text body.
function parseInboundImagePaths(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

export function createAgentJobFeed({
  runtime,
  getState,
  set,
  nextId,
  getDisposed,
  patchItem,
  enqueue,
  drain,
  pushUserOrSyntheticItem,
  pushAsyncAgentResponse,
  makeQueueEntry,
  getPending,
  agentStatusState,
  displayedExecutionNotificationKeys,
  itemIndexById,
  pushNotice,
  now = () => Date.now(),
  executionResumeTombstoneTtlMs = 30_000,
  executionResumeTombstoneLimit = 128,
}) {
  const executionDedupLimit = 256;
  let executionResumeKickDeferred = false;
  // Completion keys explicitly abandoned by Esc. Tombstones are per-feed
  // (therefore per TUI session), short-lived, and bounded: they catch a late
  // duplicate racing the abort without permanently reserving execution IDs or
  // retaining completion bodies.
  const discardedExecutionResumeKeys = new Map();
  // Tracks whether an execution's visible response is only a bodyless preview
  // or has reached its final body. A preview must not permanently suppress the
  // later body, while repeated body retries remain idempotent.
  const displayedExecutionResponseStates = new Map();
  const terminalExecutionNotificationKeys = new Set();
  const terminalExecutionResponseKeys = new Set();
  const executionNotificationKeys = new Map();

  const clearExecutionDedupState = () => {
    displayedExecutionNotificationKeys.clear();
    displayedExecutionResponseStates.clear();
    terminalExecutionNotificationKeys.clear();
    terminalExecutionResponseKeys.clear();
    executionNotificationKeys.clear();
  };
  const rememberDisplayedExecutionNotificationKey = (key, terminal = false, executionId = '') => {
    if (!key) return;
    displayedExecutionNotificationKeys.delete(key);
    if (executionId) executionNotificationKeys.set(key, executionId);
    if (terminal) terminalExecutionNotificationKeys.add(key);
    else terminalExecutionNotificationKeys.delete(key);
    while (displayedExecutionNotificationKeys.size >= executionDedupLimit) {
      const oldestTerminal = [...displayedExecutionNotificationKeys]
        .find((candidate) => terminalExecutionNotificationKeys.has(candidate));
      if (oldestTerminal == null) break;
      displayedExecutionNotificationKeys.delete(oldestTerminal);
      terminalExecutionNotificationKeys.delete(oldestTerminal);
      executionNotificationKeys.delete(oldestTerminal);
    }
    displayedExecutionNotificationKeys.add(key);
  };
  const promoteExecutionNotificationKeys = (executionId) => {
    if (!executionId) return;
    for (const [key, keyExecutionId] of executionNotificationKeys) {
      if (keyExecutionId !== executionId || !displayedExecutionNotificationKeys.has(key)) continue;
      terminalExecutionNotificationKeys.add(key);
    }
  };
  const promoteExecutionDedupState = (executionId) => {
    if (!executionId) return;
    promoteExecutionNotificationKeys(executionId);
    const responseState = displayedExecutionResponseStates.get(executionId);
    if (responseState) rememberDisplayedExecutionResponseState(executionId, responseState, true);
  };
  const rememberDisplayedExecutionResponseState = (key, value, terminal = false) => {
    if (!key) return;
    displayedExecutionResponseStates.delete(key);
    if (terminal) terminalExecutionResponseKeys.add(key);
    else terminalExecutionResponseKeys.delete(key);
    while (displayedExecutionResponseStates.size >= executionDedupLimit) {
      const oldestTerminal = [...displayedExecutionResponseStates.keys()]
        .find((candidate) => terminalExecutionResponseKeys.has(candidate));
      if (oldestTerminal == null) break;
      displayedExecutionResponseStates.delete(oldestTerminal);
      terminalExecutionResponseKeys.delete(oldestTerminal);
    }
    displayedExecutionResponseStates.set(key, value);
  };

  // FIFO accumulation of model-visible bodies from completions that arrived
  // while busy (or while a pending-resume entry was already queued). A single
  // string slot dropped all-but-the-last body when parallel completions landed;
  // the queue preserves every body and merges them into the resume turn.
  const executionResumeKickBodies = [];

  function executionResumeKey(body, completionKey = '') {
    if (completionKey && typeof completionKey === 'object') {
      completionKey = completionKey.executionId || completionKey.key || '';
    }
    const explicitKey = String(completionKey || '').trim();
    if (explicitKey.startsWith('execution:') || explicitKey.startsWith('body:')) return explicitKey;
    if (explicitKey) return `execution:${explicitKey}`;
    const value = String(body || '').trim();
    return value ? `body:${shortTextFingerprint(value)}` : '';
  }

  function pruneDiscardedExecutionResumeKeys() {
    const nowMs = Number(now()) || Date.now();
    for (const [key, expiresAt] of discardedExecutionResumeKeys) {
      if (expiresAt <= nowMs) discardedExecutionResumeKeys.delete(key);
    }
  }

  function isDiscardedExecutionResumeKey(key) {
    if (!key) return false;
    pruneDiscardedExecutionResumeKeys();
    return discardedExecutionResumeKeys.has(key);
  }

  function rememberDiscardedExecutionResumeKey(key) {
    if (!key) return;
    pruneDiscardedExecutionResumeKeys();
    const limit = Math.max(1, Number(executionResumeTombstoneLimit) || 128);
    while (!discardedExecutionResumeKeys.has(key) && discardedExecutionResumeKeys.size >= limit) {
      const oldest = discardedExecutionResumeKeys.keys().next().value;
      if (oldest == null) break;
      discardedExecutionResumeKeys.delete(oldest);
    }
    const ttlMs = Math.max(1, Number(executionResumeTombstoneTtlMs) || 30_000);
    // Refresh insertion order so the bounded map evicts the oldest tombstone.
    discardedExecutionResumeKeys.delete(key);
    discardedExecutionResumeKeys.set(key, (Number(now()) || Date.now()) + ttlMs);
  }

  function kickExecutionPendingResume(body = '', completionKey = '') {
    const key = executionResumeKey(body, completionKey);
    if (body && isDiscardedExecutionResumeKey(key)) return;
    if (body) executionResumeKickBodies.push({ body, key });
    if (getDisposed()) return;
    if (getState().busy) {
      executionResumeKickDeferred = true;
      return;
    }
    const pending = getPending();
    if (pending.some((entry) => entry.mode === 'pending-resume')) {
      executionResumeKickDeferred = true;
      return;
    }
    executionResumeKickDeferred = false;
    // Drain every accumulated body into ONE resume turn so no completion body
    // is lost when several deferred while busy.
    const resumeBodies = executionResumeKickBodies.splice(0);
    const resumeBody = resumeBodies.map(({ body: value }) => value).filter(Boolean).join('\n\n');
    const resumeCompletionKeys = resumeBodies.map(({ key }) => key).filter(Boolean);
    pending.push(makeQueueEntry(resumeBody, {
      mode: 'pending-resume',
      priority: 'next',
      abortDiscardOnAbort: true,
      resumeCompletionKeys,
    }));
    void drain();
  }

  function flushDeferredExecutionPendingResumeKick() {
    if (!executionResumeKickDeferred || getDisposed() || getState().busy) return;
    kickExecutionPendingResume();
  }

  function scheduleExecutionPendingResumeKick(body = '', completionKey = '') {
    // Carry the model-visible body directly into the pending-resume entry so
    // the resumed turn sends it, instead of relying on the session-pending
    // completion marker (dropped by askSession pre-drain).
    queueMicrotask(() => kickExecutionPendingResume(body, completionKey));
  }

  function discardExecutionPendingResume(completionKeys = []) {
    const keys = (Array.isArray(completionKeys) ? completionKeys : [completionKeys])
      .map((key) => executionResumeKey('', key))
      .filter(Boolean);
    if (keys.length === 0) return;
    for (const key of keys) rememberDiscardedExecutionResumeKey(key);
    for (let i = executionResumeKickBodies.length - 1; i >= 0; i -= 1) {
      if (isDiscardedExecutionResumeKey(executionResumeKickBodies[i].key)) {
        executionResumeKickBodies.splice(i, 1);
      }
    }
    executionResumeKickDeferred = executionResumeKickBodies.length > 0;
  }

  // Pure builder for the agent-job card patch. Split out so callers that are
  // already patching the same card in the same tick (see tool-card-results
  // non-aggregate path) can MERGE these fields into their single patchItem
  // instead of issuing a second set() — collapsing the L1/L2 double-update
  // jitter into one visible item update.
  function buildAgentJobCardPatch(itemId, text, isError = false) {
    const parsed = parseAgentJob(text);
    const index = itemIndexById?.get(itemId);
    const current = Number.isInteger(index) && getState().items[index]?.id === itemId
      ? getState().items[index]
      : null;
    const rawDisplayText = agentJobResultText(text, parsed) || String(text ?? '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'agent') : rawDisplayText;
    return {
      result: displayText,
      text: displayText,
      isError,
      errorCount: isError ? 1 : 0,
      ...(parsed ? { args: agentArgsWithResultMetadata(current?.args, parsed) } : {}),
    };
  }

  function updateAgentJobCard(itemId, text, isError = false) {
    patchItem(itemId, buildAgentJobCardPatch(itemId, text, isError));
  }

  function refreshAgentStatus(parsed) {
    if (!parsed?.taskId) return;
    const status = String(parsed.status || '').toLowerCase();
    const terminal = /^(completed|complete|done|success|succeeded|ok|failed|error|timeout|killed|cancelled|canceled|denied)$/.test(status);
    set(agentStatusState(terminal ? { force: true } : undefined));
  }

  function subscribeRuntimeNotifications() {
    if (typeof runtime.onNotification !== 'function') return null;
    const unsubscribe = runtime.onNotification((event) => {
      if (getDisposed()) return;
      const text = String(event?.content ?? event?.text ?? event ?? '').trim();
      if (!text) return;
      const parsed = parseAgentJob(text);
      const notificationKey = notificationQueueKey(event, text, parsed);
      const delivery = resolveTuiRuntimeNotificationDelivery(event, text);
      const executionId = String(event?.meta?.execution_id || parsed?.taskId || '').trim();
      const status = String(event?.meta?.status || parsed?.status || '').toLowerCase();
      const terminalStatus = /^(completed|complete|done|success|succeeded|ok|failed|error|timeout|killed|cancelled|canceled|denied)$/.test(status);
      if (terminalStatus) promoteExecutionDedupState(executionId);
      if (delivery.action === 'ignore') return;
      if (delivery.action === 'notice') {
        pushNotice?.(delivery.displayText, delivery.tone || 'info', { transcript: delivery.transcript === true });
        return true;
      }
      if (delivery.action === 'status-only') {
        refreshAgentStatus(parsed);
        return true;
      }
      if (delivery.action === 'execution-ui') {
        const cardKey = executionCardKey(event, text, parsed);
        const firstDelivery = !cardKey || !displayedExecutionNotificationKeys.has(cardKey);
        const hasBody = /\n\s*\n[\s\S]*\S/.test(text);
        const isFailure = /^(failed|error|timeout|killed|cancelled|canceled|denied)$/.test(status);
        const successfulPreview = !hasBody && !isFailure && /^(completed|complete|done|success|succeeded|ok)$/.test(status);
        const terminal = terminalStatus;
        const responseState = executionId ? displayedExecutionResponseStates.get(executionId) : '';
        const bodyAlreadyDisplayed = responseState === 'body';
        if (cardKey && terminal && displayedExecutionNotificationKeys.has(cardKey)) {
          rememberDisplayedExecutionNotificationKey(cardKey, true, executionId);
        }
        if (terminal) promoteExecutionDedupState(executionId);
        if (firstDelivery && !successfulPreview && !bodyAlreadyDisplayed) {
          if (cardKey) rememberDisplayedExecutionNotificationKey(cardKey, terminal, executionId);
          if (executionId) rememberDisplayedExecutionResponseState(executionId, hasBody ? 'body' : 'preview', terminal);
          // Execution completions are inbound agent responses. The engine keeps
          // their aggregation tail-safe (only an immediately-adjacent inbound
          // response of the same preview/body phase can merge); the fallback
          // preserves the standalone path for minimal/test harnesses.
          (pushAsyncAgentResponse || pushUserOrSyntheticItem)(delivery.displayText, nextId(), 'injected', { responseKey: executionId });
        }
        refreshAgentStatus(parsed);
        const resumeBody = String(delivery.modelContent || '').trim();
        if (resumeBody) {
          const completionKey = executionResumeKey(resumeBody, executionId);
          // Consolidated completion dedup keyed off execution_id (+ text hash):
          // if this exact execution completion was already delivered — either by
          // an earlier TUI enqueue here or by runtime-core's ack — do NOT enqueue
          // a duplicate model-visible twin. A re-arriving completion while IDLE
          // would otherwise re-enqueue and let post-turn drain() spawn a fresh
          // turn. Still ack (modelVisibleDelivered) so runtime-core's
          // mirror/fallback stays suppressed; the card first-delivery push and
          // status refresh above already ran.
          if (isDiscardedExecutionResumeKey(completionKey) || isDeliveredCompletion({ executionId, text: resumeBody })) {
            if (event && typeof event === 'object') event.modelVisibleDelivered = true;
            return true;
          }
          const enqueued = enqueue(resumeBody, {
            mode: 'task-notification',
            // Claude Code parity: live execution completions are queued as
            // task notifications so the active loop can attach them after the
            // next tool batch; no special pending-resume bypass.
            priority: 'next',
            key: notificationKey || undefined,
            abortDiscardOnAbort: true,
            resumeCompletionKeys: completionKey ? [completionKey] : [],
            displayText: delivery.displayText || text,
            // The immediate Response card was already pushed above
            // (pushUserOrSyntheticItem). Keep this queued twin model-visible
            // but suppress its drain-time transcript card to avoid a duplicate.
            suppressDisplay: true,
          });
          // Self-sufficient TUI dedup: mark delivered right here (mark-once at
          // delivery, keyed by execution_id) so a re-arriving completion is
          // skipped above without depending solely on the runtime-core ack
          // roundtrip — removes the split-brain asymmetry. Gated on a CONFIRMED
          // enqueue: enqueue() returns false only when an identical-key
          // task-notification twin is already queued (session-flow.mjs
          // pendingNotificationKeys.has(key)), in which case the completion is
          // already pending delivery and must not be double-recorded.
          if (enqueued) recordDeliveredCompletion({ executionId, text: resumeBody });
          // EXPLICIT ack to the emitting runtime: the model-visible completion
          // body was injected into the active loop here, so notifyFnForSession
          // must NOT also mirror it into the pending queue (double injection).
          // A bare truthy return below is display/status handling only — this
          // flag is the sole model-visible-delivery signal. Set for BOTH the
          // real-enqueue and the enqueue===false (already-queued twin) cases:
          // either way the completion is pending delivery on the TUI path, so
          // runtime-core must still not mirror it.
          if (event && typeof event === 'object') event.modelVisibleDelivered = true;
        }
        return true;
      }
      refreshAgentStatus(parsed);
      const modelContent = String(delivery.modelContent ?? delivery.displayText ?? text).trim();
      const imagePaths = parseInboundImagePaths(event?.meta?.image_paths);
      if (!modelContent && imagePaths.length === 0) return true;
      const enqueueOpts = {
        mode: 'task-notification',
        // Claude Code parity: task/schedule notifications are lower-priority
        // queue items and drain between turns, behind direct user input.
        priority: 'later',
        key: notificationKey || undefined,
        displayText: delivery.displayText || text,
      };
      if (imagePaths.length > 0) {
        // Read each downloaded image into a real image content block so the
        // channel turn is vision-visible. Async, but the notification is
        // already "handled" (return true) — the enqueue lands on resolve.
        // Any unreadable path is skipped; if none load, fall back to text.
        void (async () => {
          if (getDisposed()) return;
          const parts = [];
          if (modelContent) parts.push({ type: 'text', text: modelContent });
          for (const p of imagePaths) {
            let att = null;
            try { att = await readImageAttachmentFromPath(p); } catch { att = null; }
            if (!att) continue;
            if (att.metadataText) parts.push({ type: 'text', text: att.metadataText });
            parts.push({ type: 'image', data: att.content, mimeType: att.mediaType || 'image/png' });
          }
          if (getDisposed()) return;
          const hasImage = parts.some((part) => part.type === 'image');
          if (!hasImage && !modelContent) return;
          enqueue(hasImage ? parts : modelContent, enqueueOpts);
        })();
        return true;
      }
      enqueue(modelContent, enqueueOpts);
      return true;
    });
    return () => {
      try { unsubscribe?.(); } finally { clearExecutionDedupState(); }
    };
  }

  return {
    kickExecutionPendingResume,
    flushDeferredExecutionPendingResumeKick,
    scheduleExecutionPendingResumeKick,
    discardExecutionPendingResume,
    updateAgentJobCard,
    buildAgentJobCardPatch,
    subscribeRuntimeNotifications,
    clearExecutionDedupState,
  };
}
