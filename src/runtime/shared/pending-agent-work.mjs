// Which Lead sessions still wait on agent work they handed off: the rule the
// desktop turn notifier applies to the agent pool (apps/desktop
// shared/agent-activity.ts isActiveDesktopAgentEntry /
// isCancelUnconfirmedDesktopAgentEntry, main/push-turn-events.ts
// sessionsWithPendingWork), ported for the runtime so a bot's task-session
// report waits for the same final answer the desktop notifies. Pool rows are
// listStoredAgentWorkersAsync rows (`sessionId`, root `ownerSessionId`,
// `status`, `stage`); nested descendants keep the Lead as their owner.

const TERMINAL_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;
const ACTIVE_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|resource_wait)$/i;
const CANCELLED_STATUS = /cancel|killed|aborted|interrupted/i;
const CANCEL_UNCONFIRMED_STATUS = /cancel[-_\s]?(?:unconfirmed|pending)|cancell?ing/i;

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function statusValues(value) {
  const entry = record(value);
  return [entry.stage, entry.status]
    .map((status) => String(status || '').trim())
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
}

/** A running or queued row: `status` decides, `stage` only for a row without one. */
function isActiveAgentRow(value) {
  const statuses = statusValues(value);
  if (statuses.length === 0 || statuses.some((status) => CANCELLED_STATUS.test(status))) return false;
  const lifecycle = String(record(value).status || '').trim() || statuses[0];
  return !TERMINAL_STATUS.test(lifecycle) && ACTIVE_STATUS.test(lifecycle);
}

/** A cancel whose stop is not proven yet. */
function isCancelUnconfirmedAgentRow(value) {
  return statusValues(value).some((status) => CANCEL_UNCONFIRMED_STATUS.test(status));
}

/** Agent work still in flight on one pool row. */
export function hasPendingAgentWork(value) {
  return isActiveAgentRow(value) || isCancelUnconfirmedAgentRow(value);
}

/** The owner (Lead) session ids with a child row still in flight. The Lead's
 *  own row is skipped: its turn state comes from the session itself. */
export function sessionsWithPendingWork(rows) {
  const pending = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = String(row?.sessionId || '');
    const ownerSessionId = String(row?.ownerSessionId || '') || sessionId;
    if (!ownerSessionId || sessionId === ownerSessionId) continue;
    if (hasPendingAgentWork(row)) pending.add(ownerSessionId);
  }
  return pending;
}
