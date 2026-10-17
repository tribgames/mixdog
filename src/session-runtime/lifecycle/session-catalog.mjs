/**
 * src/session-runtime/lifecycle/session-catalog.mjs - resumable Lead session
 * catalog: durable visibility filter, lead-shape heuristics and preview rows.
 */
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import {
  isAgentOnlySession,
  isRootLeadSession,
} from '../../runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import {
  sessionMessageText,
  isSessionPreviewNoise,
  cleanSessionPreview,
  clean,
} from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

import { isRealTurnMessage } from '../../runtime/agent/orchestrator/session/compact/user-message-kind.mjs';
import { realTurnCount as realTurnCountOf } from '../../runtime/agent/orchestrator/session/store-summary-fields.mjs';

const VISIBLE_OWNERS = ['cli', 'user', 'mixdog'];

function isLeadShaped(s, owner, sourceType) {
  const sourceName = clean(s.sourceName || '').toLowerCase();
  const agent = clean(s.agent || '').toLowerCase();
  return (
    agent === 'lead' ||
    sourceType === 'lead' ||
    sourceType === 'cli' ||
    // Schedule runs are their own visible type: they surface in desktop
    // Recent / TUI resume next to lead sessions instead of hiding like
    // agent dispatches.
    sourceType === 'schedule' ||
    // Webhook fires run as visible sessions too (user decision: no Lead
    // injection — the session row IS the notification).
    sourceType === 'webhook' ||
    (!sourceType && !sourceName && !isAgentOwner(owner))
  );
}

function previewOf(s) {
  const rawPreview = s.preview || '';
  let preview = isSessionPreviewNoise(rawPreview) ? '' : cleanSessionPreview(rawPreview);
  let messageCount = Math.max(0, Number(s.messageCount) || 0);
  let realTurnCount = realTurnCountOf(s);
  if (!preview && Array.isArray(s.messages)) {
    realTurnCount = s.messages.filter(isRealTurnMessage).length;
    const msgs = s.messages;
    const userPreviews = msgs
      .filter((m) => m && m.role === 'user')
      .map((m) => sessionMessageText(m.content))
      .filter((text) => !isSessionPreviewNoise(text))
      .map((text) => cleanSessionPreview(text))
      .filter(Boolean);
    preview = userPreviews[0] || '';
    messageCount = msgs.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).length;
  }
  return { preview, messageCount, realTurnCount };
}

/** `working`: this session's turn is running in the daemon right now. */
export function leadSessionRow(s, working = false) {
  const agentSession = isAgentOnlySession(s) || isAgentOwner(s);
  const owner = clean(s.owner || 'user').toLowerCase();
  // A root Lead can carry Agent ownership plus a self-link after recovery;
  // it remains an ordinary resumable session, not a child dispatch.
  if (!agentSession && !isRootLeadSession(s) && owner && !VISIBLE_OWNERS.includes(owner)) return null;
  const sourceType = clean(s.sourceType || '').toLowerCase();
  // One-shot `mixdog exec` runs are never resumable conversations.
  if (sourceType === 'exec') return null;
  if (!agentSession && !isLeadShaped(s, owner, sourceType)) return null;
  const { preview, messageCount, realTurnCount } = previewOf(s);
  if (!preview && messageCount === 0) return null;
  return {
    id: s.id,
    agent: s.agent || null,
    owner,
    visibility: isAgentOnlySession(s) ? 'agent-only' : 'ordinary',
    ownerSessionId: s.ownerSessionId || s.parentSessionId || null,
    // Durable provenance the desktop uses to tell a real conversation from
    // resume scratch or synthetic-only rows when no title source survives.
    ...(realTurnCount === null ? {} : { realTurnCount }),
    ...(s.detachedReason ? { detachedReason: s.detachedReason } : {}),
    updatedAt: s.updatedAt,
    // Conversation-activity timestamp for Recent ordering. Without this the
    // desktop falls back to updatedAt, which detach/resume bookkeeping
    // bumps — clicking a session reshuffled the sidebar (the row just left
    // jumped to the top).
    lastUsedAt: Number(s.lastUsedAt) || 0,
    cwd: s.cwd || '',
    model: s.model,
    provider: s.provider,
    messageCount,
    title: cleanSessionPreview(s.title || '', 100),
    preview,
    // Working indicator: the in-memory runtime state ALONE is the liveness
    // signal. The persisted lastHeartbeatAt JSON field (refreshed by the final
    // save) must not be folded in — it outlives the turn it describes.
    ...(working ? { working: true } : {}),
    desktopSession: s.desktopSession || null,
    // Automation origin: lets the desktop group schedule/webhook runner
    // sessions under the sidebar Automations section instead of Recent.
    sourceType: sourceType || null,
    sourceName: clean(s.sourceName || '') || null,
    createdAt: Number(s.createdAt) || 0,
    inheritedFromSessionId: clean(s.inheritedFromSessionId || '') || null,
  };
}

export function listLeadSessions(mgr, options = {}) {
  return mgr
    .listSessions({ refreshFromStorage: options?.refreshFromStorage === true })
    .map((s) => leadSessionRow(s, mgr.isSessionTurnInFlight?.(s.id) === true))
    .filter(Boolean);
}
