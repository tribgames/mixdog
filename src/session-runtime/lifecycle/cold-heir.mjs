/**
 * src/session-runtime/lifecycle/cold-heir.mjs - the record of a heir that is
 * NOT opened: a sibling of the source session on the same route, cwd and
 * Project, persisted to the store and left cold for a later resume.
 *
 * The heir starts from the source's own record (same provider/model, tool
 * surface, system layer, desktop classification) the way /clear's cold fork
 * does, minus everything that belongs to the source alone: its conversation,
 * in-flight turn, provider continuation, usage readings, title, worktree and
 * ownership/lineage links — the heir is a root Lead of its own, linked to the
 * source only through `inheritedFromSessionId`.
 */
import {
  ensureCodexWireSessionId,
  mintSessionId,
} from '../../runtime/agent/orchestrator/session/manager/session-id.mjs';
import {
  refreshSessionWorkspaceContext,
  resetSessionBp3Environment,
} from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { buildWorkspacePromptContext } from '../../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import {
  invalidateContextUsageSnapshot,
  invalidateProviderContextBaseline,
} from '../../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { deleteSession, evictLiveSession, saveSessionAsync } from '../../runtime/agent/orchestrator/session/store.mjs';
import { projectWorkspace } from '../../runtime/shared/worktrees/contract.mjs';
import { writeStderrBestEffort } from '../../runtime/shared/best-effort-stderr.mjs';
import { replacementSessionCwd } from '../workspace/workspace-state.mjs';

// Per-turn and per-process state of the source: the in-flight turn, its
// transient serializer-stripped aliases, and one-shot pending work.
const SOURCE_RUNTIME_FIELDS = [
  'liveTurnMessages',
  'toolApprovalHook',
  '_providerPrefixGuardState',
  'activeTurnCheckpoint',
  'deferredInitialRefreshPending',
  'pendingGoalReminder',
  'goalReminderRevision',
  'pendingCacheBreakIntent',
  'contextPressureUnanchoredAfterRestart',
  'contextPressureUnanchoredReason',
  // Store read-back projections of the SOURCE file.
  'storageMtimeMs',
  'storageSize',
];

// Identity the source owns: its title (the carry decides the heir's), import
// provenance (a dedupe key), its own inheritance link (the carry sets the
// heir's), Codex wire identity, lifecycle provenance (a 'cli-resume' detach
// hides a row from Recent), and every ownership / lineage / visibility link —
// a self-link copied from a recovered root Lead would point at the source and
// classify the heir as an agent-only child.
const SOURCE_IDENTITY_FIELDS = [
  'title',
  'titleLocked',
  'titleSource',
  'titleUpdatedAt',
  'importOrigin',
  'inheritedFromSessionId',
  'codexWireSessionId',
  'detachedReason',
  'sessionVisibility',
  'task_id',
  'taskId',
];

// The heir is an ordinary, user-visible root Lead owned by nobody but itself,
// whatever the source's ownership history (same identity a new Lead session
// or an imported conversation gets).
const ROOT_LEAD_IDENTITY = Object.freeze({
  owner: 'cli',
  agent: 'lead',
  lane: 'cli',
  sourceType: 'lead',
  sourceName: 'main',
  parentSessionId: null,
  ownerSessionId: null,
  visibility: null,
  agentTag: null,
  taskType: null,
  permissionMode: null,
  scopeKey: null,
});

/**
 * The source as of its last committed turn. Mid-turn, `messages` already
 * holds the in-flight user prompt (pre-committed before the provider call)
 * while `liveTurnMessages` holds the turn's working transcript; the prompt is
 * not part of the conversation yet, so it does not travel. Never mutates.
 */
export function committedSource(source) {
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const live = source?.liveTurnMessages;
  if (!Array.isArray(live) || live === messages || messages.at(-1)?.role !== 'user') return source;
  return { ...source, messages: messages.slice(0, -1) };
}

/** A fresh, empty heir record of `source` — system layer only, nothing saved. */
export function buildColdHeir(source, now = Date.now()) {
  const heir = {
    ...source,
    id: mintSessionId(),
    // The heir runs on the very route that built these blocks; copies, so
    // the heir never shares a message object with the source.
    messages: structuredClone((source.messages || []).filter((message) => message?.role === 'system')),
    closed: false,
    status: 'idle',
    generation: 0,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    lastHeartbeatAt: null,
    mcpPid: process.pid,
    clientHostPid: null,
    providerState: undefined,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalToolCalls: 0,
    reasoningUsage: null,
    totalCachedReadTokens: 0,
    totalCacheWriteTokens: 0,
    tokensCumulative: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCachedReadTokens: 0,
    lastCacheWriteTokens: 0,
    lastContextTokens: 0,
    lastContextTokensUpdatedAt: now,
    lastContextTokensStaleAfterCompact: false,
    ...ROOT_LEAD_IDENTITY,
  };
  for (const key of [...SOURCE_RUNTIME_FIELDS, ...SOURCE_IDENTITY_FIELDS]) delete heir[key];
  ensureCodexWireSessionId(heir);
  // The compaction archive sidecar is keyed by the source id.
  if (heir.compaction?.archive) {
    heir.compaction = { ...heir.compaction };
    delete heir.compaction.archive;
  }
  // A worktree belongs to the session that created it: like /new, the heir
  // starts in the Project folder instead of sharing (and on delete, removing)
  // the source's worktree.
  const projectFolder = replacementSessionCwd(source);
  if (projectFolder) {
    heir.cwd = projectFolder;
    heir.workspace = projectWorkspace({ projectPath: projectFolder });
  }
  // The source's staged working-folder change (its prompt still rooted at an
  // earlier folder) is the source's own: the heir's prompt is built for the
  // folder it actually starts in. Project memory follows the Project, which a
  // worktree shares, so the source's current memory slice carries over.
  // In the same folder only the environment facts are rebuilt: they name the
  // heir's own scratch directory, never the source's, while the inherited
  // instruction files and memory stay as the source presented them.
  const pending = source.workspaceReroot;
  delete heir.workspaceReroot;
  if (heir.cwd) {
    const context = buildWorkspacePromptContext(heir, heir.cwd);
    refreshSessionWorkspaceContext(
      heir,
      projectFolder || pending
        ? { cwd: heir.cwd, ...context, coreMemoryContext: pending?.target?.coreMemoryContext }
        : { cwd: heir.cwd, environmentContext: context.environmentContext }
    );
  }
  invalidateContextUsageSnapshot(heir);
  invalidateProviderContextBaseline(heir);
  // The `# Session` block names the session it was stamped for; the heir's
  // first turn stamps its own.
  resetSessionBp3Environment(heir);
  return heir;
}

/**
 * Persist the heir durably, then drop it from the same-process live cache:
 * it is a cold session until someone resumes it. A failed save removes the
 * half-made record and rejects.
 */
export async function persistColdHeir(heir) {
  try {
    await saveSessionAsync(heir);
  } catch (error) {
    try {
      deleteSession(heir.id);
    } catch (cleanupError) {
      writeStderrBestEffort(`[inherit] cleanup of ${heir.id} failed: ${cleanupError?.message || cleanupError}\n`);
    }
    throw error;
  }
  evictLiveSession(heir.id);
}
