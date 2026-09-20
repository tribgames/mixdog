import { parseAgentJob } from '../agent-envelope.mjs';
import { notificationQueueKey, resolveTuiRuntimeNotificationDelivery } from '../notification-plan.mjs';
import { isTerminalExecutionStatus } from './agent-status-refresh.mjs';

// Routes one runtime notification by its delivery plan: UI-only kinds patch
// the store or raise a notice, execution envelopes go through the execution
// delivery, everything else becomes a model-visible task notification.
export function createNotificationRouter({
  set,
  pushNotice,
  getDisposed,
  dedup,
  statusRefresh,
  executionDelivery,
  modelNotification,
}) {
  let uiOpenSeq = 0;
  const uiActions = {
    'setup-ui': (delivery) => set({ setupUiRequest: { id: delivery.id, at: Date.now() } }),
    'ui-open': (delivery) => {
      // Monotonic seq: the same command requested twice must fire twice, and
      // the consuming App effect keys on the object identity + seq.
      uiOpenSeq += 1;
      set({ uiOpenRequest: { command: delivery.command, seq: uiOpenSeq, at: Date.now() } });
    },
    notice: (delivery) =>
      pushNotice?.(delivery.displayText, delivery.tone || 'info', { transcript: delivery.transcript === true }),
  };

  return function routeNotification(event) {
    if (getDisposed()) return;
    const text = String(event?.content ?? event?.text ?? event ?? '').trim();
    if (!text) return;
    const parsed = parseAgentJob(text);
    const notificationKey = notificationQueueKey(event, text, parsed);
    const delivery = resolveTuiRuntimeNotificationDelivery(event, text);
    const executionId = String(event?.meta?.execution_id || parsed?.taskId || '').trim();
    const status = String(event?.meta?.status || parsed?.status || '').toLowerCase();
    const terminal = isTerminalExecutionStatus(status);
    if (terminal) dedup.promote(executionId);
    if (delivery.action === 'ignore') return;
    const uiAction = uiActions[delivery.action];
    if (uiAction) {
      uiAction(delivery);
      return true;
    }
    if (delivery.action === 'status-only') {
      statusRefresh.refresh(parsed);
      return true;
    }
    if (delivery.action === 'execution-ui') {
      return executionDelivery.deliver({
        event,
        text,
        parsed,
        delivery,
        executionId,
        status,
        terminal,
        notificationKey,
      });
    }
    statusRefresh.refresh(parsed);
    return modelNotification.enqueueNotification({ event, text, delivery, notificationKey });
  };
}
