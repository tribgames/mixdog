/**
 * src/session-runtime/lifecycle/session-catalog.mjs - resumable Lead session
 * catalog: durable visibility filter, lead-shape heuristics and preview rows.
 */
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { normalizeRoutineProvenance } from '../../runtime/agent/orchestrator/session/routine-result.mjs';
import { sessionModeOf } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
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

import {
  incomingTailOf,
  wantsIncomingTail,
} from '../../runtime/agent/orchestrator/session/store-summary-last-message.mjs';
import { isRealTurnMessage } from '../../runtime/agent/orchestrator/session/compact/user-message-kind.mjs';
import {
  compactCount as compactCountOf,
  compactCountField,
  realTurnCount as realTurnCountOf,
} from '../../runtime/agent/orchestrator/session/store-summary-fields.mjs';

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
  let incomingTail = Array.isArray(s.incomingTail) ? s.incomingTail : null;
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
    if (wantsIncomingTail(s.id)) incomingTail = incomingTailOf(msgs);
  }
  return { preview, messageCount, realTurnCount, incomingTail };
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
  const { preview, messageCount, realTurnCount, incomingTail } = previewOf(s);
  // A titled one is not scratch: its prompt was rewound away (Esc-Esc message
  // selector), so it stays listed rather than vanishing with its open tab.
  if (!preview && messageCount === 0 && !cleanSessionPreview(s.title || '', 100)) return null;
  const lastMessageRoutine = normalizeRoutineProvenance(s.lastMessageRoutine);
  return {
    id: s.id,
    agent: s.agent || null,
    // 'agent' | 'coding' (agent-mode.mjs): the desktop renders agent-mode chats.
    sessionMode: sessionModeOf(s),
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
    // Where the messages that arrived (not the user's own, not tool calls)
    // sit among the counted ones: a bot row's unread pill counts those past
    // the read cursor. Absent when unknown; clients then show one.
    ...(incomingTail ? { incomingTail } : {}),
    // The numbering epoch of messageCount: each compaction restarts it. A
    // summary row carries it at the top; a stored session in its compaction
    // record. Unknown stays absent.
    ...compactCountField(compactCountOf(s) === null ? s.compaction : s),
    title: cleanSessionPreview(s.title || '', 100),
    preview,
    // The latest user or assistant line (an agent contact's row shows it).
    ...(s.lastMessagePreview ? { lastMessagePreview: String(s.lastMessagePreview) } : {}),
    // That line's routine provenance: clients label a routine result by it.
    ...(lastMessageRoutine ? { lastMessageRoutine } : {}),
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
