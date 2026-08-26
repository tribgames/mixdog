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


export const REVIEW_DIFF_STYLE_KEY = 'mixdog.review-diff-style.v1';
