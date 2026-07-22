import type {
  DesktopSessionClassification,
  DesktopSessionSummary,
  EngineSnapshot,
} from '../shared/contract';
import { generatedSessionTitle, normalizeSessionTitle } from '../shared/session-title.mjs';

export const SESSION_WORKING_HEARTBEAT_MS = 2 * 60 * 1000;

function normalizedPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isDesktopTaskWorkspace(value: string): boolean {
  return normalizedPath(value).endsWith('/workspace/unclassified');
}

export function desktopSnapshot(
  snapshot: EngineSnapshot,
  currentProject: string | null,
  recentProjects: readonly string[],
): EngineSnapshot {
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
  currentId: string,
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
    const storedTitle = generatedSessionTitle(titles[id] || '', '');
    const heartbeatAt = Number(row.heartbeatAt) || 0;
    const working = heartbeatAt > 0 && now - heartbeatAt <= SESSION_WORKING_HEARTBEAT_MS;
    // A session with no conversation preview, no manual name, and no stored
    // title is an abandoned blank ("Untitled") — opened once and never used.
    // Hide it from the sidebar instead of stacking empty rows; the active
    // session stays visible because a fresh task legitimately starts blank.
    if (!preview && !manualTitle && !storedTitle && id !== currentId) return [];
    return [{
      id,
      preview,
      title: manualTitle || storedTitle || generatedSessionTitle(preview),
      updatedAt: Number(row.updatedAt) || 0,
      messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
      cwd,
      classification,
      projectPath: classification === 'project' ? projectPath : null,
      currentSession: String(row.id || '') === currentId,
      ...(working ? { working: true } : {}),
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
