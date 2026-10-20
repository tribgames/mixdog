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
  queuePriorityValue,
  callCommitCallbacks,
  STEERING_SUPPRESSED_DISPLAY,
} from '../queue-helpers.mjs';
import { dropTuiSteeringPersist, readTuiSteeringPersist } from '../tui-steering-persist.mjs';
import { getBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';

const RESTORE_DEDUP_WINDOW = 80;
// An older build's process-local item counter: a later process issues the
// same ids again, so such an id proves nothing about delivery.
const PROCESS_LOCAL_ITEM_ID = /^it_\d+$/;

// Mid-chain drain converts queued prompt/task notification entries into
// model-visible "queued_command" style steering only at provider continuation
// boundaries. Slash commands stay queued for the post-turn command processor.
function isSteerableEntry(entry) {
  if (isSlashQueuedEntry(entry)) return false;
  const mode = entry?.mode || 'prompt';
  return mode === 'prompt' || mode === 'task-notification' || mode === 'goal-closeout';
}

// A completion is queued the moment its task settles, which is usually before
// the model's own `task wait`/`task read` returns that same result and ACKs it.
// Delivering the queued twin afterwards repeats a result the model already has.
function isAcknowledgedCompletion(entry) {
  if (entry?.mode !== 'task-notification' || !entry.execution?.id) return false;
  return getBackgroundTask(entry.execution.id)?.completionAcknowledged === true;
}

function steeringMessageFromEntry(entry) {
  if (isAcknowledgedCompletion(entry)) return null;
  const content = entry.content;
  const meta = {
    id: entry.id,
    submittedAt: entry.submittedAt,
    mode: entry.mode,
    ...(entry.execution && typeof entry.execution === 'object' ? { execution: { ...entry.execution } } : {}),
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

// The submissions the transcript holds: a turn's prompt (`checkpointId`, plus
// `submissionIds` for a merged batch) and a steered message's `submissionIds`.
function deliveredSubmissionIds(session) {
  const out = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    if (message?.role !== 'user') continue;
    const meta = message.meta || {};
    const transcript = meta.transcript || {};
    for (const id of [
      transcript.checkpointId,
      ...(Array.isArray(transcript.submissionIds) ? transcript.submissionIds : []),
      ...(Array.isArray(meta.submissionIds) ? meta.submissionIds : []),
    ]) {
      if (typeof id === 'string' && id) out.add(id);
    }
  }
  return out;
}

// Rows of an older build carry no stable submission id; only their text can
// tell them delivered: substring (not equality) because steering delivery may
// wrap the raw text.
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
  const turnSettlements = new Map();

  function settleSteeredSubmissions(epoch, detail) {
    const entries = turnSettlements.get(epoch);
    turnSettlements.delete(epoch);
    for (const entry of entries || []) {
      try {
        entry.onSettled(detail);
      } catch {}
    }
  }

  const leadSessionId = () => runtime.id;

  function shouldMirrorSteeringEntry(entry) {
    return isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry);
  }

  function releaseSteeringQueueEntries(entries) {
    const mirrored = (Array.isArray(entries) ? entries : []).filter(
      (entry) => shouldMirrorSteeringEntry(entry) && entry.steeringPersistId
    );
    if (mirrored.length > 0) return dropTuiSteeringPersist(leadSessionId(), mirrored);
  }

  function commitSteeringQueueEntries(entries) {
    callCommitCallbacks(entries);
    releaseSteeringQueueEntries(entries);
  }

  function canDeliverSteeringEntry(entry) {
    return !isGoalQueuedEntry(entry) || bag.shouldRunGoalContinuation?.(entry) === true;
  }

  // Pre-send steering is an admission route: a closing/closed session injects
  // nothing into a model request.
  const admissionOpen = () => !bag.flags?.admission || bag.flags.admission === 'open';

  function hasPendingSteering() {
    if (!admissionOpen()) return false;
    return pending.some(
      (entry) =>
        isSteerableEntry(entry) &&
        queuePriorityValue(entry.priority) <= queuePriorityValue('next') &&
        canDeliverSteeringEntry(entry) &&
        steeringMessageFromEntry(entry) !== null
    );
  }

  // Queued input the user typed (editable prompts), not runtime notices.
  function hasPendingUserInput() {
    if (!admissionOpen()) return false;
    return pending.some((entry) => isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry));
  }

  // A notification the next boundary will deliver: a task notification (one
  // the agent already received through task wait/read is not deliverable) or
  // the Goal closeout. `later` entries (scheduled and channel injects) wait
  // for the turn to end, so they are not deliverable mid-turn.
  function isDeliverableNotification(entry) {
    const mode = entry?.mode;
    return (
      admissionOpen() &&
      (mode === 'task-notification' || mode === 'goal-closeout') &&
      queuePriorityValue(entry.priority) <= queuePriorityValue('next') &&
      canDeliverSteeringEntry(entry) &&
      steeringMessageFromEntry(entry) !== null
    );
  }

  function hasPendingNotification() {
    return pending.some(isDeliverableNotification);
  }

  // What one queued entry should wake a passive wait or shell hold for: typed
  // input, a deliverable notification, or nothing (slash commands and
  // informational meta prompts run or ride along without ending a wait).
  function taskWaitWakeForEntry(entry) {
    if (!admissionOpen()) return false;
    if (isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry)) return 'user-message';
    return isDeliverableNotification(entry) ? 'notification' : false;
  }

  // What a passive wait or shell hold should wake for right now: user input
  // first, else a deliverable notification.
  function pendingTaskWaitWake() {
    if (hasPendingUserInput()) return 'user-message';
    return hasPendingNotification() ? 'notification' : false;
  }

  // `later` notifications (scheduled tasks) are skipped unless the runtime
  // explicitly asks for a later flush.
  function drainPendingSteering(_sessionIdOrOptions = null, maybeOptions = null) {
    let options = {};
    if (maybeOptions && typeof maybeOptions === 'object') options = maybeOptions;
    else if (_sessionIdOrOptions && typeof _sessionIdOrOptions === 'object') options = _sessionIdOrOptions;
    const maxPriority = options.maxPriority || 'next';
    const out = [];
    if (!admissionOpen()) return out;
    for (;;) {
      const batch = queue.dequeueQueueBatch(maxPriority, { predicate: isSteerableEntry });
      if (batch.length === 0) break;
      const accepted = batch.filter(canDeliverSteeringEntry);
      for (const entry of accepted) {
        const message = steeringMessageFromEntry(entry);
        if (message) {
          out.push(message);
          if (typeof entry.onSettled === 'function') {
            const epoch = options.turnEpoch;
            const entries = turnSettlements.get(epoch) || new Set();
            entries.add(entry);
            turnSettlements.set(epoch, entries);
          }
        }
      }
      commitSteeringQueueEntries(accepted);
    }
    return out;
  }

  async function restoreLeadSteeringFromDisk() {
    // A closed/closing conversation never gets queue work restored into it.
    if (!admissionOpen()) return;
    const rows = await readTuiSteeringPersist(leadSessionId());
    if (!rows.length) return;
    const livePersistIds = new Set(pending.map((entry) => entry?.steeringPersistId).filter(Boolean));
    // Crash-consumed dedup: a row whose submission already landed in the
    // session transcript was consumed before the restart — only its disk drop
    // was lost (drop is an async fire-and-forget write). Re-queuing it
    // silently re-injects a stale prompt into the next turn (user report:
    // surprise self-injection after a process restart). Identity, never text:
    // the same words can be a new submission.
    const delivered = deliveredSubmissionIds(runtime.session);
    let legacyTexts = null;
    const alreadyDelivered = (row, text) => {
      if (row.submissionId && !PROCESS_LOCAL_ITEM_ID.test(row.submissionId)) return delivered.has(row.submissionId);
      legacyTexts ??= recentUserTexts(runtime.session, RESTORE_DEDUP_WINDOW);
      return legacyTexts.some((body) => body.includes(text));
    };
    const restored = [];
    const consumed = [];
    for (const row of rows) {
      const text = String(row?.text || '').trim();
      if (!text) continue;
      // Live enqueue already holds this row (id assigned before the async
      // disk write). Replaying it is the classic double-booked queue.
      if (row.steeringPersistId && livePersistIds.has(row.steeringPersistId)) continue;
      if (alreadyDelivered(row, text)) {
        consumed.push(row);
        continue;
      }
      // The row keeps its executable content and attachment links; a row
      // of an older build has only its text.
      const { content, text: displayText, submissionId, submittedAt, ...options } = row;
      const entry = queue.makeQueueEntry(content ?? displayText, {
        ...options,
        id: submissionId || undefined,
        submittedAt: submittedAt || undefined,
        displayText,
      });
      pending.push(entry);
      if (submissionId) submissions.remember(submissionId);
      livePersistIds.add(entry.steeringPersistId);
      if (isQueuedEntryVisible(entry)) restored.push(entry);
    }
    if (restored.length > 0) set({ queued: [...getState().queued, ...restored] });
    // Reading keeps rows durable; a delivered row's lost drop is completed here.
    if (consumed.length > 0) await dropTuiSteeringPersist(leadSessionId(), consumed);
    // The conversation closed while the rows were being read: settle them
    // explicitly (rejected + durable mirror released), never leave them parked.
    if (bag.flags?.admission === 'terminal') bag.settleClosedQueue?.();
    if (consumed.length > 0) {
      try {
        process.stderr.write(`[tui] skipped ${consumed.length} already-delivered steering row(s) on restore\n`);
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
    releaseSteeringQueueEntries,
    commitSteeringQueueEntries,
    settleSteeredSubmissions,
    hasPendingSteering,
    hasPendingUserInput,
    isDeliverableNotification,
    hasPendingNotification,
    taskWaitWakeForEntry,
    pendingTaskWaitWake,
    drainPendingSteering,
    restoreLeadSteeringFromDisk,
  };
}
