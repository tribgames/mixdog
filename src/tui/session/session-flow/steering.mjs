/**
 * src/tui/session/session-flow/steering.mjs - lead steering: mid-turn drain of
 * queued entries into model-visible steering messages, commit bookkeeping, and
 * crash-safe restore of persisted steering rows.
 */
import {
  isGoalQueuedEntry,
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isSlashQueuedEntry,
  callCommitCallbacks,
  STEERING_SUPPRESSED_DISPLAY,
} from '../queue-helpers.mjs';
import { dropTuiSteeringPersist, drainTuiSteeringPersist } from '../tui-steering-persist.mjs';

const RESTORE_DEDUP_WINDOW = 80;

// Mid-chain drain converts queued prompt/task notification entries into
// model-visible "queued_command" style steering only at provider continuation
// boundaries. Slash commands stay queued for the post-turn command processor.
function isSteerableEntry(entry) {
  if (isSlashQueuedEntry(entry)) return false;
  const mode = entry?.mode || 'prompt';
  return mode === 'prompt' || mode === 'task-notification' || mode === 'goal-closeout';
}

function steeringMessageFromEntry(entry) {
  const content = entry.content;
  const meta = {
    id: entry.id,
    submittedAt: entry.submittedAt,
    ...(Array.isArray(entry.images) && entry.images.length ? { images: entry.images } : {}),
    ...(entry.transcriptMeta && typeof entry.transcriptMeta === 'object'
      ? { transcriptMeta: entry.transcriptMeta }
      : {}),
  };
  if (entry.suppressDisplay) {
    // Model-visible twin of an already-rendered live completion: deliver
    // content to the model but flag onSteerMessage to skip the duplicate
    // transcript card (no fall-back to content-derived display text).
    const hasContent = Array.isArray(content) ? content.length > 0 : String(content ?? '').trim().length > 0;
    return hasContent ? { ...meta, text: STEERING_SUPPRESSED_DISPLAY, content } : null;
  }
  const displayText = String(entry.text || '').trim();
  if (typeof content === 'string') {
    const value = content.trim();
    return value.length > 0 ? { ...meta, text: displayText || value, content: value } : null;
  }
  if (Array.isArray(content)) {
    return content.length > 0 ? { ...meta, text: displayText, content } : null;
  }
  return String(content ?? '').trim().length > 0 ? { ...meta, text: displayText, content } : null;
}

// Recent user message bodies define "already delivered" for restore dedup;
// substring (not equality) because steering delivery may wrap the raw text.
function recentUserTexts(session, window) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const out = [];
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < window; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    seen += 1;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
    }
    if (text.trim()) out.push(text);
  }
  return out;
}

export function createSteeringOps(bag, { queue, submissions }) {
  const { runtime, pending, getState, set } = bag;

  const leadSessionId = () => runtime.id;

  function shouldMirrorSteeringEntry(entry) {
    return isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry);
  }

  function commitSteeringQueueEntries(entries) {
    callCommitCallbacks(entries);
    const mirrored = (Array.isArray(entries) ? entries : []).filter(
      (entry) => shouldMirrorSteeringEntry(entry) && !entry.steeringPersistRestored
    );
    if (mirrored.length > 0) dropTuiSteeringPersist(leadSessionId(), mirrored);
  }

  // `later` notifications (scheduled tasks) are skipped unless the runtime
  // explicitly asks for a later flush.
  function drainPendingSteering(_sessionIdOrOptions = null, maybeOptions = null) {
    let options = {};
    if (maybeOptions && typeof maybeOptions === 'object') options = maybeOptions;
    else if (_sessionIdOrOptions && typeof _sessionIdOrOptions === 'object') options = _sessionIdOrOptions;
    const maxPriority = options.maxPriority || 'next';
    const out = [];
    for (;;) {
      const batch = queue.dequeueQueueBatch(maxPriority, { predicate: isSteerableEntry });
      if (batch.length === 0) break;
      const accepted = batch.filter(
        (entry) => !isGoalQueuedEntry(entry) || bag.shouldRunGoalContinuation?.(entry) === true
      );
      for (const entry of accepted) {
        const message = steeringMessageFromEntry(entry);
        if (message) out.push(message);
      }
      commitSteeringQueueEntries(accepted);
    }
    return out;
  }

  async function restoreLeadSteeringFromDisk() {
    const rows = await drainTuiSteeringPersist(leadSessionId());
    if (!rows.length) return;
    const livePersistIds = new Set(pending.map((entry) => entry?.steeringPersistId).filter(Boolean));
    // Crash-consumed dedup: a row whose text already landed in the session
    // transcript was consumed before the restart — only its disk drop was
    // lost (drop is an async fire-and-forget write). Re-queuing it silently
    // re-injects a stale prompt into the next turn (user report: surprise
    // self-injection after a process restart).
    const delivered = recentUserTexts(runtime.session, RESTORE_DEDUP_WINDOW);
    const alreadyDelivered = (text) => delivered.some((body) => body.includes(text));
    const restored = [];
    let droppedDelivered = 0;
    for (const row of rows) {
      const text = String(row?.text || '').trim();
      if (!text) continue;
      // Live enqueue already holds this row (id assigned before the async
      // disk write). Replaying it is the classic double-booked queue.
      if (row.steeringPersistId && livePersistIds.has(row.steeringPersistId)) continue;
      if (alreadyDelivered(text)) {
        droppedDelivered += 1;
        continue;
      }
      const entry = queue.makeQueueEntry(row.text, {
        id: row.submissionId || undefined,
        submittedAt: row.submittedAt || undefined,
        steeringPersistRestored: true,
        steeringPersistId: row.steeringPersistId || undefined,
      });
      pending.push(entry);
      if (row.submissionId) submissions.remember(row.submissionId);
      if (entry.steeringPersistId) livePersistIds.add(entry.steeringPersistId);
      if (isQueuedEntryVisible(entry)) restored.push(entry);
    }
    if (restored.length > 0) set({ queued: [...getState().queued, ...restored] });
    if (droppedDelivered > 0) {
      try {
        process.stderr.write(`[tui] skipped ${droppedDelivered} already-delivered steering row(s) on restore\n`);
      } catch {
        /* best effort */
      }
    }
    // Recovery must not create a user turn by itself. An idle reconnect leaves
    // the restored rows visible/editable in the queue; a real active-turn
    // boundary or later submit will invoke the normal drain path.
  }

  return {
    leadSessionId,
    shouldMirrorSteeringEntry,
    commitSteeringQueueEntries,
    drainPendingSteering,
    restoreLeadSteeringFromDisk,
  };
}
