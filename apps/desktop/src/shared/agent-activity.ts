type AgentRecord = Record<string, unknown>;

export const DESKTOP_TERMINAL_AGENT_STATUS =
  /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

const DESKTOP_ACTIVE_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting)$/i;
const DESKTOP_QUEUED_AGENT_STATUS = /^(?:queued|pending|starting)$/i;

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
export const DESKTOP_CANCELLED_AGENT_STATUS = /cancel|killed|aborted|interrupted/i;
/** A cancel whose stop is NOT proven: still winding down, or delivered to a
 *  process that could not be confirmed gone. It must not read as "Cancelled"
 *  either — the honest answer is that the outcome is unconfirmed. */
export const DESKTOP_CANCEL_UNCONFIRMED_STATUS =
  /cancel[-_\s]?(?:unconfirmed|pending)|cancell?ing/i;

function record(value: unknown): AgentRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as AgentRecord
    : {};
}

function statusValues(value: unknown): string[] {
  const entry = record(value);
  return [entry.stage, entry.status]
    .map((status) => String(status || "").trim())
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
}

export function desktopAgentStatus(value: unknown): string {
  return statusValues(value)[0] || "";
}

export function isActiveDesktopAgentEntry(value: unknown): boolean {
  const statuses = statusValues(value);
  return statuses.length > 0
    && !statuses.some((status) => DESKTOP_TERMINAL_AGENT_STATUS.test(status))
    && statuses.some((status) => DESKTOP_ACTIVE_AGENT_STATUS.test(status));
}

export function isQueuedDesktopAgentEntry(value: unknown): boolean {
  const statuses = statusValues(value);
  return isActiveDesktopAgentEntry(value)
    && statuses.every((status) => DESKTOP_QUEUED_AGENT_STATUS.test(status));
}

export function isCancelledDesktopAgentEntry(value: unknown): boolean {
  return statusValues(value).some((status) => DESKTOP_CANCELLED_AGENT_STATUS.test(status));
}

export function isCancelUnconfirmedDesktopAgentEntry(value: unknown): boolean {
  return statusValues(value).some((status) => DESKTOP_CANCEL_UNCONFIRMED_STATUS.test(status));
}

/** The cancel status itself, not whichever of stage/status happens to come
 *  first: a row cancelled mid-turn still carries stage `running`, so
 *  desktopAgentStatus() would answer "running" for an entry that was stopped. */
export function desktopAgentCancelStatus(value: unknown): string {
  return statusValues(value).find((status) => DESKTOP_CANCELLED_AGENT_STATUS.test(status)) || "";
}

export type DesktopAgentActivityState =
  | "queued"
  | "running"
  | "cancel-unconfirmed"
  | "cancelled"
  | "done"
  | "idle";

/** Single lifecycle mapping for every agent surface. Cancellation outranks the
 *  queued/running/done/idle buckets: an entry cancelled WHILE QUEUED still
 *  carries stage `queued`, and one cancelled WHILE RUNNING still carries stage
 *  `running`, so asking the queued/active predicates first would settle both of
 *  them as work in progress or as a completion. */
export function desktopAgentActivityState(
  value: unknown,
  options: { unread?: boolean } = {},
): DesktopAgentActivityState {
  if (isCancelledDesktopAgentEntry(value)) {
    return isCancelUnconfirmedDesktopAgentEntry(value) ? "cancel-unconfirmed" : "cancelled";
  }
  if (isQueuedDesktopAgentEntry(value)) return "queued";
  if (isActiveDesktopAgentEntry(value)) return "running";
  return options.unread === true ? "done" : "idle";
}

export function desktopAgentIdentity(value: unknown): string {
  const entry = record(value);
  return String(entry.tag || entry.task_id || entry.taskId || "").trim();
}

function stampMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value || "").trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(text) || 0;
}

/** FROZEN work stamps only. `updatedAt` is a live heartbeat the pool rewrites
 *  every tick, so it can never prove that new work started. */
export function desktopAgentWorkStamp(value: unknown): number {
  const entry = record(value);
  return Math.max(
    stampMs(entry.turnStartedAt),
    stampMs(entry.startedAt),
    stampMs(entry.createdAt),
  );
}

/** The frozen TURN start alone. The pool's heartbeat promotion re-declares a
 *  session running with a SYNTHESIZED startedAt (session createdAt, or the
 *  heartbeat mtime) and leaves turnStartedAt null, so a turn stamp is the only
 *  stamp on that path that can prove work actually started again. */
function turnStampMs(value: unknown): number {
  return stampMs(record(value).turnStartedAt);
}

function cancellationKey(value: unknown): string {
  const entry = record(value);
  return String(entry.sessionId || "").trim() || desktopAgentIdentity(entry);
}

export interface DesktopAgentCancellationLedger {
  /** Pass rows through, holding every identity that has already reported a
   *  cancel at its cancelled status. */
  apply<T extends AgentRecord>(rows: readonly T[]): T[];
  size(): number;
}

const DESKTOP_CANCELLATION_LEDGER_CAP = 256;

/** A cancel is the last word about that identity's current work. The pool
 *  publishes rows from a durable index PLUS a 2-minute heartbeat sidecar, and
 *  the sidecar promotion re-declares a session `running` whenever the index no
 *  longer carries it — which is exactly what happens right after a cancel. The
 *  ledger keeps such a row cancelled instead of letting a later snapshot
 *  resurrect it as working; only a genuinely NEWER frozen turn/start stamp
 *  (real new work under the same identity) releases it. */
export function createDesktopCancellationLedger(
  cap = DESKTOP_CANCELLATION_LEDGER_CAP,
): DesktopAgentCancellationLedger {
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
            status: desktopAgentCancelStatus(row) || "cancelled",
            at: Math.max(stamp, remembered?.at || 0),
            // An agent cancelled while QUEUED carries no frozen stamp at all.
            // Such a cancellation has a baseline of 0, which ANY later stamp
            // outranks — including the startedAt the heartbeat promotion
            // invents — so it must not be released by a stamp comparison.
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

/** What a cancel request actually achieved, read from the capability result.
 *  `cancel-unconfirmed` (and the Windows survivor warning behind it) must never
 *  be reported as a completed or successful cancel. */
export function desktopCancelOutcome(value: unknown): "unconfirmed" | "cancelled" | "" {
  const text = typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? ["status", "stage", "text", "message", "result", "detail", "error"]
        .map((key) => {
          const part = (value as AgentRecord)[key];
          return typeof part === "string" ? part : "";
        })
        .filter(Boolean)
        .join("\n")
      : "";
  if (!text.trim()) return "";
  if (/cancel[-_\s]?(?:unconfirmed|pending)|SURVIVING_DESCENDANTS_UNREACHABLE/i.test(text)) {
    return "unconfirmed";
  }
  if (DESKTOP_CANCELLED_AGENT_STATUS.test(text)) return "cancelled";
  return "";
}
