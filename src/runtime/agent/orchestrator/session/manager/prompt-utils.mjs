// Prompt content + temporal helpers. Pure string/date utilities with no
// session state.
import { isInternalRuntimeNotificationText as contractIsInternalRuntimeNotificationText } from '../../../../shared/tool-execution-contract.mjs';
import { formatLocalAndUtcTimestamp } from '../../../../shared/time-format.mjs';
import { SUMMARY_PREFIX } from '../compact.mjs';
import { isProtectedContextUserMessage } from '../compact/messages.mjs';
import { attachmentTextForPart, isAttachmentReference } from '../../../../attachments/store.mjs';
import { samePath } from '../../../../shared/worktrees/paths.mjs';

export function promptContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return isAttachmentReference(part) ? attachmentTextForPart(part) : part.text || '';
        if (part?.type === 'image') return '[Image]';
        return part?.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

export function hasModelVisiblePromptContent(prompt) {
  return !!promptContentText(prompt).trim();
}

export function promptContentBytes(content) {
  try {
    if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
    return Buffer.byteLength(JSON.stringify(content), 'utf8');
  } catch {
    return Buffer.byteLength(promptContentText(content), 'utf8');
  }
}

export function prefixUserTurnContent(content, contextBlock) {
  if (!contextBlock) return content;
  if (Array.isArray(content)) {
    return [{ type: 'text', text: `${contextBlock}# Task\n` }, ...content];
  }
  return `${contextBlock}# Task\n${content}`;
}

// Per-turn <system-reminder> blocks (current time, deferred-tool delta, Goal
// state) trail the human's words instead of leading them: the user's own
// language is then the last thing the model reads before answering, and the
// English reminder text no longer sits at the head of the turn where it pulls
// the pre-tool preamble toward English.
export function suffixUserTurnReminders(content, reminderBlock) {
  if (!reminderBlock) return content;
  if (Array.isArray(content)) {
    return [...content, { type: 'text', text: `\n\n${reminderBlock}` }];
  }
  return `${content}\n\n${reminderBlock}`;
}

function temporalPromptText(content) {
  const text = promptContentText(content).replace(/\s+/g, ' ').trim().toLowerCase();
  return text;
}

function promptNeedsDateReminder(content) {
  const text = temporalPromptText(content);
  if (!text) return false;
  return /(?:\uC624\uB298|\uB0B4\uC77C|\uC5B4\uC81C|\uBAA8\uB808|\uADF8\uC800\uAED8|\uC694\uC998|\uCD5C\uADFC|\uBC29\uAE08|\uC544\uAE4C|\uD604\uC7AC\s*(?:\uB0A0\uC9DC|\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04|\uB0A0\uC9DC|\uC694\uC77C)|\uBA87\s*\uC6D4\s*\uBA87\s*\uC77C|\uBA87\s*\uC2DC|\uBB34\uC2A8\s*\uC694\uC77C|\uC694\uC77C|\uB0A0\uC9DC|\uC774\uBC88\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC9C0\uB09C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uB2E4\uC74C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC62C\uD574|\uC791\uB144|\uB0B4\uB144|today|tomorrow|yesterday|recently|current\s+(?:date|time)|what\s+(?:date|time)|which\s+day|weekday|this\s+(?:week|month|year)|last\s+(?:week|month|year)|next\s+(?:week|month|year))/i.test(
    text
  );
}

function promptNeedsTimeReminder(content) {
  const text = temporalPromptText(content);
  if (!text) return false;
  return /(?:\uD604\uC7AC\s*(?:\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04)|\uBA87\s*\uC2DC|\uC2DC\uAC01|\uC2DC\uAC04|current\s+time|what\s+time|time\s+is\s+it)/i.test(
    text
  );
}

export function buildCurrentTimeBlock(content) {
  const needsTime = promptNeedsTimeReminder(content);
  if (!needsTime && !promptNeedsDateReminder(content)) return '';
  return formatLocalAndUtcTimestamp(new Date());
}

function sessionModelDisplay(model) {
  const text = String(model || '').trim();
  if (!text) return '';
  return text
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/(?:^|-)([a-z])/g, (m) => m.toUpperCase());
}

function buildSessionStartBlock(session, cwd) {
  if (!session || session.owner === 'agent') return '';
  const lines = ['# Session'];
  const effectiveCwd = String(cwd || session.cwd || '').trim();
  if (effectiveCwd) lines.push(`Cwd: ${effectiveCwd}`);
  // Effort and fast mode stay out of the prompt: they change mid-session, and
  // rewriting this block re-sends the whole conversation uncached (and, on
  // bound-thinking models, invalidates earlier thinking blocks). A model
  // change already resets the provider state.
  const model = sessionModelDisplay(session.model);
  if (model) lines.push(`Model: ${model}`);
  // The active workflow already leads the BP3 core (`# Active Workflow: …`),
  // so it is not repeated here.
  return lines.length > 1 ? lines.join('\n') : '';
}

const BP3_PART_SEPARATOR = '\n\n---\n\n';

function systemMessageWithTier(session, cacheTier) {
  return (
    (Array.isArray(session?.messages) ? session.messages : []).find(
      (message) => message?.role === 'system' && message.cacheTier === cacheTier
    ) || null
  );
}

function bp3SystemMessage(session) {
  return systemMessageWithTier(session, 'tier3');
}

function bpEnvSystemMessage(session) {
  return systemMessageWithTier(session, 'env');
}

function joinBp3Parts(parts) {
  return parts
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join(BP3_PART_SEPARATOR);
}

function replaceSystemMessageContent(session, target, content) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const index = messages.indexOf(target);
  if (index < 0) return false;
  // Identical content keeps the same message object, so an unchanged
  // refresh never looks like a prefix edit.
  if (target.content === content) return true;
  messages[index] = { ...target, content };
  return true;
}

export function refreshSessionBp3Environment(session, requestedCwd) {
  // A staged workspace change (see stageWorkspaceReroot) keeps the system
  // prompt rooted where it was until the next re-root: the `# Session` Cwd
  // stays the rooted one, the change reaches the model as a tail notice.
  const cwd = session?.workspaceReroot?.rootCwd || requestedCwd;
  // Split layout (bp3EnvSplit): the volatile environment lives in its own
  // UNMARKED cacheTier:'env' system block; the tier3 core block is never
  // rewritten, so the refresh cannot invalidate the BP3 cache write.
  if (session?.bp3EnvSplit === true) {
    if (typeof session?.bp3EnvironmentContext !== 'string') return false;
    const sessionBlock = buildSessionStartBlock(session, cwd);
    const content = joinBp3Parts([sessionBlock, session.bp3EnvironmentContext]);
    const target = bpEnvSystemMessage(session);
    if (!target) {
      if (!content) {
        session.sessionStartMetaInjected = true;
        return true;
      }
      if (!Array.isArray(session.messages)) session.messages = [];
      const messages = session.messages;
      let insertAt = 0;
      while (insertAt < messages.length && messages[insertAt]?.role === 'system') insertAt += 1;
      messages.splice(insertAt, 0, { role: 'system', content, cacheTier: 'env' });
    } else {
      // Session-store delta saves treat stable message references as an
      // append-only prefix. Replace, never mutate, so a refreshed env
      // forces the required full snapshot and keeps its prefix guard in sync.
      replaceSystemMessageContent(session, target, content);
    }
    session.sessionStartMetaInjected = true;
    return true;
  }
  // Legacy combined layout: core + environment share the tier3 block.
  const target = bp3SystemMessage(session);
  if (!target || typeof session?.bp3CoreContext !== 'string') return false;
  const sessionBlock = buildSessionStartBlock(session, cwd);
  replaceSystemMessageContent(
    session,
    target,
    joinBp3Parts([session.bp3CoreContext, sessionBlock, session.bp3EnvironmentContext])
  );
  session.sessionStartMetaInjected = true;
  return true;
}

const CORE_MEMORY_HEADING = '# Core Memory\n';
const INSTRUCTION_FILES_HEADING = '# Instruction Files';

function trimmedSlice(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Where a heading-led slice starts in a BP3 join: `cut` ends the text before
// it (separator included), `start` is the slice's first character.
function bp3SliceAt(text, heading) {
  if (text.startsWith(heading)) return { cut: 0, start: 0 };
  const at = text.indexOf(`${BP3_PART_SEPARATOR}${heading}`);
  return at < 0 ? null : { cut: at, start: at + BP3_PART_SEPARATOR.length };
}

/**
 * Replace the workspace-scoped tail of a BP3 core (composeSystemPrompt order:
 * …, `# Core Memory`, `# Instruction Files`). The instruction-files slice is
 * always last and may itself contain separators, so it is cut by position;
 * the core-memory slice is one separator-free part. `undefined` keeps a slice,
 * an empty string drops it.
 * @param {string} core
 * @param {{ coreMemoryContext?: string, instructionFilesContext?: string }} slices
 */
export function replaceWorkspaceCoreSlices(core, { coreMemoryContext, instructionFilesContext } = {}) {
  let head = String(core || '');
  let instructionFiles = '';
  const instructionAt = bp3SliceAt(head, INSTRUCTION_FILES_HEADING);
  if (instructionAt) {
    instructionFiles = head.slice(instructionAt.start);
    head = head.slice(0, instructionAt.cut);
  }
  let parts = head ? head.split(BP3_PART_SEPARATOR) : [];
  if (coreMemoryContext !== undefined) {
    parts = parts.filter((part) => !part.startsWith(CORE_MEMORY_HEADING));
    const memory = trimmedSlice(coreMemoryContext);
    if (memory) parts.push(`${CORE_MEMORY_HEADING}${memory}`);
  }
  if (instructionFilesContext !== undefined) instructionFiles = trimmedSlice(instructionFilesContext);
  return [...parts, instructionFiles].filter((part) => part?.trim()).join(BP3_PART_SEPARATOR);
}

/**
 * Replace the shell/project facts that lead the persisted environment tail
 * (`- Cwd …`, shell tools, git state, cwd listing); the trailing response
 * language block is kept. `undefined` keeps the facts.
 */
export function replaceWorkspaceEnvironment(environmentTail, environmentContext) {
  if (environmentContext === undefined) return environmentTail;
  const parts = typeof environmentTail === 'string' && environmentTail ? environmentTail.split(BP3_PART_SEPARATOR) : [];
  const facts = trimmedSlice(environmentContext);
  if (parts[0]?.startsWith('- ')) parts[0] = facts;
  else parts.unshift(facts);
  return parts.filter((part) => part?.trim()).join(BP3_PART_SEPARATOR);
}

/**
 * Re-root a session's prompt at a workspace in place: environment facts,
 * project memory and instruction files are replaced (never appended), then
 * the `# Session` block is rebuilt for `cwd`. Messages are replaced, not
 * mutated, so delta saves write a full snapshot.
 */
function rerootSessionWorkspace(session, { cwd, environmentContext, coreMemoryContext, instructionFilesContext }) {
  if (typeof session.bp3EnvironmentContext === 'string') {
    session.bp3EnvironmentContext = replaceWorkspaceEnvironment(session.bp3EnvironmentContext, environmentContext);
  }
  const slices = { coreMemoryContext, instructionFilesContext };
  if (session.bp3EnvSplit === true) {
    const target = bp3SystemMessage(session);
    if (target && typeof target.content === 'string') {
      const nextCore = replaceWorkspaceCoreSlices(target.content, slices);
      replaceSystemMessageContent(session, target, nextCore);
      session.bp3CoreContext = nextCore;
    }
  } else if (typeof session.bp3CoreContext === 'string') {
    // Legacy combined layout: refreshSessionBp3Environment rebuilds the tier3
    // block from the core plus the environment below.
    session.bp3CoreContext = replaceWorkspaceCoreSlices(session.bp3CoreContext, slices);
  }
  return refreshSessionBp3Environment(session, cwd);
}

const SESSION_BLOCK_CWD_RE = /(?:^|\n)# Session\nCwd: ([^\n]+)/;
const WORKER_ENV_CWD_RE = /(?:^|\n)- Cwd: ([^\n]+?) — the active Project root/;

function textOf(message) {
  return typeof message?.content === 'string' ? message.content : '';
}

/**
 * The workspace the session's system prompt currently presents: its Cwd and
 * the environment facts, project memory and instruction-files slices, read
 * back from the blocks refreshSessionBp3Environment/composeSystemPrompt wrote.
 */
function presentedWorkspace(session) {
  const core = session.bp3EnvSplit === true ? textOf(bp3SystemMessage(session)) : String(session.bp3CoreContext || '');
  const instructionAt = bp3SliceAt(core, INSTRUCTION_FILES_HEADING);
  const head = instructionAt ? core.slice(0, instructionAt.cut) : core;
  const memory = (head ? head.split(BP3_PART_SEPARATOR) : []).find((part) => part.startsWith(CORE_MEMORY_HEADING));
  const tail = typeof session.bp3EnvironmentContext === 'string' ? session.bp3EnvironmentContext : '';
  const facts = tail.split(BP3_PART_SEPARATOR)[0] || '';
  const promptText = [textOf(bpEnvSystemMessage(session)), textOf(bp3SystemMessage(session))].join('\n');
  const cwd = promptText.match(SESSION_BLOCK_CWD_RE)?.[1] || facts.match(WORKER_ENV_CWD_RE)?.[1] || null;
  return {
    cwd: cwd ? cwd.trim() : null,
    environmentContext: facts.startsWith('- ') ? facts.trim() : '',
    coreMemoryContext: memory ? memory.slice(CORE_MEMORY_HEADING.length).trim() : '',
    instructionFilesContext: instructionAt ? core.slice(instructionAt.start).trim() : '',
  };
}

const WORKSPACE_SLICES = ['environmentContext', 'coreMemoryContext', 'instructionFilesContext'];

/**
 * A workspace change of a session that already has a conversation: the
 * system prompt stays byte-identical (provider prompt cache intact) and the
 * change is staged on `session.workspaceReroot`:
 *   rootCwd — the Cwd the system prompt stays rooted at;
 *   seen    — what the model has been told (the prompt, then acknowledged notices);
 *   target  — the current workspace, applied to the prompt at the next re-root
 *             (compaction, a route change, a cleared conversation).
 * `undefined` slices keep what is there. The state object is replaced, never
 * mutated, so a transaction snapshot of the field restores it exactly.
 */
function stageWorkspaceReroot(session, context) {
  const prior = session.workspaceReroot;
  const seen = prior ? prior.seen : presentedWorkspace(session);
  const target = { ...(prior ? prior.target : {}), cwd: String(context.cwd || '').trim() };
  for (const slice of WORKSPACE_SLICES) {
    if (context[slice] !== undefined) target[slice] = trimmedSlice(context[slice]);
  }
  // The move into a worktree belongs to this change only; a later one drops it.
  delete target.move;
  const from = String(context.move?.from || '').trim();
  if (from) target.move = { from, changes: context.move.changes ?? null };
  session.workspaceReroot = {
    version: 1,
    revision: (Number(prior?.revision) || 0) + 1,
    rootCwd: prior ? prior.rootCwd : seen.cwd,
    seen,
    target,
  };
  return true;
}

/**
 * Re-root an existing session's prompt at a new workspace. A session without
 * a conversation is re-rooted in place (no cache to keep); one with a
 * conversation keeps its system messages untouched and stages the change
 * (stageWorkspaceReroot): the model learns it from the tail notice of its
 * next user turn (snapshotPendingWorkspaceNotice), and the next re-root
 * (applyPendingWorkspaceReroot) rewrites the prompt.
 * `move` ({ from, changes: 'carried'|'left'|null }: the session left the
 * project folder `from` for a worktree) adds to the notice what happened to
 * the uncommitted changes and that paths under `from` now resolve under `cwd`.
 * @param {object} session
 * @param {{ cwd: string, environmentContext?: string, coreMemoryContext?: string, instructionFilesContext?: string, move?: { from: string, changes?: 'carried'|'left'|null } }} context
 * @returns {boolean}
 */
export function refreshSessionWorkspaceContext(session, context = {}) {
  if (!session) return false;
  if (hasUserConversationMessage(session.messages)) return stageWorkspaceReroot(session, context);
  applyPendingWorkspaceReroot(session);
  return rerootSessionWorkspace(session, context);
}

/**
 * Give `stored` (the canonical transcript) the system prefix of `messages`
 * (a running turn's working array built on it), message objects included.
 */
export function syncSystemPrefix(stored, messages) {
  const systemCount = (list) => {
    let count = 0;
    while (count < list.length && list[count]?.role === 'system') count += 1;
    return count;
  };
  stored.splice(0, systemCount(stored), ...messages.slice(0, systemCount(messages)));
}

/**
 * Apply a staged workspace change to the system prompt (the session's own
 * messages, plus `messages` when a running turn works on another array whose
 * system prefix is the session's) and drop the staged state: the prompt now
 * presents the current workspace, so no notice is due any more.
 * @returns {boolean} whether a staged change was applied
 */
export function applyPendingWorkspaceReroot(session, messages = session?.messages) {
  const pending = session?.workspaceReroot;
  if (!pending) return false;
  delete session.workspaceReroot;
  const stored = session.messages;
  const other = Array.isArray(messages) && messages !== stored;
  if (other) session.messages = messages;
  try {
    rerootSessionWorkspace(session, pending.target);
  } finally {
    if (other) session.messages = stored;
  }
  if (other && Array.isArray(stored)) syncSystemPrefix(stored, messages);
  return true;
}

function sameWorkspacePath(left, right) {
  return !!left && !!right && samePath(left, right);
}

/** The lines a move from the project folder into a worktree adds to the notice. */
function workspaceMoveLines(move, cwd) {
  if (!move?.from || sameWorkspacePath(move.from, cwd)) return [];
  let changes = '';
  if (move.changes === 'carried') {
    changes =
      'Uncommitted changes were moved into the worktree; ignored files (dependencies, build output, env files) were not.';
  } else if (move.changes === 'left') {
    changes = `Uncommitted changes were left in ${move.from}; they are not present here.`;
  }
  return [
    changes,
    `For continued work, substitute ${cwd} for the project root ${move.from} in paths mentioned earlier; absolute paths are not remapped automatically. Re-read affected files before editing them.`,
  ].filter(Boolean);
}

function workspaceNoticeContent({ seen, target }) {
  if (!target?.cwd || sameWorkspacePath(seen?.cwd, target.cwd)) return '';
  const changed = (slice) => target[slice] !== undefined && target[slice] !== (seen?.[slice] || '');
  const sections = [
    [
      '# Working Folder Changed',
      `The working folder is now ${target.cwd}. This replaces the Cwd and environment facts given earlier in this conversation; relative paths and shell commands resolve here.`,
      'Keep the conversation goals and decisions, but treat earlier file contents, search results and Git observations as historical, not as evidence of this checkout. Check the target project instructions and Git status, and re-read the files needed for the next edit before continuing. A folder change alone does not transfer uncommitted changes.',
      ...workspaceMoveLines(target.move, target.cwd),
      changed('environmentContext') ? target.environmentContext : '',
    ]
      .filter(Boolean)
      .join('\n'),
  ];
  if (changed('instructionFilesContext')) {
    sections.push(
      target.instructionFilesContext
        ? `The instruction files below replace all previously provided instruction files.\n\n${target.instructionFilesContext}`
        : 'The new working folder has no instruction files: the previously provided instruction files no longer apply.'
    );
  }
  if (changed('coreMemoryContext')) {
    sections.push(
      target.coreMemoryContext
        ? `The core memory below replaces all previously provided core memory.\n\n${CORE_MEMORY_HEADING}${target.coreMemoryContext}`
        : 'The new working folder has no core memory: the previously provided core memory no longer applies.'
    );
  }
  return `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`;
}

/**
 * The workspace notice the next user turn carries, or null: nothing when the
 * folder did not change from what the model was told, and only the slices
 * that changed. Lifecycle mirrors deferred-tool-delta.mjs (snapshot → acknowledge
 * when the provider accepted the turn), so a failed turn re-sends it.
 * @returns {{ revision: number, content: string } | null}
 */
export function snapshotPendingWorkspaceNotice(session) {
  const pending = session?.workspaceReroot;
  if (!pending) return null;
  const content = workspaceNoticeContent(pending);
  return content ? { revision: pending.revision, content } : null;
}

/**
 * The report of a new worktree's preparation (session.pendingSetupNotice, set
 * by the first turn's workspace gate) for this turn, or null. Acknowledged
 * when the provider accepted the turn, like the workspace notice.
 * @returns {{ revision: number, content: string } | null}
 */
export function snapshotPendingSetupNotice(session) {
  const pending = session?.pendingSetupNotice;
  return typeof pending?.content === 'string' && pending.content
    ? { revision: pending.revision, content: pending.content }
    : null;
}

export function acknowledgePendingSetupNotice(session, revision) {
  if (session?.pendingSetupNotice?.revision !== revision) return false;
  delete session.pendingSetupNotice;
  return true;
}

/** The notice of `revision` reached the model: what it was told is now the target. */
export function acknowledgePendingWorkspaceNotice(session, revision) {
  const pending = session?.workspaceReroot;
  if (!pending || pending.revision !== Number(revision)) return false;
  const seen = { ...pending.seen, cwd: pending.target.cwd };
  for (const slice of WORKSPACE_SLICES) {
    if (pending.target[slice] !== undefined) seen[slice] = pending.target[slice];
  }
  session.workspaceReroot = { ...pending, seen };
  return true;
}

export function resetSessionBp3Environment(session) {
  // A cleared conversation has no cache to keep: the prompt re-roots now.
  applyPendingWorkspaceReroot(session);
  if (session?.bp3EnvSplit === true) {
    const target = bpEnvSystemMessage(session);
    if (!target || typeof session?.bp3EnvironmentContext !== 'string') return false;
    replaceSystemMessageContent(session, target, session.bp3EnvironmentContext.trim());
    session.sessionStartMetaInjected = false;
    return true;
  }
  const target = bp3SystemMessage(session);
  if (!target || typeof session?.bp3CoreContext !== 'string') return false;
  replaceSystemMessageContent(session, target, joinBp3Parts([session.bp3CoreContext, session.bp3EnvironmentContext]));
  session.sessionStartMetaInjected = false;
  return true;
}

function isReferenceFilesMessage(message) {
  return (
    message?.role === 'user' &&
    typeof message.content === 'string' &&
    /^Reference files:\s*/i.test(message.content.trimStart())
  );
}

export { isProtectedContextUserMessage };

// Compact summary messages (role:'user', content startsWith SUMMARY_PREFIX)
// are synthetic anchors, not a real human turn — they must not count as
// "user conversation" or the post-clear/post-compact session-start block
// would be wrongly suppressed on the next real user turn.
export function isSummaryAnchorMessage(message) {
  return message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX);
}

export function hasUserConversationMessage(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (message) =>
      message?.role === 'user' &&
      !isProtectedContextUserMessage(message) &&
      !isReferenceFilesMessage(message) &&
      !isSummaryAnchorMessage(message)
  );
}

export function isInternalRuntimeNotificationText(content) {
  return contractIsInternalRuntimeNotificationText(promptContentText(content));
}
