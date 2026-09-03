import type { DesktopSessionSummary } from "../shared/contract";

export type RecordValue = Record<string, unknown>;
export type Project = string;
export type TranscriptItem = RecordValue & {
  id?: string | number;
  kind?: string;
  text?: string;
  at?: number;
  model?: string;
  provider?: string;
  agent?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  rawResult?: unknown;
  isError?: boolean;
  streaming?: boolean;
  expanded?: boolean;
  count?: number;
  completedCount?: number;
  detail?: string;
  label?: string;
  status?: string;
  tone?: string;
  verb?: string;
  elapsedMs?: number;
  startedAt?: number;
  completedAt?: number;
  liveOutput?: string;
  outputTokens?: number;
  errorCount?: number;
  callErrorCount?: number;
  exitErrorCount?: number;
  images?: Array<{ id?: number | null; name?: string; mimeType?: string; bytes?: number }>;
};


export type Approval = RecordValue & {
  id?: string;
  name?: string;
  reason?: string;
  args?: unknown;
  cwd?: string;
};
export type Toast = RecordValue & {
  id?: string | number;
  text?: string;
  message?: string;
  tone?: string;
};
export type GoalTask = {
  id?: string;
  text?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'dropped' | 'awaiting_approval';
  kind?: 'work' | 'verification';
};
export type GoalSnapshot = {
  id?: string;
  sessionId?: string;
  objective?: string;
  title?: string;
  status?: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'duration_reached' | 'complete';
  tasks?: GoalTask[];
  tasksCompleted?: number;
  tasksTotal?: number;
  turnCount?: number;
  tasksUpdatedAt?: number | null;
  blocker?: string;
  timeLimitMs?: number;
  timeUsedMs?: number;
  remainingMs?: number | null;
  deadlineAt?: number | null;
  snapshotAt?: number;
  createdAt?: number;
  updatedAt?: number;
  lastStartedAt?: number | null;
  completedAt?: number | null;
};
export type Snapshot = RecordValue & {
  items?: TranscriptItem[];
  streamingTail?: TranscriptItem | null;
  busy?: boolean;
  commandBusy?: boolean;
  queued?: unknown[];
  toolApproval?: Approval | null;
  cwd?: string;
  project?: Project | null;
  currentProject?: Project | null;
  recentProjects?: Project[];
  toasts?: Toast[];
  /** Setup tool `open`: navigate to the settings surface named by this slash
   *  command. `seq` increases per request so a repeat of the same command
   *  still fires. */
  uiOpenRequest?: { command: string; seq: number; at?: number } | null;
  failedTurnKeys?: string[];
  sessionId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  fastCapable?: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  thinking?: unknown;
  spinner?: RecordValue | null;
  commandStatus?: RecordValue | null;
  goal?: GoalSnapshot | null;
  promptHistoryList?: unknown[];
  desktopSessionTitle?: string;
  stats?: RecordValue;
  contextWindow?: number;
  displayContextWindow?: number;
  autoCompactTokenLimit?: number;
  agentWorkers?: RecordValue[];
  agentJobs?: RecordValue[];
  activeTools?: {
    explore?: { count?: number; startedAt?: number };
    web_search?: { count?: number; startedAt?: number };
    shell?: { count?: number; startedAt?: number };
    agent?: { count?: number; startedAt?: number };
  } | null;
  shellJobs?: {
    count?: number;
    elapsedLabel?: string;
    jobs?: Array<{
      taskId?: string;
      task_id?: string;
      command?: string;
      cwd?: string;
      startedAt?: number | string | null;
    }>;
  };
  workflow?: RecordValue | null;
};

export const EMPTY_SNAPSHOT: Snapshot = { items: [], queued: [] };
export const EMPTY_TRANSCRIPT_ITEMS: TranscriptItem[] = [];

/** Session owners whose Lead or child-agent heartbeat is active. Unlike the
 * sidebar selection helper below, this list is process-wide and must never be
 * changed by whichever conversation currently has focus. */
export function agentActivitySessionIds(
  sessions: readonly DesktopSessionSummary[],
): string[] {
  return sessions
    .filter((session) =>
      session.leadWorking === true
      || session.agentWorking === true)
    .map((session) => session.id);
}


/** Legacy shared Unified/Split key; the three surfaces below persist
 *  separately now and only read this one as the first-run fallback. */
export const REVIEW_DIFF_STYLE_KEY = 'mixdog.review-diff-style.v1';
/** Unified/Split is remembered PER SURFACE (user: 통합/분할은 소스컨트롤 /
 *  세션 컴포저 위 / 세션 변경사항 독 3개 분리 저장): the Source Control diff
 *  tab, the TurnReview bar above the composer, the Session Diff dock's tab. */
export const SCM_DIFF_STYLE_KEY = 'mixdog.scm-diff-style.v1';
export const TURN_REVIEW_DIFF_STYLE_KEY = 'mixdog.turn-review-diff-style.v1';
export const SESSION_DIFF_STYLE_KEY = 'mixdog.session-diff-style.v1';

export type DiffStyle = 'unified' | 'split';

export function readDiffStyle(key: string): DiffStyle {
  try {
    const own = window.localStorage.getItem(key);
    if (own === 'split' || own === 'unified') return own;
    return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

export function writeDiffStyle(key: string, style: DiffStyle): void {
  try { window.localStorage.setItem(key, style); } catch { /* persistence only */ }
}
