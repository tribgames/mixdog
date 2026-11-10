/**
 * The pending worktree intent of the hosted Lead: armed at creation (the New
 * task default or an explicit choice) or by "워크트리", and provisioned at
 * the start of the next turn (or at once, for a New Task's first send).
 */
import {
  WORKTREE_CARRY_CHOICES,
  isWorktreeBound,
  isWorktreeError,
  worktreeError,
} from '../../runtime/shared/worktrees/contract.mjs';
import { sessionHasConversationMessages } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { promptContentText } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { assertRevision, validName, validRevision } from './transition-runner.mjs';
import { readSessionWorkspace } from './workspace-state.mjs';

/**
 * Creation-time intent: `{ mode: 'worktree', name }` asks for a worktree;
 * `{ mode: 'default' }` — an interactive Lead the user starts (TUI launch) —
 * follows the settings `newTaskDefault`; `{ mode: 'branch' }` or no intent
 * runs in the project folder. Desktop tasks carry their choice from the
 * renderer, and agents, schedules, webhooks and resumed sessions pass none,
 * so the default never applies to them.
 */
export function creationIntent(worktree, settings) {
  if (worktree?.mode === 'worktree') {
    return { name: worktree.name ?? null, confirmLarge: false, explicit: true, sessionId: null, txId: null };
  }
  return worktree?.mode === 'default' && settings.newTaskDefault === 'worktree'
    ? { name: null, confirmLarge: false, explicit: false, sessionId: null, txId: null }
    : null;
}

/**
 * @param {object} deps `initial` (creationIntent), the session view, the
 *   transition runner, `runPendingSetup` and the host's session hooks.
 */
export function createWorktreeIntents({
  initial,
  getSession,
  getReservedSessionId,
  ensureSession,
  currentWorkspace,
  backend,
  transition,
  runTransition,
  runPendingSetup,
  newTxId,
}) {
  let pendingIntent = initial;

  /** The pending worktree intent that applies to `session`'s next turn, if any. */
  function intentFor(session) {
    const intent = pendingIntent;
    if (!intent) return null;
    if (isWorktreeBound(readSessionWorkspace(session))) {
      pendingIntent = null;
      return null;
    }
    if (intent.sessionId) return intent.sessionId === session.id ? intent : null;
    // A creation-time intent belongs to a new task: never to a resumed
    // conversation this runtime opened instead.
    const started =
      sessionHasConversationMessages(session) || sessionHasConversationMessages({ messages: session.liveTurnMessages });
    return started ? null : intent;
  }

  /**
   * Create and enter the worktree `intent` asks for now: its txId is fixed on
   * first use (`submissionId`, else a fresh one) so a retry reuses the same
   * worktree, and the prompt text names an unnamed one. A settled intent is
   * consumed.
   */
  async function provisionIntent(session, intent, submissionId, prompt, options) {
    intent.txId ||= String(submissionId || '').trim() || newTxId();
    const result = await transition(
      session,
      { kind: 'worktree', name: intent.name },
      { txId: intent.txId, nameHint: promptContentText(prompt), confirmLarge: intent.confirmLarge, ...options }
    );
    if (pendingIntent === intent) pendingIntent = null;
    return result;
  }

  /**
   * Turn-start workspace gate, run after the session exists and before the
   * user row, the review snapshot, hooks, the provider and any worker spawn.
   * A session in recovery refuses the turn; a pending worktree intent is
   * provisioned now (txId = the first submission id, reused by retries; an
   * unnamed worktree takes its slug from the first message).
   */
  async function prepareTurnWorkspace({ submissionId = '', prompt = '', signal, confirmLarge = false } = {}) {
    const session = getSession();
    if (!session?.id) return null;
    const stored = readSessionWorkspace(session);
    if (stored?.transition.state === 'recovery') {
      throw worktreeError(
        'WORKTREE_MISSING',
        'The worktree for this session no longer exists; pick a branch or remove the worktree to continue.',
        { worktreeId: stored.worktreeId, path: stored.cwd }
      );
    }
    const intent = intentFor(session);
    let result = null;
    if (intent) {
      try {
        result = await provisionIntent(session, intent, submissionId, prompt, {
          confirmLarge: intent.confirmLarge || confirmLarge === true,
          signal,
          ownTurn: true,
        });
      } catch (error) {
        // The settings default never blocks a task outside a git repository.
        if (!intent.explicit && isWorktreeError(error, 'WORKTREE_UNSUPPORTED_REPO')) {
          if (pendingIntent === intent) pendingIntent = null;
          return null;
        }
        throw error;
      }
    }
    await runPendingSetup(session, signal);
    return result;
  }

  /**
   * "워크트리": re-enter the retained worktree now, or arm the lazy creation
   * for the next message (confirmLarge acknowledges WORKTREE_LARGE_REPO_CONFIRM).
   *
   * `provision` (a New Task's first send, before its prompt is submitted)
   * creates and enters the worktree right away instead: `prompt` names it
   * like the lazy path would and `txId` (the submission id) makes a resend
   * reuse it. Typed failures (large repository, disk, busy) therefore reach
   * the sender while its draft is still unsent, and the turn that follows
   * finds the session already bound.
   *
   * A provisioning that creates a new worktree decides the project folder's
   * uncommitted changes (tracked and untracked): none → it proceeds; without
   * `carryChanges` it refuses with WORKTREE_DIRTY_CHOICE (`details.count`);
   * `leave` starts the worktree at HEAD and leaves them; `carry` moves them
   * into it (the result's `changes` reports which). Re-entering a retained
   * worktree never touches them.
   *
   * `ownTurn` (internal: the Lead's own tool call) tolerates the calling turn.
   */
  async function requestWorktree(
    {
      name = null,
      confirmLarge = false,
      provision = false,
      carryChanges,
      prompt = '',
      txId = '',
      expectedRevision,
    } = {},
    { ownTurn = false } = {}
  ) {
    const nameHint = validName(name);
    const expected = validRevision(expectedRevision);
    if (carryChanges !== undefined && carryChanges !== null && !WORKTREE_CARRY_CHOICES.includes(carryChanges)) {
      throw new TypeError(`carryChanges must be one of ${WORKTREE_CARRY_CHOICES.join(', ')}.`);
    }
    const session = provision === true ? await ensureSession() : getSession();
    // No session yet: the menu it was read from had revision 0.
    const current = session?.id ? currentWorkspace(session) : null;
    assertRevision(current?.revision ?? 0, expected);
    if (current) {
      if (isWorktreeBound(current)) return { revision: current.revision, workspace: current, pending: false };
      if (await (await backend()).getSessionWorktree(session.id)) {
        const entered = await runTransition(
          { sessionId: session.id },
          { kind: 'worktree' },
          { expectedRevision: expected },
          { ownTurn }
        );
        return { ...entered, pending: false };
      }
    }
    const priorIntent = pendingIntent;
    pendingIntent = {
      name: nameHint ?? pendingIntent?.name ?? null,
      confirmLarge: confirmLarge === true || pendingIntent?.confirmLarge === true,
      explicit: true,
      sessionId: session?.id || getReservedSessionId?.() || null,
      txId: pendingIntent?.txId ?? null,
    };
    if (provision === true) {
      const intent = pendingIntent;
      try {
        return {
          ...(await provisionIntent(session, intent, txId, prompt, {
            expectedRevision: expected,
            changes: carryChanges ?? 'ask',
            ownTurn: ownTurn === true,
          })),
          pending: false,
        };
      } catch (error) {
        // A refused move (uncommitted changes to decide, busy, …) is never
        // re-armed for the next turn, where nobody could answer it.
        if (pendingIntent === intent) pendingIntent = priorIntent;
        throw error;
      }
    }
    const workspace = session?.id ? currentWorkspace(session) : null;
    return { revision: workspace?.revision ?? 0, workspace, pending: true };
  }

  /**
   * Run in `branch`'s checkout (see enterProjectBranch); a selected branch
   * settles the session's location, so no worktree intent stays armed.
   * `ownTurn` (internal: the Lead's own tool call) tolerates the calling turn.
   */
  async function selectBranch(
    { branch, create = false, expectedRevision, confirmLarge = false, txId = '' } = {},
    { ownTurn = false } = {}
  ) {
    const session = await ensureSession();
    const current = currentWorkspace(session);
    if (current.branch === branch && current.worktreeId) {
      assertRevision(current.revision, validRevision(expectedRevision));
      pendingIntent = null;
      return { revision: current.revision, workspace: current };
    }
    const target = { kind: 'branch', branch, create: create === true };
    const result = await runTransition(
      { sessionId: session.id },
      target,
      { expectedRevision, confirmLarge },
      { ownTurn, txId: String(txId || '').trim() }
    );
    pendingIntent = null;
    return result;
  }

  return {
    prepareTurnWorkspace,
    requestWorktree,
    selectBranch,
    /** What the branch menu shows of the armed intent (null: none). */
    pendingWorktree: () => (pendingIntent ? { name: pendingIntent.name } : null),
  };
}
