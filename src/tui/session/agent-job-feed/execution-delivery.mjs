import { executionCardKey } from '../notification-plan.mjs';
import { notifyTrace } from '../../../runtime/shared/notify-trace.mjs';
import {
  isDeliveredCompletion,
  recordDeliveredCompletion,
} from '../../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { markCompletionEntry } from '../../../runtime/agent/orchestrator/session/manager/pending-message-entry.mjs';
import { executionResumeKey } from './pending-resume.mjs';
import { parseTaskNotification, taskNotificationHasBody } from '../../../runtime/shared/task-notification-envelope.mjs';

const FAILURE_STATUS = /^(failed|error|timeout|killed|cancelled|canceled|denied)$/;
const SUCCESS_STATUS = /^(completed|complete|done|success|succeeded|ok)$/;

// EXPLICIT ack to the emitting runtime: the model-visible completion body is
// pending delivery on the TUI path (enqueued here, already queued, or already
// delivered), so notifyFnForSession must NOT also mirror it into the pending
// queue. A bare truthy handler return is display/status handling only — this
// flag is the sole model-visible-delivery signal.
function ackModelVisible(event) {
  if (event && typeof event === 'object') event.modelVisibleDelivered = true;
}

// The `execution-ui` delivery: one transcript card per execution card key,
// then the model-visible completion body enqueued once per execution.
export function createExecutionDelivery({ dedup, pendingResume, enqueue, nextId, pushResponse, statusRefresh }) {
  function pushCard({ event, text, parsed, delivery, executionId, status, terminal }) {
    const cardKey = executionCardKey(event, text, parsed);
    const firstDelivery = !cardKey || !dedup.hasNotificationKey(cardKey);
    const hasBody = taskNotificationHasBody(text);
    const isFailure = FAILURE_STATUS.test(status);
    const successfulPreview = !parseTaskNotification(text) && !hasBody && !isFailure && SUCCESS_STATUS.test(status);
    const bodyAlreadyDisplayed = dedup.responseState(executionId) === 'body';
    if (cardKey && terminal && dedup.hasNotificationKey(cardKey)) {
      dedup.rememberNotificationKey(cardKey, true, executionId);
    }
    if (terminal) dedup.promote(executionId);
    const willPush = Boolean(firstDelivery && !successfulPreview && !bodyAlreadyDisplayed);
    notifyTrace('feed:execution-ui', {
      exec: executionId,
      status,
      cardKey,
      firstDelivery,
      hasBody,
      successfulPreview,
      bodyAlreadyDisplayed,
      willPush,
      textLen: text.length,
    });
    if (!willPush) return;
    if (cardKey) dedup.rememberNotificationKey(cardKey, terminal, executionId);
    if (executionId) dedup.rememberResponseState(executionId, hasBody ? 'body' : 'preview', terminal);
    // Preserve the canonical execution surface through card construction;
    // text parsing remains a fallback for restored/legacy envelopes.
    pushResponse(delivery.displayText, nextId(), 'injected', {
      responseKey: executionId,
      ...(delivery.executionMeta || {}),
    });
  }

  // Consolidated completion dedup keyed off execution_id (+ text hash): a
  // completion already delivered — by an earlier TUI enqueue or by
  // runtime-core's ack — is acked but NOT enqueued again, otherwise a
  // re-arriving completion while IDLE would let post-turn drain() spawn a
  // fresh turn.
  function enqueueCompletion({ event, text, delivery, executionId, notificationKey }) {
    const resumeBody = String(delivery.modelContent || '').trim();
    if (!resumeBody) return;
    const completionKey = executionResumeKey(resumeBody, executionId);
    if (pendingResume.isDiscarded(completionKey) || isDeliveredCompletion({ executionId, text: resumeBody })) {
      ackModelVisible(event);
      return;
    }
    // Live execution completions are queued as task notifications so the
    // active loop can attach them after the next tool batch. The immediate
    // response card was already pushed above, so the queued twin stays
    // model-visible but suppresses its drain-time transcript card.
    const { execution } = markCompletionEntry(resumeBody, { executionId, meta: event?.meta });
    const enqueued = enqueue(resumeBody, {
      mode: 'task-notification',
      ...(execution ? { execution } : {}),
      priority: 'next',
      key: notificationKey || undefined,
      abortDiscardOnAbort: true,
      resumeCompletionKeys: completionKey ? [completionKey] : [],
      displayText: delivery.displayText || text,
      suppressDisplay: true,
    });
    // Mark delivered on a CONFIRMED enqueue only: enqueue() returns false when
    // an identical-key twin is already queued, in which case the completion is
    // already pending delivery and must not be double-recorded.
    if (enqueued) recordDeliveredCompletion({ executionId, text: resumeBody });
    ackModelVisible(event);
  }

  function deliver(context) {
    pushCard(context);
    statusRefresh.refresh(context.parsed);
    enqueueCompletion(context);
    return true;
  }

  return { deliver };
}
