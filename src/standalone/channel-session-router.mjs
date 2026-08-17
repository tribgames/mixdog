import { channelNotificationModelContent } from '../runtime/shared/channel-notification-routing.mjs';

const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

export function createChannelSessionRouter({
  getSessionService,
  getSessionId,
  log = () => {},
} = {}) {
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
    void Promise.resolve(service.submitSession({
      sessionId,
      prompt: content,
      options: { source: 'channel' },
    })).catch((error) => {
      log(`channel session delivery failed session=${sessionId}: ${error?.message || error}`);
    });
    return true;
  };
}
