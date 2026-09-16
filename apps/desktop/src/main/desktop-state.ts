import type { DesktopSessionClassification, DesktopSessionSummary } from '../shared/contract';
import { compactedSessionTitle, generatedSessionTitle, normalizeSessionTitle } from '../shared/session-title.mjs';

export const SESSION_WORKING_HEARTBEAT_MS = 2 * 60 * 1000;

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
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_VISIBLE_SESSION_IDS = 256;

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
      const classification: DesktopSessionClassification =
        meta?.classification === 'project'
          ? 'project'
          : meta?.classification === 'task'
            ? 'task'
            : cwd && !isDesktopTaskWorkspace(cwd)
              ? 'project'
              : 'task';
      const storedProjectPath = typeof meta?.projectPath === 'string' ? meta.projectPath.trim() : '';
      const projectPath = classification === 'project' ? cwd || storedProjectPath : '';
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
      const sourceDelivery = ['app', 'channel', 'both'].includes(String(row.sourceDelivery || '').trim())
        ? (String(row.sourceDelivery).trim() as 'app' | 'channel' | 'both')
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
      return [
        {
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
          ...(automationType
            ? {
                sourceType: automationType,
                ...(sourceName ? { sourceName } : {}),
                ...(sourceDelivery ? { sourceDelivery } : {}),
              }
            : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        },
      ];
    })
    .filter((row) => isSessionId(row.id));
}
