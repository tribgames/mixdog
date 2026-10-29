import type {
  DesktopQuotaResume,
  DesktopSessionSummary,
  DesktopSessionWorkspace,
  ToolApprovalResult,
} from '../shared/contract';

export type RecordValue = Record<string, unknown>;
export type Project = string;
export type TranscriptItem = RecordValue & {
  id?: string | number;
  /** Stable message identity, live and restored (unlike `id` of restored rows). */
  messageId?: string;
  /** Delivered into the thread outside any turn: bot chat groups it by time only (agentChatPlace). */
  posted?: boolean;
  kind?: string;
  text?: string;
  at?: number;
  model?: string;
  modelId?: string;
  provider?: string;
  agent?: string;
  /** Device that submitted this prompt (user rows only). */
  device?: string;
  /** The bot that sent this user-kind row into this chat (a bot's `session send`). */
  fromAgent?: string;
  /** A message the model read inside its running turn (user rows only). */
  steered?: boolean;
  /** A message sent while a turn runs that the model has not read yet: it
   *  waits for the next step boundary (`pending`), runs after the turn (a
   *  slash command, `held`), is being sent now (`sending`), or could not be
   *  sent (`failed`). */
  steer?: 'pending' | 'held' | 'sending' | 'failed';
  /** The turn checkpoint a `user` prompt opened or a `turndone` closed. */
  checkpointId?: string;
  /** A row a compaction took out of the model context: display-only. */
  archived?: boolean;
  name?: string;
  args?: unknown;
  result?: unknown;
  rawResult?: unknown;
  /** Structured twin of a tool result's text (e.g. the Computer Use capability
   *  refusal; a `visualize` call's owner conversation, `ownerSessionId`). */
  toolMeta?: { code: string; missing: string[]; ownerSessionId?: string };
  isError?: boolean;
  streaming?: boolean;
  expanded?: boolean;
  count?: number;
  completedCount?: number;
  /** A tool row from an imported conversation: the calls are counted by name; their results were never imported. */
  imported?: boolean;
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
  images?: Array<{ id?: number | null; name?: string; mimeType?: string; bytes?: number; attachmentRef?: string }>;
  /** User rows: the attachments the message carries, by the content hash the host stores them under;
   *  task reports and room speech: the files the turn returned. */
  attachments?: Array<{ id: string; kind: 'image' | 'file' | 'text'; name: string; mimeType: string; size: number }>;
  /** Restored rows: each image's stored original, by the `[Image: …]` line that draws it. */
  imageRefs?: Array<{ line: string; ref?: string }>;
  /** A group-room row (agent-room.mjs): who spoke, a pass, a limit notice,
   *  or (host overlay) the member speaking now. */
  room?: TranscriptRoomRow;
};

export type TranscriptRoomRow = {
  id?: string;
  kind: 'user' | 'speech' | 'pass' | 'cap' | 'stopped' | 'interrupted' | 'typing';
  speaker?: string;
  name?: string;
  /** The members a user message or a member's @mention addresses, in order. */
  to?: string[];
  toName?: string[];
  failed?: boolean;
  /** A failed pass: every member a run of failures stands for, and why. */
  names?: string[];
  reason?: string;
  limit?: 'rounds' | 'messages' | 'usage';
  /** A usage-limit stop: what ran out, on which model, and when it resets. */
  usage?: {
    kind: 'quota_exhausted' | 'entitlement' | 'billing';
    provider: string;
    model: string;
    resetAt: number | null;
  };
  rounds?: number;
  messages?: number;
};

export type Approval = RecordValue & {
  id?: string;
  name?: string;
  /** 'question' = an ask_user card (args.questions) instead of an allow/deny one. */
  kind?: string;
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
  revision?: number;
  // Bumped when the runtime delivers a "budget nearly over" warning, so a
  // surface can tell that crossing apart from an ordinary state update.
  warningRevision?: number;
  needsTaskReview?: boolean;
  sessionId?: string;
  objective?: string;
  title?: string;
  status?: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'duration_reached' | 'complete' | 'stopped';
  pauseReason?: 'user' | 'waiting';
  timeMode?: 'max' | 'duration';
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
  stoppedAt?: number | null;
};
export type Snapshot = RecordValue & {
  items?: TranscriptItem[];
  /** `items` is a tail window with older history available on demand. */
  transcriptHasOlder?: boolean;
  streamingTail?: TranscriptItem | null;
  busy?: boolean;
  commandBusy?: boolean;
  queued?: unknown[];
  toolApproval?: Approval | null;
  toolApprovalResult?: ToolApprovalResult | null;
  /** Approvals waiting behind `toolApproval`: its own, and copies of sessions
   *  this chat delegated or handed work to (the dock's "1/N"). */
  toolApprovalsWaiting?: number;
  /** The pending ask_user questions of sessions this chat handed work to,
   *  each shown at that session's hand-off line (`sessionId`: the asking
   *  session) and answered through this chat; never in the transcript. */
  handoffQuestions?: Approval[];
  promptRestore?: { id: string; ids: string[]; text: string; device: string; at: number } | null;
  cwd?: string;
  /** The Lead's live workspace (execution root, worktree binding, revision). */
  workspace?: DesktopSessionWorkspace | null;
  project?: Project | null;
  currentProject?: Project | null;
  recentProjects?: Project[];
  toasts?: Toast[];
  /** Setup tool `open`: navigate to the settings surface named by this slash
   *  command. `seq` increases per request so a repeat of the same command
   *  still fires. */
  uiOpenRequest?: { command: string; seq: number; at?: number } | null;
  setupUiRequest?: { id: string; at: number } | null;
  /** Setup tool mutation: settings readers re-read; `seq` increases per change. */
  setupChanged?: { action: string; seq: number; at?: number } | null;
  failedTurnKeys?: string[];
  sessionId?: string;
  provider?: string;
  model?: string;
  sessionProvider?: string | null;
  sessionModel?: string | null;
  effort?: string;
  /** Effort the runtime resolved for the turn in flight (Auto judge); null/absent when none. */
  turnEffort?: string | null;
  fast?: boolean;
  fastCapable?: boolean;
  /** Per-route Auto reasoning; absent means on, only `false` turns it off. */
  autoEffort?: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  /** Exact context window in force (only when it is a non-default value). */
  contextTokens?: number;
  contextDefaultPercent?: number;
  selectedContextWindow?: number;
  thinking?: unknown;
  spinner?: RecordValue | null;
  commandStatus?: RecordValue | null;
  goal?: GoalSnapshot | null;
  quotaResume?: DesktopQuotaResume | null;
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
      /** Killed, but not every process is confirmed gone; the folder stays held. */
      terminationUnconfirmed?: boolean;
    }>;
    /** Recently finished background jobs; never part of `count`. */
    finished?: Array<{
      taskId?: string;
      task_id?: string;
      command?: string;
      cwd?: string;
      startedAt?: number | string | null;
      status?: string;
      exitCode?: number | null;
      finishedAt?: number | string | null;
    }>;
  };
  workflow?: RecordValue | null;
  orchestrationMode?: import('../shared/contract').DesktopOrchestrationMode;
  pendingWorkflowSwitch?: boolean;
  pendingOrchestrationModeSwitch?: boolean;
};

export const EMPTY_SNAPSHOT: Snapshot = { items: [], queued: [] };
export const EMPTY_TRANSCRIPT_ITEMS: TranscriptItem[] = [];

/** Session owners whose Lead or child-agent turn the daemon reports running in
 * its in-memory state (`leadWorking` / `agentWorking`). Unlike the
 * sidebar selection helper below, this list is process-wide and must never be
 * changed by whichever conversation currently has focus. */
export function agentActivitySessionIds(sessions: readonly DesktopSessionSummary[]): string[] {
  return sessions
    .filter((session) => session.leadWorking === true || session.agentWorking === true)
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
/** The composer chip's and Changes pane's one global source (uncommitted, branch, …). */
export const SESSION_CHANGES_SOURCE_KEY = 'mixdog.session-changes-source.v1';

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
  try {
    window.localStorage.setItem(key, style);
  } catch {
    /* persistence only */
  }
}
