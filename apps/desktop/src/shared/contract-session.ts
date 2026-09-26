// Session state, transcript, agent pool, goal, model and prompt types.

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
}

export interface DesktopAgentWorker extends Readonly<Record<string, unknown>> {
  tag?: string;
  agent?: string;
  name?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
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
  task_id?: string;
  taskId?: string;
  status?: string;
  stage?: string;
  startedAt?: number | string;
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
  status: string;
  stage: string;
  startedAt: number | string | null;
  turnStartedAt: number | string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
  idleSince?: number | string | null;
  reapAt?: number | string | null;
  cwd: string | null;
  clientHostPid: number | null;
  taskId: string | null;
}

export interface DesktopActiveToolState {
  count: number;
  startedAt: number;
}

export interface DesktopShellJobsState {
  count: number;
  elapsedLabel: string;
  jobs?: DesktopShellJobRow[];
}

export interface DesktopShellJobRow extends Readonly<Record<string, unknown>> {
  taskId: string;
  command: string;
  cwd: string;
  startedAt: number | string | null;
}

export interface DesktopWorkflowState extends Readonly<Record<string, unknown>> {
  id?: string;
  name?: string;
}
export type DesktopOrchestrationMode = 'none' | 'focused' | 'balanced' | 'swarm';

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

export interface DesktopSessionState extends Readonly<Record<string, unknown>> {
  items?: DesktopTranscriptItem[];
  /** `items` is a tail window and older history can be paged in; absent on a
   *  whole-transcript (legacy) body. */
  transcriptHasOlder?: boolean;
  streamingTail?: DesktopTranscriptItem | null;
  queued?: unknown[];
  busy?: boolean;
  commandBusy?: boolean;
  thinking?: unknown;
  spinner?: DesktopActivityState | null;
  commandStatus?: DesktopActivityState | null;
  goal?: DesktopGoalState | null;
  progressHint?: { text?: string; tone?: string; percent?: number } | null;
  fast?: boolean;
  fastCapable?: boolean;
  modelParameters?: Readonly<Record<string, string>>;
  contextPercent?: number;
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
  remoteEnabled?: boolean;
  providerAccountChange?: { provider: string; accountId: string; at: number };
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
  supportsVision?: boolean;
  effortOptions: DesktopModelEffortOption[];
  fastCapable: boolean;
  fastEfforts?: string[];
  fastPreferred: boolean;
  savedEffort?: string;
  savedFast?: boolean;
  defaultEffort?: string;
  defaultFast?: boolean;
  modelParameterOptions?: DesktopModelParameterOption[];
  parameterVariants?: Array<Record<string, string>>;
  defaultModelParameters?: Record<string, string>;
  savedModelParameters?: Record<string, string>;
  savedContextPercent?: number;
  /** Set only on a quick answer the daemon served from its loaded catalog:
   *  that answer is already the full catalog, so no full read has to follow. */
  catalogComplete?: true;
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
  modelParameters?: Record<string, string>;
  contextPercent?: number;
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
}

export interface DesktopAbortOptions {
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
}

export interface DesktopNewTaskSubmitResult {
  accepted: boolean;
  sessionId: string;
  snapshot: SessionSnapshot;
}
