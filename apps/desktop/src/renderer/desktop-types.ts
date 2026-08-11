import type { DesktopSessionSummary } from "../shared/contract";
import { isActiveDesktopAgentEntry } from "../shared/agent-activity";

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
    search?: { count?: number; startedAt?: number };
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
  remoteEnabled?: boolean;
};

export const EMPTY_SNAPSHOT: Snapshot = { items: [], queued: [] };
export const EMPTY_TRANSCRIPT_ITEMS: TranscriptItem[] = [];

function hasActiveAgentEntries(entries: RecordValue[] | undefined): boolean {
  return Array.isArray(entries) && entries.some(isActiveDesktopAgentEntry);
}

export function hasActiveSnapshotWork(snapshot: Snapshot): boolean {
  const spinnerActive = Boolean(snapshot.spinner && snapshot.spinner.active !== false);
  const commandActive = Boolean(snapshot.commandStatus && snapshot.commandStatus.active !== false);
  return Boolean(
    snapshot.busy
    || snapshot.commandBusy
    || snapshot.thinking
    || spinnerActive
    || commandActive
    || hasActiveAgentEntries(snapshot.agentWorkers)
    || hasActiveAgentEntries(snapshot.agentJobs)
  );
}

export function workingSessionIdsForSnapshot(
  sessions: readonly DesktopSessionSummary[],
  activeSessionId: string,
  activeBusy: boolean,
  activeRemoteAttached = false,
): Set<string> {
  const ids = new Set(sessions
    .filter((session) => session.working === true || session.agentWorking === true)
    .map((session) => session.id));
  if (activeSessionId) {
    const activeAgentWorking = sessions.some((session) =>
      session.id === activeSessionId && session.agentWorking === true);
    // A local live snapshot is authoritative for its selected session and can
    // release a stale own-turn heartbeat. Child-agent and remote-owner
    // heartbeats remain authoritative while the selected lead itself is idle.
    if (activeBusy || activeAgentWorking) ids.add(activeSessionId);
    else if (!activeRemoteAttached) ids.delete(activeSessionId);
  }
  return ids;
}


export const REVIEW_DIFF_STYLE_KEY = 'mixdog.review-diff-style.v1';
