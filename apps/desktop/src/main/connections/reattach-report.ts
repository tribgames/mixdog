// What happened on the server while a window was away from it, reported once
// the window is attached again: turns that finished or kept running, model
// calls that broke off, and tool calls whose result never arrived. Nothing
// here is retried; the user only learns what the server did without them.
import type {
  DesktopConnectionLinkView,
  DesktopConnectionNotice,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  SessionSnapshot,
} from '../../shared/contract';
import type { ModelProxyCallSettled } from '../model-proxy-host';

/** How long after re-attaching the fresh session list may take before the
 *  report is made from the list already known. */
export const REATTACH_SESSIONS_WAIT_MS = 5_000;
/** How long a session with unanswered tool calls is watched for its turn to end. */
export const OUTCOME_WATCH_MS = 10 * 60_000;

export interface ReattachReportSources {
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  subscribeLink(listener: (view: DesktopConnectionLinkView) => void): () => void;
}

export interface ReattachReportOptions {
  sources: ReattachReportSources;
  emit(notice: DesktopConnectionNotice): void;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** A tool call that has neither a result nor a completion mark. */
export function toolCallUnanswered(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  if (row.kind !== 'tool' || row.completedAt != null) return false;
  if (row.completedCount === undefined) return row.result == null && row.rawResult == null;
  return Number(row.completedCount) < (Number(row.count) || 1);
}

function unansweredToolIds(snapshot: SessionSnapshot): string[] {
  const items = (snapshot as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(toolCallUnanswered).map((item) => String((item as { id?: unknown }).id ?? ''));
}

function sessionBusy(snapshot: SessionSnapshot): boolean {
  const state = snapshot as { busy?: unknown; commandBusy?: unknown } | null;
  return state?.busy === true || state?.commandBusy === true;
}

interface Away {
  /** Sessions whose turn was running when the link dropped: id → title. */
  working: Map<string, string>;
  /** Session id → tool call ids without a result when the link dropped. */
  tools: Map<string, Set<string>>;
  interruptedModelCalls: number;
}

export interface ReattachReport {
  /** Feed every settled model-proxy call. */
  onModelCall(event: ModelProxyCallSettled): void;
  dispose(): void;
}

export function createReattachReport(options: ReattachReportOptions): ReattachReport {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let sessions: DesktopSessionSummary[] = [];
  const states = new Map<string, SessionSnapshot>();
  const watches = new Map<string, { ids: Set<string>; until: number }>();
  let away: Away | null = null;
  let returned: Away | null = null;
  let settleTimer: unknown = null;

  const capture = (): Away => {
    const working = new Map<string, string>();
    for (const session of sessions)
      if (session.working) working.set(session.id, session.title || session.preview || session.id);
    const tools = new Map<string, Set<string>>();
    for (const [sessionId, snapshot] of states) {
      // Only a running turn has calls in flight; an idle one's are settled history.
      if (!sessionBusy(snapshot)) continue;
      const ids = unansweredToolIds(snapshot).filter(Boolean);
      if (ids.length) tools.set(sessionId, new Set(ids));
    }
    return { working, tools, interruptedModelCalls: 0 };
  };

  const finish = (): void => {
    if (settleTimer) cancel(settleTimer);
    settleTimer = null;
    const report = returned;
    returned = null;
    if (!report) return;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const finished: string[] = [];
    const continued: string[] = [];
    for (const [id, title] of report.working) {
      const current = byId.get(id);
      if (!current) continue;
      (current.working ? continued : finished).push(current.title || title);
    }
    if (finished.length || continued.length || report.interruptedModelCalls) {
      options.emit({
        kind: 'reattached',
        finished,
        continued,
        interruptedModelCalls: report.interruptedModelCalls,
      });
    }
    const until = now() + OUTCOME_WATCH_MS;
    for (const [sessionId, ids] of report.tools) {
      watches.set(sessionId, { ids, until });
      const snapshot = states.get(sessionId);
      if (snapshot !== undefined) checkWatch(sessionId, snapshot);
    }
  };

  /** Once the session's turn is over, its calls still without a result never
   *  got one; while the turn runs they may yet. */
  const checkWatch = (sessionId: string, snapshot: SessionSnapshot): void => {
    const watch = watches.get(sessionId);
    if (!watch) return;
    if (now() > watch.until) {
      watches.delete(sessionId);
      return;
    }
    if (sessionBusy(snapshot)) return;
    watches.delete(sessionId);
    const still = new Set(unansweredToolIds(snapshot));
    const toolIds = [...watch.ids].filter((id) => still.has(id));
    if (toolIds.length) options.emit({ kind: 'outcome-unknown', sessionId, toolIds });
  };

  const unsubscribers = [
    options.sources.subscribeLink((view) => {
      const connected = view.state.status === 'connected';
      if (!connected) {
        if (returned) {
          // Dropped again before the report was made: one outage.
          if (settleTimer) cancel(settleTimer);
          settleTimer = null;
          away = returned;
          returned = null;
        } else if (!away) {
          away = capture();
        }
        return;
      }
      if (!away) return;
      returned = away;
      away = null;
      // The session list the daemon sends after re-attaching is the truth;
      // the one known now may predate the outage.
      settleTimer = schedule(finish, REATTACH_SESSIONS_WAIT_MS);
    }),
    options.sources.subscribeSessions((next) => {
      sessions = next;
      if (returned) finish();
    }),
    options.sources.subscribeSessionStates((update) => {
      if (update.snapshot === null) {
        states.delete(update.sessionId);
        return;
      }
      states.set(update.sessionId, update.snapshot);
      if (!away && !returned) checkWatch(update.sessionId, update.snapshot);
    }),
  ];

  return {
    onModelCall(event) {
      const record = away ?? returned;
      if (record && (event.outcome === 'undelivered' || event.outcome === 'abandoned')) {
        record.interruptedModelCalls += 1;
      }
    },
    dispose() {
      if (settleTimer) cancel(settleTimer);
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
