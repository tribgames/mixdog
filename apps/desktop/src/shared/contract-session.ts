// Session state, transcript, agent pool, goal, model and prompt types.
import type { DesktopNewTaskWorktree, DesktopSessionWorkspace } from './contract-worktree';

/** How the last tool approval ended: answered from `device`, or with no device
 *  — `expired` (a real timeout), `withdrawn` (its copy was taken away unanswered)
 *  or `interrupted` (Stop / turn abort). */
export interface ToolApprovalResult {
  id: string;
  approved: boolean;
  device: string;
  at: number;
  expired?: boolean;
  withdrawn?: boolean;
  interrupted?: boolean;
}

export type DesktopUpdaterState =
  | { status: 'disabled' | 'idle' | 'checking' | 'up-to-date' }
  | { status: 'downloading' | 'ready' | 'installing'; version: string; percent?: number }
  | { status: 'error'; message: string };

export interface DesktopActivityState extends Readonly<Record<string, unknown>> {
  active?: boolean;
  mode?: string;
  verb?: string;
  startedAt?: number;
}

export interface DesktopTranscriptItem extends Readonly<Record<string, unknown>> {
  id?: string | number;
  kind?: string;
  status?: string;
  label?: string;
  detail?: string;
  at?: number;
  model?: string;
  /** Actual route ID; model remains the human-readable transcript label. */
  modelId?: string;
  provider?: string;
  agent?: string;
  /** Device that submitted this prompt (user rows only). */
  device?: string;
  /** The turn's change-record key (the outer prompt id) on `user` and
   *  `turndone` rows: what getTurnChanges/revertTurnChanges address. */
  checkpointId?: string;
  /** Skills this prompt explicitly loaded (`Skill:` header or inline `$name`),
   *  in selection order; `user` rows only, absent when none loaded. */
  appliedSkills?: readonly string[];
}

export interface DesktopAgentWorker extends Readonly<Record<string, unknown>> {
  tag?: string;
  agent?: string;
  name?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  /** Per-route Auto reasoning; absent means on. */
  autoEffort?: boolean;
  status?: string;
  stage?: string;
  startedAt?: number | string;
  startTime?: number | string;
  createdAt?: number | string;
}

export interface DesktopAgentJob extends Readonly<Record<string, unknown>> {
  tag?: string;
  agent?: string;
  type?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  autoEffort?: boolean;
  task_id?: string;
  taskId?: string;
  status?: string;
  stage?: string;
  startedAt?: number | string;
}

/** Best message-content hit of one session, strongest first. */
export interface DesktopSessionContentMatch {
  sessionId: string;
  snippet: string;
  rank: number;
}

/** One active row from the merged child/Lead lifecycle pools. */
export interface DesktopAgentPoolRow extends Readonly<Record<string, unknown>> {
  tag: string;
  sessionId: string;
  ownerSessionId: string | null;
  /** Immediate spawn parent. Equals `ownerSessionId` for a first-generation
   *  child; a nested descendant points at the agent session that spawned it,
   *  which is how the Agent window reconstructs the Parent–Child hierarchy. */
  parentSessionId?: string | null;
  title?: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  effort?: string | null;
  fast?: boolean | null;
  /** Per-route Auto reasoning; absent means on, only `false` turns it off. */
  autoEffort?: boolean | null;
  status: string;
  stage: string;
  /** Why a `failed` row failed: `process-restart` (the process running the
   *  turn went away) or `stalled` (the progress watchdog stopped it); absent
   *  for any other failure and for every row that did not fail. */
  failureReason?: string | null;
  /** Set when the owner closed this agent (the agent tool's `close`); its
   *  status is unchanged. Absent once the agent is reused or is working. */
  released?: boolean;
  /** While the turn runs: the last moment it made progress the stall
   *  watchdog counts (epoch ms), the runtime stage it is in, the tool it runs
   *  (`tool_running`), and that agent's watchdog warn point (ms without
   *  progress). Absent on a row that is not running. */
  progressAt?: number | null;
  progressStage?: string | null;
  progressTool?: string | null;
  stallWarnMs?: number | null;
  startedAt: number | string | null;
  turnStartedAt: number | string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
  idleSince?: number | string | null;
  reapAt?: number | string | null;
  cwd: string | null;
  clientHostPid: number | null;
  taskId: string | null;
  /** Cumulative token usage over the agent session's turns so far; null when unknown. */
  usage?: DesktopAgentPoolUsage | null;
  /** Cumulative tool calls the agent session has made; null when unknown. */
  toolCalls?: number | null;
}

export interface DesktopAgentPoolUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DesktopActiveToolState {
  count: number;
  startedAt: number;
}

export interface DesktopShellJobsState {
  count: number;
  elapsedLabel: string;
  jobs?: DesktopShellJobRow[];
  /** Recently finished background jobs of this session (rows carry status,
   *  exitCode and finishedAt); never part of `count`. */
  finished?: readonly DesktopShellJobRow[];
}

export interface DesktopShellJobRow extends Readonly<Record<string, unknown>> {
  taskId: string;
  command: string;
  cwd: string;
  startedAt: number | string | null;
  /** The command's result is reported, but its processes are not confirmed
   *  gone: the workspace stays held until they are, or until the user
   *  releases it explicitly (releaseShellJob). */
  terminationUnconfirmed?: boolean;
}

export interface DesktopWorkflowState extends Readonly<Record<string, unknown>> {
  id?: string;
  name?: string;
}
export type DesktopOrchestrationMode = 'none' | 'focused' | 'balanced' | 'swarm';

export interface DesktopQuotaResume {
  state: 'waiting';
  turnKey: string;
  provider: string;
  model: string;
  /** Epoch ms the provider's quota resets. */
  resetAt: number;
  attempts: number;
}

export interface DesktopGoalTask extends Readonly<Record<string, unknown>> {
  id?: string;
  text?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'dropped' | 'awaiting_approval';
  kind?: 'work' | 'verification';
}

export interface DesktopGoalState extends Readonly<Record<string, unknown>> {
  id?: string;
  revision?: number;
  needsTaskReview?: boolean;
  sessionId?: string;
  objective?: string;
  title?: string;
  status?: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'duration_reached' | 'complete';
  tasks?: DesktopGoalTask[];
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
}

/** Streamed text beyond the line-gated tail: `text` continues the tail whose
 *  text is `from` characters long. Before the row's first completed line
 *  there is no tail; `from` is 0 and `tail` carries the row identity. */
export interface DesktopStreamingPartial extends Readonly<Record<string, unknown>> {
  id: string | number;
  from: number;
  text: string;
  tail?: DesktopTranscriptItem;
}

export interface DesktopSessionState extends Readonly<Record<string, unknown>> {
  items?: DesktopTranscriptItem[];
  /** `items` is a tail window and older history can be paged in; absent on a
   *  whole-transcript (legacy) body. */
  transcriptHasOlder?: boolean;
  streamingTail?: DesktopTranscriptItem | null;
  /** The live row's unfinished line, which the line-gated `streamingTail`
   *  holds back (see shared/streaming-partial.ts). Terminal clients drop it;
   *  a client that predates it simply paints the line-gated tail. */
  streamingPartial?: DesktopStreamingPartial | null;
  queued?: unknown[];
  busy?: boolean;
  commandBusy?: boolean;
  thinking?: unknown;
  spinner?: DesktopActivityState | null;
  commandStatus?: DesktopActivityState | null;
  goal?: DesktopGoalState | null;
  /** A quota-stopped turn waiting to resume itself at the provider's reset. */
  quotaResume?: DesktopQuotaResume | null;
  progressHint?: { text?: string; tone?: string; percent?: number } | null;
  /** The session object's own route (may differ from provider/model after a route change). */
  sessionProvider?: string | null;
  sessionModel?: string | null;
  fast?: boolean;
  fastCapable?: boolean;
  /** Per-route Auto reasoning; absent means on, only `false` turns it off. */
  autoEffort?: boolean;
  modelParameters?: Readonly<Record<string, string>>;
  contextPercent?: number;
  /** Exact context window in force (only when it is a non-default value). */
  contextTokens?: number;
  contextDefaultPercent?: number;
  selectedContextWindow?: number;
  desktopSessionTitle?: string;
  agentWorkers?: DesktopAgentWorker[];
  agentJobs?: DesktopAgentJob[];
  activeTools?: {
    explore?: DesktopActiveToolState;
    web_search?: DesktopActiveToolState;
    shell?: DesktopActiveToolState;
    agent?: DesktopActiveToolState;
  } | null;
  shellJobs?: DesktopShellJobsState;
  /** Host-wide background shell totals (keep-awake). `shellJobs` above is the
   *  pane's OWN session bucket and must stay that way. */
  hostShellJobs?: DesktopShellJobsState;
  workflow?: DesktopWorkflowState | null;
  orchestrationMode?: DesktopOrchestrationMode;
  /** A workflow / orchestration mode chosen while a turn ran: `workflow` and
   *  `orchestrationMode` above already show it; it applies from the next turn. */
  pendingWorkflowSwitch?: boolean;
  pendingOrchestrationModeSwitch?: boolean;
  remoteEnabled?: boolean;
  /** How the last tool approval ended and from which device. */
  toolApprovalResult?: ToolApprovalResult | null;
  /** Approvals waiting behind the shown `toolApproval` (the dock's "1/N"). */
  toolApprovalsWaiting?: number;
  /** The pending ask_user questions of sessions this chat handed work to,
   *  shown at their hand-off lines (tui/session/tool-approval.mjs). */
  handoffQuestions?: Record<string, unknown>[];
  /** A prompt cancelled from another device, to be handed back to the device
   *  that sent it (`ids` are that device's submission ids). */
  promptRestore?: { id: string; ids: string[]; text: string; device: string; at: number } | null;
  providerAccountChange?: { provider: string; accountId: string; at: number };
  /** The Lead's live workspace: execution root (`cwd`), worktree binding and
   *  revision. Null while the session never left its project folder. */
  workspace?: DesktopSessionWorkspace | null;
}

// These are the session runtime's real activity/completion fields, not a parallel
// desktop status model. In particular, `thinking`/spinner modes describe live
// work while statusdone/turndone items retain the core completion outcome.
export type SessionSnapshot = Readonly<DesktopSessionState> | null;

/** One split-pane live-lane publication after preload reconstruction: a
 *  pooled session's own full snapshot, keyed by sessionId. */
export type DesktopSessionStateUpdate = {
  sessionId: string;
  snapshot: SessionSnapshot;
  /** Diagnostic correlation only; never participates in snapshot identity. */
  readTraceId?: string;
  /** Publication boundary this frame came from. "live" is an owner
   *  publication; "replay" is a re-emitted retained/durable projection. */
  frameSource: DesktopSessionFrameSource;
  /** Authoritative transcript CONTENT generation for this session — NOT an
   *  arrival counter. It advances only when an owner publication (or a
   *  non-regressing durable read) projects different transcript content, and
   *  a replay re-carries the revision of the frame it was derived from, so a
   *  stale disk projection delivered late can never claim to be newer. */
  contentRevision?: number;
  /** Why this frame carried a NULL snapshot. Only 'gone' is a real teardown.
   *  The daemon reclaims an unwatched idle session's memory ('unloaded') and a
   *  dropped daemon transport ('disconnected') both leave the transcript on
   *  disk and reload on demand, so a cached lane must SURVIVE them — dropping
   *  it repainted a live task as an empty New Task
   *  (user: 진행중인 TASK창이 갑자기 NEWTASK처럼 아예 비어버린다). */
  laneEnd?: DesktopSessionLaneEnd;
};

/** A historical-position read: the rows directly older than row `before`, or
 *  newer than row `after`, at most `limit` (DESKTOP_TRANSCRIPT_HISTORY_PAGE_ITEMS)
 *  within `byteBudget`. It never moves the session's shared window. */
export interface DesktopTranscriptHistoryRequest {
  before?: string;
  after?: string;
  limit: number;
  byteBudget?: number;
  /** The boundary row's position, as an earlier answer named it
   *  (`positions`): a spilled or archived row is then read where it is. */
  position?: string;
}

/** The answer: `reset` when the boundary row is gone (compaction, rewind),
 *  `unsupported` when the daemon predates historical-position reads. */
export interface DesktopTranscriptHistoryPage {
  items: DesktopTranscriptItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  /** Per row (aligned with `items`): its position, or null when it needs none. */
  positions?: (string | null)[];
  reset?: boolean;
  unsupported?: boolean;
}

/** The most rows one historical-position read carries. */
export const DESKTOP_TRANSCRIPT_HISTORY_PAGE_ITEMS = 512;

export type DesktopSessionFrameSource = 'live' | 'replay';
export type DesktopSessionLaneEnd = 'gone' | 'unloaded' | 'disconnected';

// Wire form of the `mixdog:state` push. Streaming publications replace the
// full `items` array with an identity-prefix patch (settled transcript items
// are immutable by identity in the host); the preload bridge reassembles the
// full snapshot before listeners see it, so renderers keep consuming
// SessionSnapshot. A `base` mismatch (window reload, missed event) triggers a
// `mixdog:state-resync` request and the host restarts from a full snapshot.
export interface DesktopStateItemsPatch {
  base: number;
  revision: number;
  /** Older rows revealed above the held list (session lanes only). */
  prepend?: DesktopTranscriptItem[];
  prefix: number;
  append: DesktopTranscriptItem[];
}
export interface DesktopStateStreamingTailPatch {
  prefix: number;
  append: string;
  tail: DesktopTranscriptItem;
}
export interface DesktopStateFieldsPatch {
  base: number;
  revision: number;
  changed: Readonly<Record<string, unknown>>;
  removed: string[];
}
export type DesktopStateWire =
  | (DesktopSessionState & {
      __itemsRevision?: number;
      __itemsPatch?: DesktopStateItemsPatch;
      __streamingTailPatch?: DesktopStateStreamingTailPatch;
      __statePatch?: DesktopStateFieldsPatch;
    })
  | null;

/** IPC-only split-pane lane wire. Preload reconstructs this delta before the
 * renderer-facing DesktopSessionStateUpdate listener runs. */
export type DesktopSessionStateWireUpdate = Omit<DesktopSessionStateUpdate, 'snapshot'> & {
  wire: DesktopStateWire;
};

export interface ToolApprovalDecision {
  approved: boolean;
  reason?: string;
  /** ask_user answers, aligned by index with the questions; null = unanswered. */
  answers?: Array<{ selected: string[]; text?: string } | null>;
  /** ask_user: the composer message that answered the question. */
  reply?: string;
  /** Human-in-the-loop response (human-gate/requests.mjs); never carries a
   *  secret value — that goes through provideSecretInput only. */
  response?: 'approve' | 'deny' | 'edit-and-approve' | 'provide-secret' | 'skip' | 'done';
  /** edit-and-approve: the card's edited text for the request's editable fields. */
  editedArgs?: Record<string, string>;
  remember?: 'once' | 'agent' | 'always';
  /** permission: the chosen scope id. */
  scope?: string;
  /** Host-stamped name of the device that answered. */
  device?: string;
}

export interface DesktopModelEffortOption {
  value: string;
  label: string;
}

export interface DesktopModelParameterOption {
  id: string;
  label: string;
  kind: 'boolean' | 'enum';
  options: Array<{ value: string; label: string; contextWindow?: number }>;
}

export interface DesktopModelOption {
  provider: string;
  model: string;
  display: string;
  created?: number;
  releaseDate?: string;
  contextWindow?: number;
  maxContextWindow?: number;
  family?: string;
  latest?: boolean;
  /** Free-form secondary line; media lanes use it for the provider name. */
  description?: string;
  /** A custom provider's registered name, so the picker needs no setup call. */
  providerName?: string;
  supportsVision?: boolean;
  effortOptions: DesktopModelEffortOption[];
  fastCapable: boolean;
  fastEfforts?: string[];
  fastPreferred: boolean;
  savedEffort?: string;
  savedFast?: boolean;
  savedAutoEffort?: boolean;
  defaultEffort?: string;
  defaultFast?: boolean;
  /** Effort can change per turn without breaking the prompt cache, so the
   *  Auto effort switch applies to this model. */
  autoEffortCapable?: boolean;
  modelParameterOptions?: DesktopModelParameterOption[];
  parameterVariants?: Array<Record<string, string>>;
  defaultModelParameters?: Record<string, string>;
  savedModelParameters?: Record<string, string>;
  savedContextPercent?: number;
  /** Model management: the user's explicit /model visibility choice; absent
   *  means the picker's default listing (family limit). */
  savedHidden?: boolean;
  /** Model management favorite: listed first in /model. */
  favorite?: boolean;
  /** Set only on a quick answer the daemon served from its loaded catalog:
   *  that answer is already the full catalog, so no full read has to follow. */
  catalogComplete?: true;
  /** Set on every row of an answer some provider was missing from (failed or
   *  timed out); absent on complete answers. */
  catalogPartial?: true;
  /** Providers missing from a partial answer. */
  catalogMissing?: string[];
  /** Daemon epoch ms after which a partial answer should be fetched again. */
  catalogRetryAt?: number;
}

export interface DesktopModelCatalogOptions {
  force?: boolean;
  refresh?: boolean;
  quick?: boolean;
}

export interface DesktopModelSelection {
  provider: string;
  model: string;
  effort?: string;
  fast?: boolean;
  /** Per-route Auto reasoning; absent means on, only `false` turns it off. */
  autoEffort?: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  /** Exact window (positive integer); overrides contextPercent. */
  contextTokens?: number;
  /** The Lead's ordered fallback models (leaf selections); [] clears, absent keeps the stored list. */
  fallbacks?: DesktopModelSelection[];
  /** Compare-and-set: the runtime applies the selection only while the route
   *  it targets still has no model, so a model picked meanwhile is kept. */
  onlyIfEmpty?: boolean;
}

export interface DesktopPromptTextPart {
  type: 'text';
  text: string;
}

export interface DesktopPromptImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface DesktopPromptFilePart {
  type: 'file';
  data: string;
  mimeType: string;
  filename?: string;
}

export type DesktopPromptContent =
  | string
  | Array<DesktopPromptTextPart | DesktopPromptImagePart | DesktopPromptFilePart>;

export type DesktopPromptPriority = 'now' | 'next' | 'later';

export interface DesktopPromptAttachment {
  id: number;
  type: 'image';
  content?: string;
  attachmentRef?: string;
  sizeBytes?: number;
  mediaType: string;
  filename?: string;
  sourcePath?: string;
  metadataText?: string;
}

export interface DesktopPastedText {
  id: number;
  text?: string;
  attachmentRef?: string;
  sizeBytes?: number;
  chars?: number;
  filename?: string;
  mimeType?: string;
  source?: 'file' | 'paste';
}

export interface DesktopSubmitOptions {
  /** Renderer-generated correlation id reused by the session queue/transcript. */
  id?: string;
  /** Wall-clock submit time for privacy-safe queue/steering latency diagnostics. */
  submittedAt?: number;
  displayText?: string;
  /** Create a new task as a Goal without emitting a visible bootstrap prompt. */
  goalCommand?: string;
  /** Retry of a failed turn: when the turn produced no output, the runtime
   *  rewinds its unanswered prompt so the resubmission reaches the model once. */
  retryFailedTurn?: boolean;
  priority?: DesktopPromptPriority;
  pastedImages?: Record<string, DesktopPromptAttachment>;
  pastedTexts?: Record<string, DesktopPastedText>;
  /** A runtime kickoff (a new agent's greeting turn): the model reads it, the
   *  transcript and the queue never show it as the user speaking. */
  kickoff?: boolean;
  /** Host-stamped name of the device that sent this (see session-device.ts).
   *  Request validation rejects it from a caller. */
  device?: string;
  /** Host-only: a group-room member turn's place in a bot-to-bot chain
   *  (bot-hops.mjs), from the send or relay it answers. Request validation
   *  rejects it from a caller. */
  hop?: number;
  /** Host-only: the newest user row of the room log a group-room member turn's
   *  prompt shows. Request validation rejects it from a caller. */
  roomRow?: string;
  /** Host-only: a group-room member's relay turn of its reported work is
   *  system-caused (src/runtime/shared/prompt-origin.mjs). Request validation
   *  rejects it from a caller. */
  origin?: 'agent-report';
}

export interface DesktopAbortOptions {
  /** Host-stamped name of the device cancelling. */
  device?: string;
  /** Rewind a submitted prompt only when the composer was empty at cancel. */
  restorePrompt?: boolean;
  /** Renderer submission identity used to reclaim an accepted prompt before
   *  its busy projection reaches the pane. */
  submissionId?: string;
}

export interface DesktopNewTaskDraft {
  projectPath?: string;
  route?: DesktopModelSelection;
  workflowId?: string;
  orchestrationMode?: DesktopOrchestrationMode;
  /** The draft picked "Worktree": created and entered before the prompt is sent. */
  worktree?: DesktopNewTaskWorktree;
}

export interface DesktopNewTaskSubmitResult {
  accepted: boolean;
  sessionId: string;
  snapshot: SessionSnapshot;
}
