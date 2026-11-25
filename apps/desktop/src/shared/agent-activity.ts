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

/** Everything the lifecycle predicates read from one row, derived once per
 *  row object: pool rows are immutable snapshots, and every surface asks the
 *  same questions of the same rows on each publication. */
interface DesktopAgentRowFacts {
  /** Distinct non-empty `stage`, `status`, in that order. */
  statuses: readonly string[];
  cancelStatus: string;
  cancelUnconfirmed: boolean;
  active: boolean;
  queued: boolean;
  failureReason: DesktopAgentFailureReason | '';
  awaitingTask: boolean;
  /** The state when it does not depend on the caller's options; null when
   *  waitingForTasks/unread decide it. */
  settled: DesktopAgentActivityState | null;
}

function textOf(value: unknown): string {
  return String(value || '').trim();
}

function deriveRowFacts(value: unknown): DesktopAgentRowFacts {
  const entry = record(value);
  const stage = textOf(entry.stage);
  const status = textOf(entry.status);
  const statuses = [stage, status].filter((text, index, values) => Boolean(text) && values.indexOf(text) === index);
  const cancelStatus = statuses.find((text) => DESKTOP_CANCELLED_AGENT_STATUS.test(text)) || '';
  const cancelUnconfirmed = statuses.some((text) => DESKTOP_CANCEL_UNCONFIRMED_STATUS.test(text));
  // `stage` is a runtime phase copied in by the progress sweep and can briefly
  // read idle/done/error beside a `running` status, so `status` decides and
  // `stage` only for a row without one. A cancel in either ends the work.
  const lifecycle = status || stage;
  const active =
    statuses.length > 0 &&
    !cancelStatus &&
    !DESKTOP_TERMINAL_AGENT_STATUS.test(lifecycle) &&
    DESKTOP_ACTIVE_AGENT_STATUS.test(lifecycle);
  const queued =
    active && (statuses.includes('resource_wait') || statuses.every((text) => DESKTOP_QUEUED_AGENT_STATUS.test(text)));
  const failed = DESKTOP_FAILED_AGENT_STATUS.test(lifecycle);
  const reason = textOf(entry.failureReason);
  const failureReason: DesktopAgentFailureReason | '' = !failed
    ? ''
    : reason === 'process-restart' || reason === 'stalled'
      ? reason
      : 'error';
  // The runtime stamps `awaitingTask` on a row whose agent waits on background
  // work it handed off: 'wait' while its turn sits in `task wait`, 'background'
  // while it is idle with such a task still running; `awaitingUser: 'approval'`
  // while its turn is blocked on a tool approval only the user can give.
  const awaitingTask = entry.awaitingTask === 'wait' || entry.awaitingTask === 'background';
  const awaitingApproval = entry.awaitingUser === 'approval';
  // Precedence: cancelled (a cancelled row keeps its queued/running stage),
  // failed, unknown, needs-user, waiting (`awaitingTask`: parked on its own
  // background work, not working and not finished), queued, running, waiting
  // (pending work); the rest falls to the caller's options.
  let settled: DesktopAgentActivityState | null = null;
  if (cancelStatus) settled = cancelUnconfirmed ? 'cancel-unconfirmed' : 'cancelled';
  else if (failed) settled = 'failed';
  else if (statuses.includes('unknown')) settled = 'unknown';
  else if (active && awaitingApproval) settled = 'needs-user';
  else if (awaitingTask) settled = 'waiting';
  else if (queued) settled = 'queued';
  else if (active) settled = 'running';
  else if (cancelUnconfirmed) settled = 'waiting';
  return { statuses, cancelStatus, cancelUnconfirmed, active, queued, failureReason, awaitingTask, settled };
}

const ROW_FACTS = new WeakMap<object, DesktopAgentRowFacts>();
const NO_ROW_FACTS = deriveRowFacts(undefined);

function rowFacts(value: unknown): DesktopAgentRowFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NO_ROW_FACTS;
  const cached = ROW_FACTS.get(value);
  if (cached) return cached;
  const facts = deriveRowFacts(value);
  ROW_FACTS.set(value, facts);
  return facts;
}

export function desktopAgentStatus(value: unknown): string {
  return rowFacts(value).statuses[0] || '';
}

export function isActiveDesktopAgentEntry(value: unknown): boolean {
  return rowFacts(value).active;
}

export function isQueuedDesktopAgentEntry(value: unknown): boolean {
  return rowFacts(value).queued;
}

export function isCancelledDesktopAgentEntry(value: unknown): boolean {
  return Boolean(rowFacts(value).cancelStatus);
}

/** The reason of a failed row; '' for a row that did not fail. */
export function desktopAgentFailureReason(value: unknown): DesktopAgentFailureReason | '' {
  return rowFacts(value).failureReason;
}

export function isCancelUnconfirmedDesktopAgentEntry(value: unknown): boolean {
  return rowFacts(value).cancelUnconfirmed;
}

export function isAwaitingTaskDesktopAgentEntry(value: unknown): boolean {
  return rowFacts(value).awaitingTask;
}

/** Agent work still in flight. A background shell job alone never makes a
 *  PARENT row wait; the agent that owns it reads waiting via `awaitingTask`. */
export function hasPendingDesktopAgentWork(value: unknown): boolean {
  const facts = rowFacts(value);
  return facts.active || facts.cancelUnconfirmed;
}

/** The cancel status itself, not whichever of stage/status happens to come
 *  first: a row cancelled mid-turn still carries stage `running`, so
 *  desktopAgentStatus() would answer "running" for an entry that was stopped. */
export function desktopAgentCancelStatus(value: unknown): string {
  return rowFacts(value).cancelStatus;
}

/** Single lifecycle mapping for every agent surface (precedence in
 *  deriveRowFacts); a row that settles none of those is waiting while
 *  descendants are unsettled, then done (unread) or idle. */
export function desktopAgentActivityState(
  value: unknown,
  options?: { unread?: boolean; waitingForTasks?: boolean }
): DesktopAgentActivityState {
  const { settled } = rowFacts(value);
  if (settled) return settled;
  if (options?.waitingForTasks === true) return 'waiting';
  // A finished turn reads "Completed" until its reply is seen, then rests.
  return options?.unread === true ? 'done' : 'idle';
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
