import type { DesktopAgentPoolRow } from '../shared/contract';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import { liveAgentRows } from './agent-activity-model';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { timeMs } from './transcript-primitives';

export type JobKind = 'shell' | 'agent';
export type JobRow = {
  key: string;
  kind: JobKind;
  /** Agent role (or the shell command). */
  label: string;
  /** Agent tag; '' for shell jobs and untagged agents. */
  sub: string;
  startedAt: number;
  /** An agent that is queued or waiting rather than working. */
  idle: boolean;
  /** Not started yet; an idle row that is not queued is a running agent waiting. */
  queued?: boolean;
  /** Blocked on the user's approval: neither working nor idle. */
  needsUser?: boolean;
  /** The agent's own session: '' when it has none to open. */
  sessionId?: string;
  /** The agent as the sidebar's pool row, so the side dock paints the very
   *  same row component. */
  pool?: DesktopAgentPoolRow;
  /** The lifecycle state the row shows (queued, waiting, running…). */
  state?: DesktopAgentActivityState;
  /** A shell job that already exited and stays listed until dismissed. */
  finished?: boolean;
  /** Finished shell: exit code, null when it ended without one. */
  exitCode?: number | null;
  /** Finished shell: terminal status (completed, failed, cancelled…). */
  status?: string;
  /** Finished shell: epoch ms it ended; 0 when unknown. */
  finishedAt?: number;
  /** Shell job id (what stopping addresses). */
  taskId?: string;
  /** Shell working directory; '' when unknown. */
  cwd?: string;
};

/** Where a Stop request stands; absent before the user pressed Stop. */
export type ShellStopState = 'stopping' | 'failed' | undefined;
export type ShellRowAction = 'stop' | 'stopping' | 'retry' | 'dismiss';

/** The one button a shell row offers: a finished row can only be dismissed;
 *  a running one is stopped, shows it is stopping, or offers a retry. */
export function shellRowAction(row: Pick<JobRow, 'finished'>, stop: ShellStopState): ShellRowAction {
  if (row.finished) return 'dismiss';
  if (stop === 'stopping') return 'stopping';
  return stop === 'failed' ? 'retry' : 'stop';
}

/** A finished shell's status in words: cancelled reads as stopped. */
export function shellFinishedLabel(row: Pick<JobRow, 'status' | 'exitCode'>): string {
  if (row.status === 'cancelled') return t('Island: Stopped');
  if (row.exitCode != null) return t('Island: Exited {{code}}', { code: row.exitCode });
  return t('Island: Finished');
}

/** Last path segment of a working directory ('' for none). */
export function cwdFolderName(cwd: string | undefined): string {
  const segments = String(cwd || '')
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/** Rows that need the user lead, then working ones, then queued/waiting. */
function jobRowRank(row: JobRow): number {
  if (row.needsUser) return 0;
  return row.idle ? 2 : 1;
}

/** Running shell jobs newest first, then finished shells (not in `dismissed`,
 *  newest finish first), then agents that need the user, work or wait (in
 *  that order). Idle and finished agents are not background work. */
export function backgroundJobRows(snapshot: Snapshot, dismissed: ReadonlySet<string> = new Set()): JobRow[] {
  const finishedShell = (snapshot.shellJobs?.finished ?? [])
    .map((job, index) => ({
      key: `shell:${String(job.taskId || job.task_id || index)}`,
      kind: 'shell' as const,
      label: String(job.command || '').trim(),
      sub: '',
      startedAt: timeMs(job.startedAt),
      idle: false,
      finished: true,
      exitCode: Number.isInteger(job.exitCode) ? (job.exitCode as number) : null,
      status: String(job.status || ''),
      finishedAt: timeMs(job.finishedAt),
      taskId: String(job.taskId || job.task_id || ''),
      cwd: String(job.cwd || ''),
    }))
    .filter((row) => !dismissed.has(row.key))
    .sort((a, b) => b.finishedAt - a.finishedAt);
  const shell = (snapshot.shellJobs?.jobs ?? [])
    .map((job, index) => ({
      key: `shell:${String(job.taskId || job.task_id || index)}`,
      kind: 'shell' as const,
      label: String(job.command || '').trim(),
      sub: '',
      startedAt: timeMs(job.startedAt),
      idle: false,
      taskId: String(job.taskId || job.task_id || ''),
      cwd: String(job.cwd || ''),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
  const agents = liveAgentRows(snapshot)
    .filter((agent) => agent.queued || ['running', 'needs-user', 'waiting', 'cancel-unconfirmed'].includes(agent.state))
    .map((agent) => ({
      key: `agent:${agent.key}`,
      kind: 'agent' as const,
      label: agent.role,
      sub: agent.tag && agent.tag !== agent.role ? agent.tag : '',
      startedAt: agent.turnStartedAt || agent.startedAt,
      idle: agent.queued || agent.state === 'waiting',
      queued: agent.queued,
      needsUser: agent.state === 'needs-user',
      sessionId: agent.sessionId,
      state: agent.queued ? ('queued' as const) : agent.state,
      pool: {
        tag: agent.tag,
        title: agent.title || null,
        sessionId: agent.sessionId,
        ownerSessionId: agent.ownerSessionId || null,
        agent: agent.roleId,
        provider: agent.provider || null,
        model: agent.model || null,
        effort: agent.effort || null,
        fast: agent.fast,
        ...(agent.modelParameters ? { modelParameters: agent.modelParameters } : {}),
        autoEffort: agent.autoEffort,
        status: agent.status,
        stage: '',
        startedAt: agent.startedAt || null,
        turnStartedAt: agent.turnStartedAt || null,
        createdAt: null,
        updatedAt: null,
        cwd: null,
        clientHostPid: null,
        taskId: null,
        usage: agent.usage,
        toolCalls: agent.toolCalls,
      } satisfies DesktopAgentPoolRow,
    }))
    .sort((a, b) => jobRowRank(a) - jobRowRank(b));
  return [...shell, ...finishedShell, ...agents];
}
