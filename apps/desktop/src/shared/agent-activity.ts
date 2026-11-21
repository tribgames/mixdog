type AgentRecord = Record<string, unknown>;

const DESKTOP_TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

const DESKTOP_ACTIVE_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|resource_wait)$/i;
const DESKTOP_QUEUED_AGENT_STATUS = /^(?:queued|pending|starting|resource_wait)$/i;

/** Runtime cancel shapes: `cancelled` (settled job; canceled/killed folded in),
 *  `cancelling` (turn still being torn down), `cancel-unconfirmed` /
 *  `cancel-pending` (signal delivered, exit not observed: Windows git-bash
 *  survivors, SURVIVING_DESCENDANTS_UNREACHABLE_WARNING). Classified before
 *  the terminal bucket, which would read them as done/idle. */
const DESKTOP_CANCELLED_AGENT_STATUS = /cancel|killed|aborted|interrupted/i;
/** A cancel whose stop is NOT proven: still winding down, or delivered to a
 *  process that could not be confirmed gone. It must not read as "Cancelled"
 *  either — the honest answer is that the outcome is unconfirmed. */
const DESKTOP_CANCEL_UNCONFIRMED_STATUS = /cancel[-_\s]?(?:unconfirmed|pending)|cancell?ing/i;

const DESKTOP_FAILED_AGENT_STATUS = /^(?:error|errored|fail|failed|failure|timeout|timed[-_\s]?out)$/i;

/** The runtime stamps `failureReason` `process-restart` or `stalled` on rows it
 *  settles itself; any other failure is `error`. */
type DesktopAgentFailureReason = 'process-restart' | 'stalled' | 'error';

function record(value: unknown): AgentRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AgentRecord) : {};
}

function statusValues(value: unknown): string[] {
  const entry = record(value);
  return [entry.stage, entry.status]
    .map((status) => String(status || '').trim())
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
}

export function desktopAgentStatus(value: unknown): string {
  return statusValues(value)[0] || '';
}

/** `stage` is a runtime phase copied in by the progress sweep and can briefly
 *  read idle/done/error beside a `running` status, so `status` decides and
 *  `stage` only for a row without one. A cancel in either ends the work. */
export function isActiveDesktopAgentEntry(value: unknown): boolean {
  const statuses = statusValues(value);
  if (statuses.length === 0 || statuses.some((status) => DESKTOP_CANCELLED_AGENT_STATUS.test(status))) return false;
  const lifecycle = String(record(value).status || '').trim() || statuses[0];
  return !DESKTOP_TERMINAL_AGENT_STATUS.test(lifecycle) && DESKTOP_ACTIVE_AGENT_STATUS.test(lifecycle);
}

export function isQueuedDesktopAgentEntry(value: unknown): boolean {
  if (!isActiveDesktopAgentEntry(value)) return false;
  const statuses = statusValues(value);
  return statuses.includes('resource_wait') || statuses.every((status) => DESKTOP_QUEUED_AGENT_STATUS.test(status));
}

export function isCancelledDesktopAgentEntry(value: unknown): boolean {
  return statusValues(value).some((status) => DESKTOP_CANCELLED_AGENT_STATUS.test(status));
}

function isFailedDesktopAgentEntry(value: unknown): boolean {
  const entry = record(value);
  const lifecycle = String(entry.status || '').trim() || String(entry.stage || '').trim();
  return DESKTOP_FAILED_AGENT_STATUS.test(lifecycle);
}

/** The reason of a failed row; '' for a row that did not fail. */
export function desktopAgentFailureReason(value: unknown): DesktopAgentFailureReason | '' {
  if (!isFailedDesktopAgentEntry(value)) return '';
  const reason = String(record(value).failureReason || '').trim();
  return reason === 'process-restart' || reason === 'stalled' ? reason : 'error';
}

export function isCancelUnconfirmedDesktopAgentEntry(value: unknown): boolean {
  return statusValues(value).some((status) => DESKTOP_CANCEL_UNCONFIRMED_STATUS.test(status));
}

/** The runtime stamps `awaitingUser: 'approval'` on a worker/job row while its
 *  turn is blocked on a tool approval only the user can give. */
function isAwaitingApprovalDesktopAgentEntry(value: unknown): boolean {
  return record(value).awaitingUser === 'approval';
}

/** The runtime stamps `awaitingTask` on a row whose agent waits on background
 *  work it handed off: 'wait' while its turn sits in `task wait`, 'background'
 *  while it is idle with such a task still running. */
export function isAwaitingTaskDesktopAgentEntry(value: unknown): boolean {
  const awaiting = record(value).awaitingTask;
  return awaiting === 'wait' || awaiting === 'background';
}

/** Agent work still in flight. A background shell job alone never makes a
 *  PARENT row wait; the agent that owns it reads waiting via `awaitingTask`. */
export function hasPendingDesktopAgentWork(value: unknown): boolean {
  return isActiveDesktopAgentEntry(value) || isCancelUnconfirmedDesktopAgentEntry(value);
}

/** The cancel status itself, not whichever of stage/status happens to come
 *  first: a row cancelled mid-turn still carries stage `running`, so
 *  desktopAgentStatus() would answer "running" for an entry that was stopped. */
export function desktopAgentCancelStatus(value: unknown): string {
  return statusValues(value).find((status) => DESKTOP_CANCELLED_AGENT_STATUS.test(status)) || '';
}

export type DesktopAgentActivityState =
  | 'queued'
  | 'running'
  /** In a turn, but blocked on the user's approval: not working. */
  | 'needs-user'
  | 'waiting'
  | 'cancel-unconfirmed'
  | 'cancelled'
  /** The turn did not finish: error, timeout, watchdog stop, dead runtime. */
  | 'failed'
  | 'done'
  | 'unknown'
  | 'idle';

/** Single lifecycle mapping for every agent surface. Precedence: cancelled
 *  (a cancelled row keeps its queued/running stage), failed, unknown,
 *  needs-user (active and awaiting approval), waiting (`awaitingTask`),
 *  queued, running, waiting (unsettled descendants or pending work), then
 *  done (unread) or idle. */
export function desktopAgentActivityState(
  value: unknown,
  options: { unread?: boolean; waitingForTasks?: boolean } = {}
): DesktopAgentActivityState {
  if (isCancelledDesktopAgentEntry(value)) {
    return isCancelUnconfirmedDesktopAgentEntry(value) ? 'cancel-unconfirmed' : 'cancelled';
  }
  if (isFailedDesktopAgentEntry(value)) return 'failed';
  if (statusValues(value).includes('unknown')) return 'unknown';
  if (isActiveDesktopAgentEntry(value) && isAwaitingApprovalDesktopAgentEntry(value)) return 'needs-user';
  // Parked on its own background work (task wait, or idle with a handed-off
  // task running): waiting, not working and not finished.
  if (isAwaitingTaskDesktopAgentEntry(value)) return 'waiting';
  if (isQueuedDesktopAgentEntry(value)) return 'queued';
  if (isActiveDesktopAgentEntry(value)) return 'running';
  if (options.waitingForTasks === true || hasPendingDesktopAgentWork(value)) return 'waiting';
  // A finished turn reads "Completed" until its reply is seen, then rests.
  return options.unread === true ? 'done' : 'idle';
}

export function desktopAgentIdentity(value: unknown): string {
  const entry = record(value);
  return String(entry.tag || entry.task_id || entry.taskId || '').trim();
}

function stampMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value || '').trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(text) || 0;
}

/** FROZEN work stamps only. `updatedAt` keeps advancing while a row runs, so
 *  it can never prove that new work started. */
function desktopAgentWorkStamp(value: unknown): number {
  const entry = record(value);
  return Math.max(stampMs(entry.turnStartedAt), stampMs(entry.startedAt), stampMs(entry.createdAt));
}

/** A snapshot re-reporting a cancelled session as running can carry a
 *  synthesized startedAt and null turnStartedAt, so only a turn stamp proves
 *  new work. */
function turnStampMs(value: unknown): number {
  return stampMs(record(value).turnStartedAt);
}

function cancellationKey(value: unknown): string {
  const entry = record(value);
  return String(entry.sessionId || '').trim() || desktopAgentIdentity(entry);
}

export interface DesktopAgentCancellationLedger {
  /** Pass rows through, holding every identity that has already reported a
   *  cancel at its cancelled status. */
  apply<T extends AgentRecord>(rows: readonly T[]): T[];
  size(): number;
}

const DESKTOP_CANCELLATION_LEDGER_CAP = 256;

/** Keeps a row cancelled after its identity reported a cancel: the pool can
 *  re-report a session the daemon still runs as `running` until the turn
 *  unwinds. Only a newer frozen turn/start stamp releases it. */
export function createDesktopCancellationLedger(cap = DESKTOP_CANCELLATION_LEDGER_CAP): DesktopAgentCancellationLedger {
  const ledger = new Map<string, { status: string; at: number; stamped: boolean }>();
  return {
    apply<T extends AgentRecord>(rows: readonly T[]): T[] {
      return rows.map((row) => {
        const key = cancellationKey(row);
        if (!key) return row;
        const stamp = desktopAgentWorkStamp(row);
        const remembered = ledger.get(key);
        if (isCancelledDesktopAgentEntry(row)) {
          ledger.delete(key);
          ledger.set(key, {
            status: desktopAgentCancelStatus(row) || 'cancelled',
            at: Math.max(stamp, remembered?.at || 0),
            stamped: stamp > 0 || remembered?.stamped === true,
          });
          while (ledger.size > cap) {
            const oldest = ledger.keys().next().value;
            if (oldest === undefined) break;
            ledger.delete(oldest);
          }
          return row;
        }
        if (!remembered) return row;
        // A stamped cancellation is outranked only by a newer frozen stamp; an
        // unstamped one only by a real TURN start, which the promotion never
        // carries. Either way a stale snapshot cannot resurrect the row.
        const release = remembered.stamped ? stamp : turnStampMs(row);
        if (release > remembered.at) {
          ledger.delete(key);
          return row;
        }
        return { ...row, status: remembered.status, stage: remembered.status } as T;
      });
    },
    size: () => ledger.size,
  };
}
