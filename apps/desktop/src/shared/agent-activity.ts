type AgentRecord = Record<string, unknown>;

const DESKTOP_TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

const DESKTOP_ACTIVE_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|resource_wait)$/i;
const DESKTOP_QUEUED_AGENT_STATUS = /^(?:queued|pending|starting|resource_wait)$/i;

/** Cancellation is a THIRD outcome and never a completion. The runtime reports
 *  it in three shapes, and every one of them lands in the generic terminal
 *  bucket above, which also holds idle/done/success — that collapse is what
 *  made a cancelled row read "Completed"/"Idle" in the Agents pane:
 *   - `cancelled`: a settled background agent/shell job (runtime
 *     background-tasks normalizeStatus folds canceled/killed into it),
 *   - `cancelling`: the worker turn is still being torn down (runtime
 *     agent-tool ACTIVE_STAGES still calls this working),
 *   - `cancel-unconfirmed` / `cancel-pending`: the signal was delivered but the
 *     exit could NOT be observed (Windows git-bash survivors answer with
 *     SURVIVING_DESCENDANTS_UNREACHABLE_WARNING). Not a successful cancel.
 *  Cancellation is therefore classified BEFORE the terminal bucket. */
const DESKTOP_CANCELLED_AGENT_STATUS = /cancel|killed|aborted|interrupted/i;
/** A cancel whose stop is NOT proven: still winding down, or delivered to a
 *  process that could not be confirmed gone. It must not read as "Cancelled"
 *  either — the honest answer is that the outcome is unconfirmed. */
const DESKTOP_CANCEL_UNCONFIRMED_STATUS = /cancel[-_\s]?(?:unconfirmed|pending)|cancell?ing/i;

/** A FOURTH outcome beside completion, rest and cancellation: the turn ended
 *  in an error or a timeout, was stopped by the stall watchdog, or its
 *  runtime died under it. All of these land in the generic terminal bucket
 *  too, which is what made such a row read "Completed"/"Idle", so failure is
 *  classified before it — right after cancellation. Only the lifecycle
 *  decides (`status`; `stage` for a row without one): mid-work the copied
 *  runtime stage may briefly say `error` beside a worker that still runs. */
const DESKTOP_FAILED_AGENT_STATUS = /^(?:error|errored|fail|failed|failure|timeout|timed[-_\s]?out)$/i;

/** Why a failed row failed. The runtime stamps `failureReason` on rows it
 *  settles itself (`process-restart`: the process running the turn is gone;
 *  `stalled`: the progress watchdog stopped it); any other failure is the
 *  turn's own `error`. */
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

/** `status` is the worker's lifecycle; `stage` is only the runtime phase the
 *  progress sweep copies in. That phase is read straight off the live runtime,
 *  so mid-work it can briefly say `idle`/`done`/`error` (a fresh or just
 *  settled runtime entry) beside a worker whose status is still `running`.
 *  The status therefore decides alone; the stage decides only for a row that
 *  carries no status. A cancel in either field still ends the row's work. */
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

/** Single lifecycle mapping for every agent surface. Cancellation outranks the
 *  queued/running/done/idle buckets: an entry cancelled WHILE QUEUED still
 *  carries stage `queued`, and one cancelled WHILE RUNNING still carries stage
 *  `running`, so asking the queued/active predicates first would settle both of
 *  them as work in progress or as a completion. Failure comes next, for the
 *  same reason: it is never a completion or a rest. A live turn blocked on the
 *  user's approval needs the user rather than running; one parked on its own
 *  background task is waiting. An inactive parent with unsettled descendant
 *  agents is waiting, even if its last response is unread. */
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

/** The frozen TURN start alone. A snapshot that re-reports a cancelled session
 *  as running may carry a SYNTHESIZED startedAt (the session createdAt) and a
 *  null turnStartedAt, so a turn stamp is the only stamp on that path that can
 *  prove work actually started again. */
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

/** A cancel is the last word about that identity's current work. The pool
 *  publishes rows from a durable index plus the daemon's in-memory running
 *  set, and a session the daemon still runs reads `running` even after the
 *  index dropped its cancelled row — which is exactly what happens right after
 *  a cancel, until the turn unwinds. The ledger keeps such a row cancelled
 *  instead of letting a later snapshot resurrect it as working; only a
 *  genuinely NEWER frozen turn/start stamp
 *  (real new work under the same identity) releases it. */
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
            // An agent cancelled while QUEUED carries no frozen stamp at all.
            // Such a cancellation has a baseline of 0, which ANY later stamp
            // outranks — including a startedAt synthesized from the session
            // record — so it must not be released by a stamp comparison.
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
