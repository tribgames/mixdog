/**
 * Field coercion shared by every cold-catalog projection (summary rows, pool
 * rows, transcript reads): the numeric/string normalization and the desktop
 * session-classification shape. Pure, leaf, no IO.
 */
export function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The durable session-id grammar every catalog path accepts. */
export function isStoredSessionId(value) {
  return SESSION_ID_RE.test(value);
}

export function cleanValue(value) {
  return String(value || '').trim();
}

const textOrNull = (value) => cleanValue(typeof value === 'string' ? value : '') || null;
const TRANSITION_STATES = new Set(['idle', 'provisioning', 'switching', 'removing', 'recovery']);

/** Catalog view of a session workspace record (the SessionWorkspace shape of
 *  runtime/shared/worktrees/contract.mjs): where it executes (`cwd`, `branch`,
 *  `worktreeId`) under which registered Project (`projectPath`), at which
 *  `revision`. Null when the record is absent or lacks either path, so
 *  consumers group by `projectPath` and never mistake a worktree `cwd` for
 *  the project. */
export function workspaceSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const projectPath = cleanValue(typeof value.projectPath === 'string' ? value.projectPath : '');
  const cwd = cleanValue(typeof value.cwd === 'string' ? value.cwd : '');
  if (!projectPath || !cwd || projectPath.includes('\0') || cwd.includes('\0')) return null;
  const state = TRANSITION_STATES.has(value.transition?.state) ? value.transition.state : 'idle';
  const txId = state === 'idle' ? null : textOrNull(value.transition?.txId);
  return {
    projectPath,
    repoCommonDir: textOrNull(value.repoCommonDir),
    cwd,
    worktreeId: textOrNull(value.worktreeId),
    branch: textOrNull(value.branch),
    baseCommit: textOrNull(value.baseCommit),
    mergeTarget: textOrNull(value.mergeTarget),
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    transition: txId ? { state, txId } : { state: 'idle', txId: null },
  };
}

/** Dedupe key of an imported conversation: a session's `importOrigin.key`,
 *  or a summary row's projected `importKey`; null for ordinary sessions. */
export function inheritedFromSessionId(value) {
  const id = typeof value?.inheritedFromSessionId === 'string' ? value.inheritedFromSessionId.trim() : '';
  return id || null;
}

/** Count of real human turns a session persisted (actual user instructions
 *  plus compact summaries, which stand for earlier human turns); null for a
 *  row written before the field existed. */
export function realTurnCount(value) {
  const count = value?.realTurnCount;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

/** How many compactions a session has had (`compaction.compactCount`): each
 *  one trims the live messages and so restarts their numbering (the unread
 *  cursors count them). Null for a value without it, e.g. a row written
 *  before the field existed. */
export function compactCount(value) {
  const count = value?.compactCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** `{ compactCount }` for a row that carries one, else nothing. */
export function compactCountField(value) {
  const count = compactCount(value);
  return count === null ? {} : { compactCount: count };
}

export function importKey(value) {
  const key = typeof value?.importKey === 'string' ? value.importKey : value?.importOrigin?.key;
  return typeof key === 'string' && key.trim() ? key : null;
}

export function desktopSession(value, cwd = '') {
  if (!value || typeof value !== 'object') return null;
  if (value.classification === 'task') return { classification: 'task', projectPath: null };
  if (value.classification !== 'project') return null;
  const projectPath =
    typeof value.projectPath === 'string' && value.projectPath.trim()
      ? value.projectPath.trim()
      : String(cwd || '').trim();
  return projectPath ? { classification: 'project', projectPath } : null;
}
