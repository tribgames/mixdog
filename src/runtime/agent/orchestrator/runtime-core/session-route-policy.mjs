import { SUMMARY_PREFIX } from '../session/compact.mjs';
import { hasUserConversationMessage } from '../session/manager/prompt-utils.mjs';

/** A real user exchange, or the summary anchor a compaction left behind. */
export function hasRouteHistoryMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return (
    hasUserConversationMessage(list) ||
    list.some(
      (message) =>
        message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
    )
  );
}

// A first turn owns its model before its working transcript is committed.
// Compacted conversations still own their route through the summary anchor.
export function sessionHasRouteHistory(session) {
  return hasRouteHistoryMessage(session?.messages) || hasRouteHistoryMessage(session?.liveTurnMessages);
}

// Whether a model change must leave the current conversation on its model:
// a model reply or a compaction summary ties it to its provider cache and
// replay state, and a first turn in flight owns its model. Prompts that were
// all refused before any reply leave nothing to protect.
export function sessionRouteCommitted(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return (
    hasRouteHistoryMessage(session?.liveTurnMessages) ||
    messages.some(
      (message) =>
        message?.role === 'assistant' ||
        (message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX))
    )
  );
}

export function sessionUsesRoute(session, route) {
  return !!session && session.provider === route?.provider && session.model === route?.model;
}

export function shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession = false) {
  return applyToCurrentSession !== true && !!session && !sessionHasRouteHistory(session);
}
