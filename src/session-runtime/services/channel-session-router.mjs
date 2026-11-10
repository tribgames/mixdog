import { channelNotificationModelContent } from '../../runtime/shared/channel-notification-routing.mjs';
import { PROMPT_ORIGIN_CHANNEL } from '../../runtime/agent/orchestrator/session/manager/pending-message-entry.mjs';

/** The one inbound channel notification method. Exported so every consumer
 *  (daemon router, session runtime) matches the same wire name. */
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

export function createChannelSessionRouter({ getSessionService, getSessionId, log = () => {} } = {}) {
  return function routeChannelNotification(method, params = {}) {
    if (method !== CHANNEL_NOTIFICATION_METHOD) return false;
    const content = channelNotificationModelContent(params);
    if (!content) return true;
    const sessionId = String(getSessionId?.() || '').trim();
    const service = getSessionService?.();
    if (!sessionId || typeof service?.submitSession !== 'function') {
      log(`channel session delivery unavailable session=${sessionId || 'none'}`);
      return true;
    }
    void Promise.resolve(
      service.submitSession({
        sessionId,
        prompt: content,
        // A channel notification (webhook event rules carry fenced external
        // values) is queued as a task notification, never as typed input, so
        // nothing inside it selects a skill. Its provenance (`origin`) says
        // it is real external activity, which the mode alone does not.
        options: { source: 'channel', mode: 'task-notification', origin: PROMPT_ORIGIN_CHANNEL },
      })
    ).catch((error) => {
      log(`channel session delivery failed session=${sessionId}: ${error?.message || error}`);
    });
    return true;
  };
}
