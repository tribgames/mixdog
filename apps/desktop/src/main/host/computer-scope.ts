/**
 * The desktop's side of the core's automation scopes. Every `host/computer/*` request of a session names its scope
 * (`automationScope`); the desktop keeps one revocable context per scope and connection, and each handler commits its side
 * effects under it: right before the effect (a capture and each of its fallbacks, an app input event, a foreground lease, the
 * agent's arrow, a relayed command) it calls `commit`, which throws once the scope is revoked or Computer Use is off. The core
 * revokes scopes with `host/computer/revokeScopes`, answered once they refuse here; the desktop's own switch going off revokes
 * every context, and a closed connection every context of it. A revoked scope stays revoked when Computer Use is switched on
 * again. The core refusing a later send does not retract a request already delivered, which is why this side enforces too.
 *
 * A request without a scope (an older core, a harness) is served while Computer Use is on and is revoked when it goes off.
 *
 * Each revocation answers one report per scope (`reports`), derived only from what the scope fences: admission closed (the
 * context refuses from the revocation's own turn), the calls of the scope still unfinished at its first closure (a diagnostic,
 * kept for every later revocation), those unfinished now, and the cleanup: pending while one is unfinished (a release the port
 * sent at the revocation included), else complete. A call handed to an executor this scope does not fence (`trackUnfenced`: the
 * bridge command's PowerShell host and the renderer endpoint it drives follow the desktop's coordinator, not the scope) that is
 * still out at the revocation leaves the scope's admission unconfirmed, naming that executor, for good: its own end after the
 * scope's signal aborted is not observed here. A scope stays known after its revocation, so a second revocation reads the same
 * closure and never a fabricated zero.
 *
 * A revocation reports only the scopes this connection served (admitted work for): of a scope it never served it cannot know
 * anything (its work, if any, went to another connection), so it revokes it here and reports nothing; the core keeps such a scope's
 * desktop cleanup unknown unless the claim that took its work reports it. The answer to a revocation is the scope's snapshot;
 * afterwards, each change of a served revoked scope's report (a call it counted settling, a release or compensation included) is
 * pushed to the core as `host/computer/scopeReport`. Every report carries the scope's revision, one more at each change: the
 * revocation pushes the scope's report before it answers, on the same connection, and the core applies a report only when newer
 * than the one it holds (a change between the snapshot and its first push is neither missed nor applied stale). A closed
 * connection reports nothing more: the core reads the end of its claim as the cleanup of the scopes it served unconfirmed.
 *
 * The desktop routes of a scope and their endpoint: `host/computer/appInput` (the renderer port under the scope's `commit`,
 * signal and `track`), `host/computer/command` (admitted; with a host that offers `answerScopedCommand`, every worker request
 * of the command admitted through the scope's `commit` and signal and counted by `track`; otherwise the scope's signal and the
 * whole command counted by `trackUnfenced`),
 * `host/computer/cursorPrepare` and the foreground lease's acquire (admitted, counted by `track`), `host/computer/pointerFeedback`
 * (each event committed, drawn synchronously), `host/computer/pixels` and `host/computer/capture` (reads: admitted, the scope's
 * signal and `commit` before the frame is handed on).
 */
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, HostRpcError, type HostConnection } from './connection';

export const HOST_COMPUTER_REVOKE_SCOPES = 'host/computer/revokeScopes';
export const HOST_COMPUTER_SCOPE_REPORT = 'host/computer/scopeReport';
export const SCOPE_FIELD = 'automationScope';

/** What a refused effect answers: Node's words for Computer Use that is unavailable. */
const REVOKED = 'computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings';

/** Computer Use's switch on this desktop, which every connection's scopes follow. */
export interface ComputerSwitch {
  enabled(): boolean;
  /** `listener` runs at each change; the returned function ends that. */
  onChange(listener: (enabled: boolean) => void): () => void;
}

/** The switch the app's settings drive. */
export function createComputerSwitch(initial: boolean): ComputerSwitch & { set(enabled: boolean): void } {
  let enabled = initial;
  const listeners = new Set<(enabled: boolean) => void>();
  return {
    enabled: () => enabled,
    set(next) {
      if (next === enabled) return;
      enabled = next;
      for (const listener of [...listeners]) listener(enabled);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One request's hold on its scope. */
export interface ScopeContext {
  /** Aborts when the scope is revoked or Computer Use goes off, and when `signal` (the request's) aborts. */
  readonly signal: AbortSignal;
  /** Throws unless the scope holds and Computer Use is on: called right before each side effect, never held across a wait. */
  commit(): void;
  /** Counts a call handed over under the scope until it settles (the scope's report reads it). */
  track(reply: Promise<unknown>): void;
  /** Counts a call handed to `executor`, which the scope does not fence, until it settles; out at the revocation, it leaves the
   *  scope's admission unconfirmed for good. */
  trackUnfenced(reply: Promise<unknown>, executor: string): void;
}

/** One scope's acknowledgement of a revocation. */
export interface ScopeReport {
  scope: number;
  /** The scope's report revision: 1 at its first revocation's report, one more at each change after it. */
  revision: number;
  admission: 'closed' | 'unconfirmed';
  unfinished_at_closure: number;
  unfinished: number;
  cleanup: 'pending' | 'complete';
  unknown_executors?: string[];
}

export interface ComputerScopes {
  /** The context of the request's scope, committed once: throws when it is already refused. */
  admit(params: unknown, signal?: AbortSignal): ScopeContext;
}

interface Scope {
  revoked: boolean;
  controller: AbortController;
  /** Calls handed over under the scope and not settled. */
  unfinished: number;
  /** `unfinished` at the first revocation. */
  closure?: number;
  /** Calls out now to an executor the scope does not fence, by executor. */
  unfenced: Map<string, number>;
  /** The executors such a call was out to at the revocation: their closure is not known. */
  unknown: Set<string>;
  /** The revision of the last report given (0: none yet), and what it said. */
  revision: number;
  said?: string;
  /** Work of the scope was admitted on this connection: only then can it report the scope. */
  served: boolean;
}

const newScope = (): Scope => ({
  revoked: false,
  controller: new AbortController(),
  unfinished: 0,
  unfenced: new Map(),
  unknown: new Set(),
  revision: 0,
  served: false,
});

const refused = (): HostRpcError => new HostRpcError(HOST_COMMAND_FAILED, REVOKED);

/** The scopes of one connection, which serves `host/computer/revokeScopes` and revokes everything when it closes. */
export function registerComputerScopes(connection: HostConnection, computerSwitch: ComputerSwitch): ComputerScopes {
  const scopes = new Map<number, Scope>();
  let closed = false;
  /** The scope's report now, at a new revision when it says something else than the last one given. */
  const reportOf = (id: number, scope: Scope): { report: ScopeReport; changed: boolean } => {
    const facts = {
      admission: scope.unknown.size > 0 ? 'unconfirmed' : 'closed',
      unfinished_at_closure: scope.closure ?? 0,
      unfinished: scope.unfinished,
      cleanup: scope.unfinished > 0 ? 'pending' : 'complete',
      ...(scope.unknown.size > 0 ? { unknown_executors: [...scope.unknown] } : {}),
    } as const;
    const said = JSON.stringify(facts);
    const changed = said !== scope.said;
    if (changed) {
      scope.said = said;
      scope.revision++;
    }
    return { report: { scope: id, revision: scope.revision, ...facts }, changed };
  };
  /** A revoked scope's report changed: pushed to the core (nothing after the connection closed). */
  const pushIfChanged = (id: number | undefined, scope: Scope): void => {
    if (id === undefined || !scope.revoked || scope.revision === 0 || closed) return;
    const { report, changed } = reportOf(id, scope);
    if (changed) connection.notify(HOST_COMPUTER_SCOPE_REPORT, { report });
  };
  // Requests without a scope share one context, renewed each time Computer Use goes off.
  let unscoped: Scope = newScope();
  const revokeScope = (scope: Scope): void => {
    scope.revoked = true;
    scope.closure ??= scope.unfinished;
    for (const [executor, out] of scope.unfenced) if (out > 0) scope.unknown.add(executor);
    scope.controller.abort(refused());
  };
  const revokeAll = (): void => {
    for (const scope of scopes.values()) revokeScope(scope);
    revokeScope(unscoped);
    unscoped = newScope();
  };
  const scopeOf = (id: number): Scope => {
    let scope = scopes.get(id);
    if (!scope) {
      // A scope first seen while Computer Use is off is born revoked: nothing of it may run here.
      scope = newScope();
      if (!computerSwitch.enabled()) revokeScope(scope);
      scopes.set(id, scope);
    }
    return scope;
  };
  const stopFollowing = computerSwitch.onChange((enabled) => {
    if (!enabled) revokeAll();
  });
  connection.onClose(() => {
    closed = true;
    stopFollowing();
    revokeAll();
  });
  connection.handleRequest(HOST_COMPUTER_REVOKE_SCOPES, async (params): Promise<{ revoked: number; reports: ScopeReport[] }> => {
    const ids = (params as { scopes?: unknown } | null)?.scopes;
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id))) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_REVOKE_SCOPES} needs scopes, whole numbers.`);
    }
    const reports = (ids as number[]).flatMap((id): ScopeReport[] => {
      const scope = scopeOf(id);
      revokeScope(scope);
      if (!scope.served) return [];
      const { report, changed } = reportOf(id, scope);
      // Pushed before the answer, on the same connection.
      if (changed) connection.notify(HOST_COMPUTER_SCOPE_REPORT, { report });
      return [report];
    });
    return { revoked: ids.length, reports };
  });
  return {
    admit(params, signal) {
      const id = (params as Record<string, unknown> | null)?.[SCOPE_FIELD];
      if (id !== undefined && !Number.isSafeInteger(id)) {
        throw new HostRpcError(HOST_INVALID_PARAMS, `${SCOPE_FIELD} is a whole number.`);
      }
      const scopeId = id as number | undefined;
      const scope = scopeId === undefined ? unscoped : scopeOf(scopeId);
      const context: ScopeContext = {
        signal: signal ? AbortSignal.any([signal, scope.controller.signal]) : scope.controller.signal,
        commit() {
          if (scope.revoked || !computerSwitch.enabled()) throw refused();
        },
        track(reply) {
          scope.unfinished++;
          const settled = (): void => {
            scope.unfinished--;
            pushIfChanged(scopeId, scope);
          };
          reply.then(settled, settled);
        },
        trackUnfenced(reply, executor) {
          scope.unfenced.set(executor, (scope.unfenced.get(executor) ?? 0) + 1);
          const settled = (): void => {
            scope.unfenced.set(executor, (scope.unfenced.get(executor) ?? 1) - 1);
          };
          reply.then(settled, settled);
          context.track(reply);
        },
      };
      context.commit();
      scope.served = true;
      return context;
    },
  };
}
