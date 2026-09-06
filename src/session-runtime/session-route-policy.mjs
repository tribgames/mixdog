import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import { hasUserConversationMessage } from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

function hasRouteHistoryMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return hasUserConversationMessage(list) || list.some((message) => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(SUMMARY_PREFIX)
  ));
}

// A first turn owns its model before its working transcript is committed.
// Compacted conversations still own their route through the summary anchor.
export function sessionHasRouteHistory(session) {
  return hasRouteHistoryMessage(session?.messages)
    || hasRouteHistoryMessage(session?.liveTurnMessages);
}

export function sessionUsesRoute(session, route) {
  return !!session && session.provider === route?.provider && session.model === route?.model;
}

export function shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession = false) {
  return applyToCurrentSession !== true && !!session && !sessionHasRouteHistory(session);
}
