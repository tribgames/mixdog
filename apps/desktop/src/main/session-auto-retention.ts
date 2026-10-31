// Settings → General → Sessions: archive conversations nobody used for a while
// and delete ones archived long enough. A conservative, capped pass that runs
// only while the computer is idle; every archive and delete goes through the
// host's own paths (worktrees follow an archive; a delete keeps unmerged work).
// Sub-agent sessions keep their own runtime retention (sub-agent-retention.mjs).
import { join } from 'node:path';

import { readJsonState, updateJsonAtomic } from '../../../../src/runtime/shared/atomic-file.mjs';
import {
  agentDescendantIds,
  isAgentOnlySession,
} from '../../../../src/runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import type { DesktopSessionSummary } from '../shared/contract';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_INTERVAL_MS = 15 * 60 * 1000;
/** No pass in the first minutes after start: the app is being used then. */
export const SESSION_RETENTION_START_DELAY_MS = 10 * 60 * 1000;
/** The computer counts as idle after this long without input anywhere. */
export const SESSION_RETENTION_MIN_IDLE_SECONDS = 15 * 60;
/** Candidates examined (each may cost a catalog refresh and worktree check) in one pass. */
export const SESSION_RETENTION_PASS_CAP = 50;
/** A session waiting on the user stays out of the archive this long. */
const AWAITING_USER_GRACE_MS = DAY_MS;

export interface SessionRetentionPolicy {
  sessionAutoArchiveDays: number;
  sessionAutoDeleteDays: number;
}

/** Persisted pass state. `enabledAt`: when this feature first ran here; a
 *  session archived earlier counts its delete age from then. `restored`: the
 *  sessions the user brought back from the archive, with when. */
export interface SessionRetentionRecord {
  enabledAt: number;
  restored: Record<string, number>;
}

export interface SessionRetentionInput {
  now: number;
  policy: SessionRetentionPolicy;
  record: SessionRetentionRecord;
  /** The host catalog (archive, favorite and read-cursor flags applied). */
  sessions: readonly DesktopSessionSummary[];
  /** The daemon's raw rows, sub-agent sessions included. */
  storedRows: ReadonlyArray<Record<string, unknown>>;
  /** Archive stamps by session id. */
  archivedAt: Readonly<Record<string, number>>;
  isVisible(sessionId: string): boolean;
  hasBackgroundJobs(sessionId: string): boolean;
  /** A quota auto-resume is scheduled for it. */
  hasScheduledResume(sessionId: string): boolean;
}

/** Candidates, oldest first and uncapped (the pass caps them). */
export interface SessionRetentionPlan {
  archive: string[];
  delete: string[];
}

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

function rowActivity(row: Record<string, unknown>): number {
  return positive(Number(row.lastUsedAt)) || positive(Number(row.updatedAt));
}

/** Unread by the shared read cursor: messages past it (for a row listing its
 *  incoming messages, one of those). A session never read on any surface has
 *  no cursor and, as on the sidebar, reads as seen. */
export function hasUnreadOutput(session: DesktopSessionSummary): boolean {
  const read = session.readMessageCount;
  if (typeof read !== 'number') return false;
  const count = Math.max(0, Number(session.messageCount) || 0);
  if (count <= read) return false;
  return !Array.isArray(session.incomingTail) || session.incomingTail.some((place) => place > read);
}

/** Never touched by either rule: bot chats and rooms, automations and their
 *  targets, favorites, and anything running, open on screen or holding jobs. */
function permanentOrBusy(session: DesktopSessionSummary, input: SessionRetentionInput): boolean {
  return (
    session.favorite === true ||
    Boolean(session.agentHome) ||
    Boolean(session.agentRoom) ||
    session.sessionMode === 'agent' ||
    session.sourceType === 'schedule' ||
    session.sourceType === 'webhook' ||
    session.taskFrom === 'run' ||
    session.working === true ||
    session.leadWorking === true ||
    session.agentWorking === true ||
    input.isVisible(session.id) ||
    input.hasBackgroundJobs(session.id) ||
    input.hasScheduledResume(session.id)
  );
}

export type SessionRetentionAction = 'archive' | 'delete';

/** The rule for one session over `input`: what may happen to it now, with
 *  the time it is ordered by (oldest first), or null. The plan and the
 *  re-check right before acting both use it. */
function retentionJudge(
  input: SessionRetentionInput
): (session: DesktopSessionSummary) => [SessionRetentionAction, number] | null {
  const { now, policy, record } = input;
  const agentOnly = new Set(
    input.storedRows.filter((row) => isAgentOnlySession(row)).map((row) => String(row.id || ''))
  );
  const rows = new Map(input.storedRows.map((row) => [String(row.id || ''), row]));
  const archiveWindow = policy.sessionAutoArchiveDays * DAY_MS;
  const deleteWindow = policy.sessionAutoDeleteDays * DAY_MS;
  /** A sub-session still in use: running, waiting on the user, or active
   *  within the archive window, and not archived itself. */
  const hasLiveSubSession = (sessionId: string): boolean =>
    agentDescendantIds(input.storedRows, sessionId).some((id) => {
      const row = rows.get(id);
      if (!row) return false;
      if (row.working === true || row.agentWorking === true || row.awaitingApproval === true) return true;
      return !Object.hasOwn(input.archivedAt, id) && rowActivity(row) > now - archiveWindow;
    });
  return (session) => {
    const id = session.id;
    // Sub-agent sessions follow the runtime's own retention.
    if (!id || agentOnly.has(id) || session.agentSession === true) return null;
    if (permanentOrBusy(session, input)) return null;
    const archivedStamp = input.archivedAt[id];
    if (typeof archivedStamp === 'number') {
      if (!deleteWindow || session.archived !== true) return null;
      // An archive from before this feature existed counts from its start.
      const since = Math.max(archivedStamp, record.enabledAt);
      return now - since >= deleteWindow ? ['delete', since] : null;
    }
    if (!archiveWindow || session.archived === true) return null;
    const activity = positive(session.activityAt) || positive(session.updatedAt);
    if (!activity || now - activity < archiveWindow) return null;
    // Restored from the archive: kept out until it is used again, and from
    // then on it ages from that new activity like any other session.
    const restoredAt = record.restored[id];
    if (typeof restoredAt === 'number' && activity <= restoredAt) return null;
    if (session.awaitingApproval === true && now - activity < AWAITING_USER_GRACE_MS) return null;
    if (hasUnreadOutput(session)) return null;
    if (hasLiveSubSession(id)) return null;
    return ['archive', activity];
  };
}

/** What the pass may archive and delete now (see the rules on each check). */
export function planSessionRetention(input: SessionRetentionInput): SessionRetentionPlan {
  const judge = retentionJudge(input);
  const archive: Array<[string, number]> = [];
  const remove: Array<[string, number]> = [];
  for (const session of input.sessions) {
    const verdict = judge(session);
    if (verdict) (verdict[0] === 'archive' ? archive : remove).push([session.id, verdict[1]]);
  }
  const oldestFirst = (entries: Array<[string, number]>) => entries.sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return { archive: oldestFirst(archive), delete: oldestFirst(remove) };
}

/** What may happen to `sessionId` under `input`; null when nothing (or it is gone). */
export function sessionRetentionVerdict(
  sessionId: string,
  input: SessionRetentionInput
): SessionRetentionAction | null {
  const session = input.sessions.find((row) => row.id === sessionId);
  return session ? (retentionJudge(input)(session)?.[0] ?? null) : null;
}

/** The sessions with a quota auto-resume queued, read from the daemon's
 *  quota-resume file each pass: this service bundles its own copy of
 *  quota-resume-store.mjs, whose cached queue would not see the daemon's
 *  later changes. A missing file is an empty queue; a read error fails the pass. */
export async function readScheduledResumeSessionIds(dataDirectory: string): Promise<Set<string>> {
  // quota-resume-store.mjs QUOTA_RESUME_FILE.
  const filePath = join(dataDirectory, 'quota-resume.json');
  const value = (await readJsonState(filePath, { fallback: { entries: [] } })) as { entries?: unknown };
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  return new Set(
    entries
      .map((entry) =>
        entry && typeof entry === 'object' ? String((entry as { sessionId?: unknown }).sessionId || '') : ''
      )
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export interface SessionRetentionState {
  /** The record, creating it (enabledAt = now) on first use. */
  load(): Promise<SessionRetentionRecord>;
  /** Archive (clears a restore) or restore (records it) of `sessionId`. */
  noteArchived(sessionId: string, archived: boolean): Promise<void>;
  forget(sessionId: string): Promise<void>;
}

function normalizeRecord(value: unknown, now: number): SessionRetentionRecord {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const restored: Record<string, number> = {};
  const stored = raw.restored && typeof raw.restored === 'object' ? (raw.restored as Record<string, unknown>) : {};
  for (const [id, at] of Object.entries(stored)) if (positive(at)) restored[id] = at as number;
  return { enabledAt: positive(raw.enabledAt) || now, restored };
}

/** The pass state in `filePath` (the app's data folder). */
export function createSessionRetentionState(filePath: string, clock: () => number = Date.now): SessionRetentionState {
  const update = async (mutate: (record: SessionRetentionRecord) => boolean): Promise<SessionRetentionRecord> => {
    let result: SessionRetentionRecord | null = null;
    await updateJsonAtomic(filePath, (current: unknown) => {
      const record = normalizeRecord(current, clock());
      const changed = mutate(record) || !positive((current as { enabledAt?: unknown } | null)?.enabledAt);
      result = record;
      return changed ? record : undefined;
    });
    return result as unknown as SessionRetentionRecord;
  };
  return {
    load: () => update(() => false),
    noteArchived: async (sessionId, archived) => {
      await update((record) => {
        if (archived) {
          if (!Object.hasOwn(record.restored, sessionId)) return false;
          delete record.restored[sessionId];
        } else record.restored[sessionId] = clock();
        return true;
      });
    },
    forget: async (sessionId) => {
      await update((record) => {
        if (!Object.hasOwn(record.restored, sessionId)) return false;
        delete record.restored[sessionId];
        return true;
      });
    },
  };
}

type RetentionView = Omit<SessionRetentionInput, 'now' | 'policy' | 'record'>;

export interface SessionRetentionHost {
  /** The saved policy, or null when a stored value is invalid. */
  readPolicy(): Promise<SessionRetentionPolicy | null>;
  state: Pick<SessionRetentionState, 'load'>;
  /** The snapshot the plan picks candidates from. */
  view(): Promise<RetentionView>;
  /** Run `task` holding the session's lifecycle lock, the one manual
   *  archive, restore, favorite, delete and turn starts take. */
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  /** A lifecycle action on the session is queued for its lock. */
  contended(sessionId: string): boolean;
  /** Lifecycle actions on the session finished so far. */
  lifecycleVersion(sessionId: string): number;
  /** The session's resident state (flags, cached row), read without I/O. */
  residentToken(sessionId: string): string;
  /** The view read again now, for acting on `sessionId`; null when any part
   *  of it cannot be read fresh. */
  freshView(sessionId: string): Promise<RetentionView | null>;
  /** The manual archive path (sub-sessions and worktrees follow). */
  archive(sessionId: string): Promise<void>;
  /** The daemon's idle-only delete: refused (nothing closed or deleted)
   *  unless the session is still archived, idle and at `expected`. */
  deleteIfIdle(sessionId: string, expected: { lastUsedAt: number }): Promise<{ deleted: boolean; reason?: string }>;
  /** Of `sessionIds`, the ones owning a worktree with dirty or unmerged work. */
  worktreeWork(sessionIds: string[]): Promise<string[]>;
  log(line: string): void;
}

export interface SessionRetentionReport {
  archived: string[];
  deleted: string[];
  /** Due for deletion but kept archived: their worktree holds work. */
  keptForWorktree: string[];
  /** Planned, but no longer eligible (or not surely so) when re-checked. */
  skipped: string[];
}

const preview = (ids: readonly string[]): string =>
  ids.length ? ` (${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, +${ids.length - 10} more` : ''})` : '';

type SessionOutcome = 'archived' | 'deleted' | 'kept-worktree' | 'skipped';

/** The daemon row's own conversation stamp (every turn moves it): what the
 *  idle-only delete must still find on disk. */
function lastUsedAtOf(sessionId: string, view: RetentionView): number {
  const row = view.storedRows.find((entry) => String(entry.id || '') === sessionId);
  return Number(row?.lastUsedAt) || 0;
}

class StoppedError extends Error {
  constructor() {
    super('Auto-retention stopped.');
  }
}

/** `work`'s result, or a StoppedError as soon as `signal` aborts: a slow read
 *  (Git, the daemon) is abandoned rather than waited for. Its late result is
 *  dropped; reads only, so it can change nothing. */
function unlessStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new StoppedError());
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

/** Act on one planned session. The slow reads (policy, record, a fresh
 *  catalog listing and job scan, a delete's worktree check) run OUTSIDE the
 *  session's lifecycle lock, so a turn start or any other lifecycle action
 *  never waits on them. The lock is then held only for a fast confirmation
 *  that nothing moved since those reads (no lifecycle action finished or is
 *  queued, the same resident flags and row, still off screen) and for the
 *  mutation. A delete is the daemon's idle-only delete, which re-checks
 *  archived, idle and the conversation stamp atomically with its turn starts
 *  and refuses otherwise. */
async function actOnSession(
  host: SessionRetentionHost,
  sessionId: string,
  action: SessionRetentionAction,
  clock: () => number,
  signal?: AbortSignal
): Promise<SessionOutcome> {
  const version = host.lifecycleVersion(sessionId);
  const policy = await unlessStopped(host.readPolicy(), signal);
  if (!policy) return 'skipped';
  const record = await unlessStopped(host.state.load(), signal);
  const fresh = await unlessStopped(host.freshView(sessionId), signal);
  if (!fresh) return 'skipped';
  if (sessionRetentionVerdict(sessionId, { ...fresh, now: clock(), policy, record }) !== action) return 'skipped';
  // As the fresh read left it: a refresh during the worktree check counts as a change.
  const resident = host.residentToken(sessionId);
  if (action === 'delete') {
    const holding = await unlessStopped(host.worktreeWork([sessionId]), signal);
    if (holding.includes(sessionId)) return 'kept-worktree';
  }
  const expected = { lastUsedAt: lastUsedAtOf(sessionId, fresh) };
  let entered = false;
  const locked = host.withSessionLock(sessionId, async (): Promise<SessionOutcome> => {
    entered = true;
    // Once stopped, nothing new is mutated; an archive or delete already
    // under way below finishes as its own operation guarantees.
    const unchanged =
      signal?.aborted !== true &&
      !host.contended(sessionId) &&
      host.lifecycleVersion(sessionId) === version &&
      host.residentToken(sessionId) === resident &&
      !fresh.isVisible(sessionId);
    if (!unchanged) return 'skipped';
    // An archive stays desktop-side: it only flags the session and never
    // closes or aborts it, so a bot or schedule turn the daemon starts during
    // it keeps running (a live owner's worktree is never pruned), and the
    // user can restore it.
    if (action === 'archive') {
      await host.archive(sessionId);
      return 'archived';
    }
    return (await host.deleteIfIdle(sessionId, expected)).deleted ? 'deleted' : 'skipped';
  });
  // A stop while still queued for the lock abandons the wait: the task finds
  // the signal aborted when its turn comes and mutates nothing. Once inside,
  // the archive or delete is awaited to its end.
  if (!signal) return locked;
  return new Promise<SessionOutcome>((resolve, reject) => {
    const abandon = () => {
      if (!entered) reject(new StoppedError());
    };
    if (signal.aborted) abandon();
    signal.addEventListener('abort', abandon, { once: true });
    locked.then(resolve, reject).finally(() => signal.removeEventListener('abort', abandon));
  });
}

/** What a running pass answers to besides the host. */
export interface SessionRetentionControl {
  /** Aborts when the schedule stops: the pass starts no further session,
   *  abandons its slow reads, and finishes only an archive or delete already
   *  under way. */
  signal?: AbortSignal;
  /** Asked before each session; false (the user is back) ends the pass. */
  stillIdle?(): Promise<boolean>;
  /** The candidates still to examine in the current sweep, kept across
   *  passes. A sweep covers the candidates that existed when it began; when
   *  none are left the next pass begins a new one over the then-current
   *  candidates, so a newcomer waits for the next sweep and no session
   *  already examined is put off past the end of this one. */
  pending?: Set<string>;
}

/** One pass: examines at most SESSION_RETENTION_PASS_CAP candidates, archives
 *  first (they can be undone), each confirmed under its lifecycle lock right
 *  before it is acted on. A candidate kept or skipped is not examined again
 *  until the sweep's others have had their turn (`control.pending`), so protected
 *  sessions never starve newer ones and the work per pass stays bounded.
 *  Null when the policy is invalid or turned off, or the pass was stopped
 *  before the plan. */
export async function runSessionRetentionPass(
  host: SessionRetentionHost,
  clock: () => number = Date.now,
  control: SessionRetentionControl = {}
): Promise<SessionRetentionReport | null> {
  try {
    return await runPass(host, clock, control);
  } catch (error) {
    if (error instanceof StoppedError || control.signal?.aborted) return null;
    throw error;
  }
}

async function runPass(
  host: SessionRetentionHost,
  clock: () => number,
  { signal, stillIdle, pending = new Set<string>() }: SessionRetentionControl
): Promise<SessionRetentionReport | null> {
  const policy = await unlessStopped(host.readPolicy(), signal);
  if (!policy || (!policy.sessionAutoArchiveDays && !policy.sessionAutoDeleteDays)) return null;
  const record = await unlessStopped(host.state.load(), signal);
  const view = await unlessStopped(host.view(), signal);
  const plan = planSessionRetention({ ...view, now: clock(), policy, record });
  const candidates: Array<[string, SessionRetentionAction]> = [
    ...plan.archive.map((id): [string, SessionRetentionAction] => [id, 'archive']),
    ...plan.delete.map((id): [string, SessionRetentionAction] => [id, 'delete']),
  ];
  const due = new Set(candidates.map(([id]) => id));
  for (const id of pending) if (!due.has(id)) pending.delete(id);
  if (!pending.size) for (const id of due) pending.add(id);
  const queue = candidates.filter(([id]) => pending.has(id)).slice(0, SESSION_RETENTION_PASS_CAP);
  const report: SessionRetentionReport = { archived: [], deleted: [], keptForWorktree: [], skipped: [] };
  const failures: string[] = [];
  for (const [id, action] of queue) {
    if (signal?.aborted) break;
    if (stillIdle && !(await unlessStopped(stillIdle(), signal).catch(() => false))) break;
    let outcome: SessionOutcome;
    try {
      outcome = await actOnSession(host, id, action, clock, signal);
    } catch (error) {
      if (error instanceof StoppedError) break;
      pending.delete(id);
      failures.push(`${action} ${id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    pending.delete(id);
    if (outcome === 'archived') report.archived.push(id);
    else if (outcome === 'deleted') report.deleted.push(id);
    else {
      if (outcome === 'kept-worktree') report.keptForWorktree.push(id);
      else report.skipped.push(id);
    }
  }
  if (report.archived.length || report.deleted.length || report.keptForWorktree.length) {
    host.log(
      `[mixdog-session] auto-retention: archived ${report.archived.length}${preview(report.archived)}, ` +
        `deleted ${report.deleted.length}${preview(report.deleted)}, ` +
        `kept for worktree work ${report.keptForWorktree.length}${preview(report.keptForWorktree)}, ` +
        `no longer due ${report.skipped.length}${preview(report.skipped)}`
    );
  }
  for (const failure of failures) host.log(`[mixdog-session] auto-retention failed: ${failure}`);
  return report;
}

/** What the pass needs from the session host (SessionHost). */
export interface RetentionSessionHost {
  readonly sessionRetention: Pick<SessionRetentionState, 'load'>;
  sessionRetentionView(): Promise<Omit<RetentionView, 'hasScheduledResume'>>;
  freshSessionRetentionView(sessionId: string): Promise<Omit<RetentionView, 'hasScheduledResume'> | null>;
  withSessionLifecycleLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  sessionLifecycleContended(sessionId: string): boolean;
  sessionLifecycleVersion(sessionId: string): number;
  sessionRetentionToken(sessionId: string): string;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  deleteSessionIfIdle(
    sessionId: string,
    expected: { lastUsedAt: number }
  ): Promise<{ deleted: boolean; reason?: string }>;
  sessionWorktreeWork(sessionIds: string[]): Promise<string[]>;
}

/** The pass's host over a session host: views carry the quota-resume queue
 *  read from `dataDirectory`, and `onDeleted` runs after a delete went
 *  through (the service's upload staging cleanup). */
export function sessionRetentionHostFor(
  host: RetentionSessionHost,
  {
    readPolicy,
    onDeleted,
    dataDirectory,
    log,
  }: {
    readPolicy(): Promise<SessionRetentionPolicy | null>;
    onDeleted(sessionId: string): void;
    dataDirectory(): string;
    log(line: string): void;
  }
): SessionRetentionHost {
  const withQueue = async (view: Omit<RetentionView, 'hasScheduledResume'>): Promise<RetentionView> => {
    const scheduled = await readScheduledResumeSessionIds(dataDirectory());
    return { ...view, hasScheduledResume: (sessionId) => scheduled.has(sessionId) };
  };
  return {
    readPolicy,
    state: host.sessionRetention,
    view: async () => withQueue(await host.sessionRetentionView()),
    freshView: async (sessionId) => {
      const view = await host.freshSessionRetentionView(sessionId);
      return view ? withQueue(view) : null;
    },
    withSessionLock: (sessionId, task) => host.withSessionLifecycleLock(sessionId, task),
    contended: (sessionId) => host.sessionLifecycleContended(sessionId),
    lifecycleVersion: (sessionId) => host.sessionLifecycleVersion(sessionId),
    residentToken: (sessionId) => host.sessionRetentionToken(sessionId),
    archive: (sessionId) => host.setSessionArchived(sessionId, true),
    deleteIfIdle: async (sessionId, expected) => {
      const result = await host.deleteSessionIfIdle(sessionId, expected);
      if (result.deleted) onDeleted(sessionId);
      return result;
    },
    worktreeWork: (sessionIds) => host.sessionWorktreeWork(sessionIds),
    log,
  };
}

export interface SessionRetentionScheduleOptions {
  /** One pass, under the schedule's stop signal, idle check and sweep state. */
  run(control: SessionRetentionControl): Promise<unknown>;
  /** Seconds since the last input anywhere on the computer; null when unknown. */
  idleSeconds(): Promise<number | null>;
  clock?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/** Whether a tick may run a pass: past the start delay, none in flight, and
 *  the computer known to be idle long enough. */
export function sessionRetentionTickAllowed({
  now,
  startedAt,
  running,
  idleSeconds,
}: {
  now: number;
  startedAt: number;
  running: boolean;
  idleSeconds: number | null;
}): boolean {
  return (
    !running &&
    now - startedAt >= SESSION_RETENTION_START_DELAY_MS &&
    idleSeconds !== null &&
    idleSeconds >= SESSION_RETENTION_MIN_IDLE_SECONDS
  );
}

/** A pass every SESSION_RETENTION_INTERVAL_MS when the tick allows it.
 *  Returns the stop, which ends the schedule and resolves once the tick in
 *  flight (if any) has settled: it starts no pass after the idle read, and a
 *  pass under way is aborted between sessions. Exposes `tick` for tests. */
export function startSessionRetentionSchedule(options: SessionRetentionScheduleOptions): {
  stop(): Promise<void>;
  tick(): Promise<boolean>;
} {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const stopped = new AbortController();
  let inFlight: Promise<boolean> | null = null;
  const pending = new Set<string>();
  const stillIdle = async (): Promise<boolean> => {
    const seconds = await options.idleSeconds().catch(() => null);
    return seconds !== null && seconds >= SESSION_RETENTION_MIN_IDLE_SECONDS;
  };
  const attempt = async (): Promise<boolean> => {
    try {
      const idleSeconds = await options.idleSeconds().catch(() => null);
      if (stopped.signal.aborted) return false;
      if (!sessionRetentionTickAllowed({ now: clock(), startedAt, running: false, idleSeconds })) return false;
      await options.run({ signal: stopped.signal, stillIdle, pending });
      return true;
    } catch (error) {
      console.warn('[mixdog-session] auto-retention pass failed:', error);
      return false;
    }
  };
  const tick = (): Promise<boolean> => {
    if (inFlight || stopped.signal.aborted) return Promise.resolve(false);
    const current = attempt().finally(() => {
      inFlight = null;
    });
    inFlight = current;
    return current;
  };
  const timer = (options.setInterval ?? setInterval)(() => void tick(), SESSION_RETENTION_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: async () => {
      stopped.abort();
      (options.clearInterval ?? clearInterval)(timer);
      await inFlight;
    },
    tick,
  };
}
