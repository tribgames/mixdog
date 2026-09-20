/**
 * src/session-runtime/lifecycle/session-catalog.mjs - resumable Lead session
 * catalog: durable visibility filter, lead-shape heuristics and preview rows.
 */
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import {
  isAgentOnlySession,
  isRootLeadSession,
} from '../../runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import { listSessionHeartbeatMtimes } from '../../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { sessionMessageText, isSessionPreviewNoise, cleanSessionPreview, clean } from '../session-text.mjs';

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
  if (!preview && Array.isArray(s.messages)) {
    const msgs = s.messages || [];
    const userPreviews = msgs
      .filter((m) => m && m.role === 'user')
      .map((m) => sessionMessageText(m.content))
      .filter((text) => !isSessionPreviewNoise(text))
      .map((text) => cleanSessionPreview(text))
      .filter(Boolean);
    preview = userPreviews[0] || '';
    messageCount = msgs.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).length;
  }
  return { preview, messageCount };
}

export function leadSessionRow(s, heartbeatMtimes) {
  // Durable visibility is the catalog boundary. Apply it before the legacy
  // lead-shape heuristics so an explicitly agent-only child cannot leak just
  // because its owner field looks ordinary.
  if (isAgentOnlySession(s)) return null;
  const owner = clean(s.owner || 'user').toLowerCase();
  // A root Lead can carry Agent ownership plus a self-link after recovery;
  // it remains an ordinary resumable session, not a child dispatch.
  if (!isRootLeadSession(s) && owner && !VISIBLE_OWNERS.includes(owner)) return null;
  const sourceType = clean(s.sourceType || '').toLowerCase();
  if (!isLeadShaped(s, owner, sourceType)) return null;
  const { preview, messageCount } = previewOf(s);
  if (!preview && messageCount === 0) return null;
  return {
    id: s.id,
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
    // Working indicator: the .hb sidecar ALONE is the liveness signal. Its
    // deletion at turn end IS the completion signal, so the persisted
    // lastHeartbeatAt JSON field (refreshed by the final save) must not be
    // folded in — it pinned desktop spinners on for the full 2-minute TTL
    // after a turn had already finished.
    heartbeatAt: Number(heartbeatMtimes.get(s.id)) || 0,
    desktopSession: s.desktopSession || null,
    // Automation origin: lets the desktop group schedule/webhook runner
    // sessions under the sidebar Automations section instead of Recent.
    sourceType: sourceType || null,
    sourceName: clean(s.sourceName || '') || null,
  };
}

export function listLeadSessions(mgr, options = {}) {
  const heartbeatMtimes = listSessionHeartbeatMtimes();
  return mgr
    .listSessions({ refreshFromStorage: options?.refreshFromStorage === true })
    .map((s) => leadSessionRow(s, heartbeatMtimes))
    .filter(Boolean);
}
