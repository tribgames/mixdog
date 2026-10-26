import type {
  DesktopSessionClassification,
  DesktopSessionSummary,
  DesktopSessionWorkspace,
  DesktopWorkspaceTransitionState,
} from '../shared/contract';
import { cleanIncomingTail } from '../shared/incoming-tail';
import { isTaskWorkspaceFolder } from '../shared/task-workspace';
import { compactedSessionTitle, generatedSessionTitle, normalizeSessionTitle } from '../shared/session-title.mjs';
import {
  agentHomeSessionId,
  agentIdOfHomeSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { normalizeRoutineProvenance } from '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs';

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

/** `agent:<id>[@from]` of a host-made task session (a Lead, never an agent-owned session). */
function taskAgentSource(row: Record<string, unknown>): string[] {
  const sourceType = String(row.sourceType || '')
    .trim()
    .toLowerCase();
  const sourceName = String(row.sourceName || '').trim();
  const taskRow = sourceType === 'lead' && row.owner !== 'agent' && row.visibility !== 'agent-only';
  return taskRow && sourceName.startsWith('agent:') ? sourceName.slice(6).split('@') : [];
}

/** The session whose reading also reads each delegated row (`readWith`): a
 *  task session a bot made from its chat → that chat; an agent-owned session
 *  below a task session (child, grandchild…) → the session it works under. */
function readWithIds(rows: Array<Record<string, unknown>>): Map<string, string> {
  const upper = new Map<string, string>();
  const delegated = new Set<string>();
  for (const row of rows) {
    const [agent, from] = taskAgentSource(row);
    if (!agent) continue;
    const id = String(row.id || '');
    delegated.add(id);
    const home = from === 'home' ? agentHomeSessionId(agent) : '';
    if (home) upper.set(id, home);
  }
  for (let grew = delegated.size > 0; grew; ) {
    grew = false;
    for (const row of rows) {
      const id = String(row.id || '');
      if (delegated.has(id) || !(row.owner === 'agent' || row.visibility === 'agent-only')) continue;
      const link = [row.parentSessionId, row.ownerSessionId]
        .map((value) => String(value || '').trim())
        .find((value) => value && delegated.has(value));
      if (link) {
        delegated.add(id);
        upper.set(id, link);
        grew = true;
      }
    }
  }
  return upper;
}

export function desktopSessionSummaries(
  rows: Array<Record<string, unknown>>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  /** The host's exact task workspace path: what a legacy row (no stored
   *  classification) running there is classified a task by. */
  taskWorkspace = ''
): DesktopSessionSummary[] {
  const readWith = readWithIds(rows);
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
      else classification = cwd && !isTaskWorkspaceFolder(cwd, taskWorkspace) ? 'project' : 'task';
      const storedProjectPath = typeof meta?.projectPath === 'string' ? meta.projectPath.trim() : '';
      // A worktree-bound session executes in a managed folder (`cwd`) but stays
      // grouped under its registered Project: the workspace record, then the
      // stored classification, outrank the execution root.
      const workspace = sessionWorkspace(row.workspace);
      const projectPath = classification === 'project' ? workspace?.projectPath || cwd || storedProjectPath : '';
      if (classification === 'project' && (!projectPath || projectPath.includes('\0'))) return [];
      const preview = String(row.preview || '').trim();
      const lastMessagePreview = String(row.lastMessagePreview || '').trim();
      const lastMessageRoutine = normalizeRoutineProvenance(row.lastMessageRoutine);
      const incomingTail = cleanIncomingTail(row.incomingTail);
      const id = String(row.id || '');
      const manualTitle = normalizeSessionTitle(names[id] || '', '');
      const sharedTitle = generatedSessionTitle(row.title || '', '');
      const legacyDesktopTitle = generatedSessionTitle(titles[id] || '', '');
      const previewTitle = compactedSessionTitle(preview, '') || generatedSessionTitle(preview, '');
      // Turn activity the daemon overlays from its in-memory runtime state.
      const ownWorking = row.working === true;
      const agentWorking = row.agentWorking === true;
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
      const agentHome = agentIdOfHomeSession(String(row.id || ''));
      // A coding task session an agent created (session create): `agent:<id>`,
      // then where it was created (`@home`, `@room`, `@run`) when recorded.
      // Only a host-made task session (a Lead, never an agent-owned session) carries it.
      const [taskAgent = '', taskFrom = ''] = taskAgentSource(row);
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
      // An agent home thread is a contact's chat, titled by its agent: a home
      // that holds only routine results (no real turn, no first-prompt
      // preview) still belongs in the catalog the Agents pane reads.
      if (
        !previewTitle &&
        !manualTitle &&
        !sharedTitle &&
        !legacyDesktopTitle &&
        !hadConversation &&
        !(agentHome && messageCount > 0)
      )
        return [];
      return [
        {
          id,
          ...(row.visibility === 'agent-only' || (row.owner === 'agent' && row.agent !== 'lead')
            ? { agentSession: true }
            : {}),
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
          ...(row.awaitingApproval === true ? { awaitingApproval: true } : {}),
          ...(row.awaitingApproval === true && row.awaitingQuestion === true ? { awaitingQuestion: true } : {}),
          ...(automationType ? { sourceType: automationType } : {}),
          ...(automationType && sourceName ? { sourceName } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(createdAt > 0 ? { createdAt } : {}),
          ...(inheritedFrom ? { inheritedFromSessionId: inheritedFrom } : {}),
          ...(workspace ? { workspace } : {}),
          ...(agentHome ? { agentHome } : {}),
          ...(taskAgent ? { taskAgent } : {}),
          ...(readWith.has(id) ? { readWith: readWith.get(id) } : {}),
          ...(taskAgent && (taskFrom === 'home' || taskFrom === 'room' || taskFrom === 'run') ? { taskFrom } : {}),
          ...(row.sessionMode === 'agent' ? { sessionMode: 'agent' as const } : {}),
          ...(lastMessagePreview ? { lastMessagePreview } : {}),
          ...(lastMessagePreview && lastMessageRoutine ? { lastMessageRoutine } : {}),
          ...(incomingTail ? { incomingTail } : {}),
        },
      ];
    })
    .filter((row) => isSessionId(row.id));
}
