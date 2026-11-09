import { clean } from './clean.mjs';
import { positiveInt } from './numbers.mjs';

export const TAG_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// How long a finished agent (completed, failed or cancelled child, or a Lead
// row) stays listed in the Agents pane, measured from its finish stamp. This is
// pane visibility only: session reuse and cache reaping keep their own windows
// (resolveAgentTerminalReapMs).
export const AGENT_PANE_VISIBLE_MS = 60 * 60 * 1000;

/** Whether a row finished at `finishedAtMs` is still inside the pane window.
 *  Index rows are always stamped; a row with no usable stamp has no provable
 *  age and stays listed rather than vanishing on a guess. */
export function agentPaneVisible(finishedAtMs, now) {
  return !(finishedAtMs > 0) || now - finishedAtMs < AGENT_PANE_VISIBLE_MS;
}

export function stampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = clean(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0 && !/^\d{4}-/.test(text)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Stamped as `closeProvenance` on a record by every completed turn, beside
 *  that turn's completion time (`lastTurnCompletedAt`): from that turn on, an
 *  owner close of the session is recorded on the record (`ownerClosedAt`). A
 *  record without it last ran under a build that did not record owner closes,
 *  so its absence proves nothing. */
export const CLOSE_PROVENANCE_VERSION = 1;

/** Whether a reaped tag may continue this stored session: its record carries
 *  close provenance (absent → never; fail closed) and its owner did not close
 *  it (the agent tool's `close`, which keeps the conversation open) after its
 *  last completed turn. Only a turn completed after that close — the owner
 *  reusing it — lifts it; `lastUsedAt` also moves without a turn (a rewind),
 *  so it never counts. */
export function resumableAfterReap(record) {
  if (record?.closeProvenance !== CLOSE_PROVENANCE_VERSION) return false;
  const closedAt = stampMs(record.ownerClosedAt);
  return !(closedAt > 0 && closedAt >= stampMs(record.lastTurnCompletedAt));
}

export function tagTombstoneKey(row = {}) {
  const parent = clean(row.parentSessionId || row.ownerSessionId);
  if (parent) return `session:${parent}\0${clean(row.tag)}`;
  return `${positiveInt(row.clientHostPid) || 0}\0${clean(row.tag)}`;
}

// Keys are built directly (same shape as tagTombstoneKey): this runs once per
// row/session on every scan, and spreading a session-sized row just to
// override its tag copied the whole record per lookup. `tag` must already be
// clean when passed.
export function findTagTombstone(row, tombstones, tag = clean(row.tag || row.agentTag)) {
  const parent = clean(row.parentSessionId || row.ownerSessionId);
  return (
    (parent && tombstones.get(`session:${parent}\0${tag}`)) ||
    tombstones.get(`${positiveInt(row.clientHostPid) || 0}\0${tag}`)
  );
}

export function tombstoneBlocksWork(row, tombstone) {
  const reapedAt = stampMs(tombstone?.reapedAt);
  if (!reapedAt) return false;
  // Saves, checkpoint recovery, and display reads are not new execution.
  return Math.max(stampMs(row.createdAt), stampMs(row.turnStartedAt)) <= reapedAt;
}
