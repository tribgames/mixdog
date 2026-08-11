import type {
  DesktopSessionClassification,
  DesktopSessionSummary,
  SessionSnapshot,
} from '../shared/contract';
import {
  compactedSessionTitle,
  generatedSessionTitle,
  normalizeSessionTitle,
} from '../shared/session-title.mjs';

export const SESSION_WORKING_HEARTBEAT_MS = 2 * 60 * 1000;

function normalizedPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isDesktopTaskWorkspace(value: string): boolean {
  return normalizedPath(value).endsWith('/workspace/unclassified');
}

export function desktopSnapshot(
  snapshot: SessionSnapshot,
  currentProject: string | null,
  recentProjects: readonly string[],
): SessionSnapshot {
  const state = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    ...state,
    items: Array.isArray(state.items) ? state.items : [],
    queued: Array.isArray(state.queued) ? state.queued : [],
    currentProject,
    recentProjects: [...recentProjects],
  };
}

export function desktopSessionSummaries(
  rows: Array<Record<string, unknown>>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  now = Date.now(),
): DesktopSessionSummary[] {
  return rows.flatMap((row): DesktopSessionSummary[] => {
    const rawMeta = row.desktopSession;
    if (rawMeta != null && (typeof rawMeta !== 'object' || Array.isArray(rawMeta))) return [];
    const meta = rawMeta && typeof rawMeta === 'object'
      ? row.desktopSession as Record<string, unknown>
      : null;
    if (meta && meta.classification !== 'project' && meta.classification !== 'task') return [];
    const cwd = String(row.cwd || '').trim();
    if (cwd.includes('\0')) return [];
    // Runtime listSessions already removes worker/agent sessions. Preserve
    // explicit desktop grouping, while admitting legacy CLI/TUI lead sessions
    // so the desktop sidebar is a complete view of Mixdog conversation history.
    const classification: DesktopSessionClassification = meta?.classification === 'project'
      ? 'project'
      : (meta?.classification === 'task' ? 'task' : (cwd && !isDesktopTaskWorkspace(cwd) ? 'project' : 'task'));
    const storedProjectPath = typeof meta?.projectPath === 'string' ? meta.projectPath.trim() : '';
    const projectPath = classification === 'project' ? storedProjectPath || cwd : '';
    if (classification === 'project' && (!projectPath || projectPath.includes('\0'))) return [];
    const preview = String(row.preview || '').trim();
    const id = String(row.id || '');
    const manualTitle = normalizeSessionTitle(names[id] || '', '');
    const sharedTitle = generatedSessionTitle(row.title || '', '');
    const legacyDesktopTitle = generatedSessionTitle(titles[id] || '', '');
    const previewTitle = compactedSessionTitle(preview, '')
      || generatedSessionTitle(preview, '');
    const heartbeatAt = Number(row.heartbeatAt) || 0;
    const agentHeartbeatAt = Number(row.agentHeartbeatAt) || 0;
    const ownWorking = heartbeatAt > 0 && now - heartbeatAt <= SESSION_WORKING_HEARTBEAT_MS;
    const agentWorking = agentHeartbeatAt > 0
      && now - agentHeartbeatAt <= SESSION_WORKING_HEARTBEAT_MS;
    const working = ownWorking || agentWorking;
    const updatedAt = Number(row.updatedAt) || 0;
    const activityAt = Number(row.lastUsedAt) || updatedAt;
    // Automation origin survives into the summary so the sidebar can group
    // schedule/webhook runner sessions under Automations instead of Recent.
    const sourceType = String(row.sourceType || '').trim().toLowerCase();
    const sourceName = String(row.sourceName || '').trim();
    const automationType = sourceType === 'schedule' || sourceType === 'webhook'
      ? sourceType as 'schedule' | 'webhook'
      : null;
    const sourceDelivery = ['app', 'channel', 'both'].includes(String(row.sourceDelivery || '').trim())
      ? String(row.sourceDelivery).trim() as 'app' | 'channel' | 'both'
      : null;
    // The store index already carries each session's last route. Passing it
    // through lets pane chrome name the model on its first frame instead of
    // blanking until a lane snapshot arrives.
    const provider = String(row.provider || '').trim();
    const model = String(row.model || '').trim();
    // Empty and synthetic runtime previews both normalize to no usable title.
    // Keep compacted handoffs when their earliest real user prompt can be
    // recovered, but hide abandoned/interrupted/internal rows instead of
    // stacking "Untitled session" placeholders.
    if (!previewTitle && !manualTitle && !sharedTitle && !legacyDesktopTitle) return [];
    return [{
      id,
      preview,
      title: manualTitle || sharedTitle || legacyDesktopTitle || previewTitle || generatedSessionTitle(preview),
      updatedAt,
      activityAt,
      messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
      cwd,
      classification,
      projectPath: classification === 'project' ? projectPath : null,
      ...(working ? { working: true } : {}),
      ...(ownWorking ? { leadWorking: true } : {}),
      ...(agentWorking ? { agentWorking: true } : {}),
      ...(automationType ? {
        sourceType: automationType,
        ...(sourceName ? { sourceName } : {}),
        ...(sourceDelivery ? { sourceDelivery } : {}),
      } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    }];
  }).filter((row) => /^[A-Za-z0-9_-]+$/.test(row.id));
}

export function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('session id must be a string.');
  const id = value.trim();
  if (!id || id.length > 256 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new TypeError('session id is invalid.');
  }
  return id;
}
