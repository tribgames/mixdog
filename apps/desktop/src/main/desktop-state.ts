import type {
  DesktopSessionClassification,
  DesktopSessionSummary,
  DesktopSessionWorkspace,
  DesktopWorkspaceTransitionState,
} from '../shared/contract';
import { compactedSessionTitle, generatedSessionTitle, normalizeSessionTitle } from '../shared/session-title.mjs';

const SESSION_WORKING_HEARTBEAT_MS = 2 * 60 * 1000;
// A user prompt plus an assistant reply: the smallest persisted conversation.
const MIN_CONVERSATION_MESSAGE_COUNT = 2;
const WORKSPACE_TRANSITION_STATES = new Set(['idle', 'provisioning', 'switching', 'removing', 'recovery']);

const workspaceText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && !value.includes('\0') ? value.trim() : null;

/** The catalog row's workspace record (store-summary-fields workspaceSummary),
 *  or null when absent or missing either path. */
function sessionWorkspace(value: unknown): DesktopSessionWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const projectPath = workspaceText(record.projectPath);
  const cwd = workspaceText(record.cwd);
  if (!projectPath || !cwd) return null;
  const transition =
    record.transition && typeof record.transition === 'object' ? (record.transition as Record<string, unknown>) : {};
  const state = WORKSPACE_TRANSITION_STATES.has(String(transition.state))
    ? (transition.state as DesktopWorkspaceTransitionState)
    : 'idle';
  const txId = state === 'idle' ? null : workspaceText(transition.txId);
  return {
    projectPath,
    repoCommonDir: workspaceText(record.repoCommonDir),
    cwd,
    worktreeId: workspaceText(record.worktreeId),
    branch: workspaceText(record.branch),
    baseCommit: workspaceText(record.baseCommit),
    mergeTarget: workspaceText(record.mergeTarget),
    revision: Number.isSafeInteger(record.revision) && Number(record.revision) >= 0 ? Number(record.revision) : 0,
    transition: txId ? { state, txId } : { state: 'idle', txId: null },
  };
}

function normalizedPath(value: string): string {
  return value
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function isDesktopTaskWorkspace(value: string): boolean {
  return normalizedPath(value).endsWith('/workspace/unclassified');
}

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_VISIBLE_SESSION_IDS = 256;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('session id must be a string.');
  const id = value.trim();
  if (!id || id.length > MAX_SESSION_ID_LENGTH || !isSessionId(id)) {
    throw new TypeError('session id is invalid.');
  }
  return id;
}

/** Empty/omitted targets the control session; any other value must be a real id. */
export function optionalSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredSessionId(value);
}

export function requiredSessionIds(value: unknown, limit = MAX_VISIBLE_SESSION_IDS): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new TypeError('sessionIds must be a bounded array.');
  }
  return [...new Set(value.map((sessionId) => requiredSessionId(sessionId)))];
}

/** Service/client/relay delivery filters drop malformed entries so one bad id
 *  cannot fail the whole visible-set update. IPC still uses requiredSessionIds. */
export function filterSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = String(item || '');
    if (!isSessionId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function requiredVisibleSessionVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('visible session version must be a positive safe integer.');
  }
  return Number(value);
}

export function desktopSessionSummaries(
  rows: Array<Record<string, unknown>>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  now = Date.now()
): DesktopSessionSummary[] {
  return rows
    .flatMap((row): DesktopSessionSummary[] => {
      const rawMeta = row.desktopSession;
      if (rawMeta != null && (typeof rawMeta !== 'object' || Array.isArray(rawMeta))) return [];
      const meta = rawMeta && typeof rawMeta === 'object' ? (row.desktopSession as Record<string, unknown>) : null;
      if (meta && meta.classification !== 'project' && meta.classification !== 'task') return [];
      const cwd = String(row.cwd || '').trim();
      if (cwd.includes('\0')) return [];
      // Runtime listSessions already removes worker/agent sessions. Preserve
      // explicit desktop grouping, while admitting legacy CLI/TUI lead sessions
      // so the desktop sidebar is a complete view of Mixdog conversation history.
      const storedClassification = meta?.classification;
      let classification: DesktopSessionClassification;
      if (storedClassification === 'project' || storedClassification === 'task') classification = storedClassification;
      else classification = cwd && !isDesktopTaskWorkspace(cwd) ? 'project' : 'task';
      const storedProjectPath = typeof meta?.projectPath === 'string' ? meta.projectPath.trim() : '';
      // A worktree-bound session executes in a managed folder (`cwd`) but stays
      // grouped under its registered Project: the workspace record, then the
      // stored classification, outrank the execution root.
      const workspace = sessionWorkspace(row.workspace);
      const projectPath = classification === 'project' ? workspace?.projectPath || cwd || storedProjectPath : '';
      if (classification === 'project' && (!projectPath || projectPath.includes('\0'))) return [];
      const preview = String(row.preview || '').trim();
      const id = String(row.id || '');
      const manualTitle = normalizeSessionTitle(names[id] || '', '');
      const sharedTitle = generatedSessionTitle(row.title || '', '');
      const legacyDesktopTitle = generatedSessionTitle(titles[id] || '', '');
      const previewTitle = compactedSessionTitle(preview, '') || generatedSessionTitle(preview, '');
      const heartbeatAt = Number(row.heartbeatAt) || 0;
      const agentHeartbeatAt = Number(row.agentHeartbeatAt) || 0;
      const ownWorking = heartbeatAt > 0 && now - heartbeatAt <= SESSION_WORKING_HEARTBEAT_MS;
      const agentWorking = agentHeartbeatAt > 0 && now - agentHeartbeatAt <= SESSION_WORKING_HEARTBEAT_MS;
      const working = ownWorking || agentWorking;
      const updatedAt = Number(row.updatedAt) || 0;
      const activityAt = Number(row.lastUsedAt) || updatedAt;
      // Automation origin survives into the summary so the sidebar can group
      // schedule/webhook runner sessions under Automations instead of Recent.
      const sourceType = String(row.sourceType || '')
        .trim()
        .toLowerCase();
      const sourceName = String(row.sourceName || '').trim();
      const automationType =
        sourceType === 'schedule' || sourceType === 'webhook' ? (sourceType as 'schedule' | 'webhook') : null;
      // The store index already carries each session's last route. Passing it
      // through lets pane chrome name the model on its first frame instead of
      // blanking until a lane snapshot arrives.
      const provider = String(row.provider || '').trim();
      const model = String(row.model || '').trim();
      const createdAt = Number(row.createdAt) || 0;
      const inheritedFrom = String(row.inheritedFromSessionId || '').trim();
      const messageCount = Math.max(0, Math.floor(Number(row.messageCount) || 0));
      // Empty and synthetic runtime previews both normalize to no usable title.
      // Keep compacted handoffs when their earliest real user prompt can be
      // recovered, but hide abandoned/interrupted/internal rows instead of
      // stacking "Untitled session" placeholders. A row that persisted at
      // least one full exchange (user + assistant) is a real conversation
      // whose title sources were lost to compaction: it keeps the default
      // title instead of vanishing. Abandoned/internal rows hold at most the
      // lone synthetic user message, so they stay hidden. The durable
      // `realTurnCount` (real human turns + compact summaries) rules out
      // synthetic-only rows, and resume-machinery scratch forks never count.
      // Rows indexed before that field existed (null/absent) keep the
      // message-count rule alone.
      const realTurnCount = typeof row.realTurnCount === 'number' ? row.realTurnCount : null;
      const hadConversation =
        messageCount >= MIN_CONVERSATION_MESSAGE_COUNT &&
        row.detachedReason !== 'cli-resume' &&
        (realTurnCount === null || realTurnCount >= 1);
      if (!previewTitle && !manualTitle && !sharedTitle && !legacyDesktopTitle && !hadConversation) return [];
      return [
        {
          id,
          preview,
          title: manualTitle || sharedTitle || legacyDesktopTitle || previewTitle || generatedSessionTitle(preview),
          updatedAt,
          activityAt,
          messageCount,
          cwd,
          classification,
          projectPath: classification === 'project' ? projectPath : null,
          ...(working ? { working: true } : {}),
          ...(ownWorking ? { leadWorking: true } : {}),
          ...(agentWorking ? { agentWorking: true } : {}),
          ...(automationType ? { sourceType: automationType } : {}),
          ...(automationType && sourceName ? { sourceName } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(createdAt > 0 ? { createdAt } : {}),
          ...(inheritedFrom ? { inheritedFromSessionId: inheritedFrom } : {}),
          ...(workspace ? { workspace } : {}),
        },
      ];
    })
    .filter((row) => isSessionId(row.id));
}
