// The renderer's session capabilities over the one protocol connection (protocol.md §12.3-12.4): `invokeCapability`
// and `readCapabilities` become `<namespace>/<action>` with the positional arguments as the method's named params, and
// the session the call is addressed to as `threadId`. A call without a session is the control session's (Node's
// `invokeCapability`/`readCapabilities`): the control thread is named as `threadId` for every op that takes one.
// The routing table is the TUI's (`src/standalone/protocol-session`); only actions the TUI does not route are added.
// The control session is a real thread of the core, started on first need.
import {
  approvalSurface,
  desktopSessionState,
  sessionReducer,
} from '../../../../../packages/protocol-client/src/index.ts';
import { ACTION_OVERRIDES, OVERRIDE_THREAD_SOURCE } from '../../../../../src/standalone/protocol-session/action-overrides.mjs';
import { resolveAction } from '../../../../../src/standalone/protocol-session/action-route.mjs';
import { METHOD_ARGS } from '../../../../../src/standalone/protocol-session/method-args.generated.mjs';
import type {
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  SessionSnapshot,
} from '../../shared/contract';
import { normalizeSessionTitle } from '../../shared/session-title.mjs';
import { isSessionId } from '../desktop-state';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';

/** `sessionIdOf` of the Node transport (`session-host-transport.ts`), which this file cannot import: that module has a
 *  TypeScript parameter property, and the harness loads this one with Node's strip-only mode. */
const sessionIdOf = (value: unknown): string => {
  const id = String(value || '');
  if (!isSessionId(id)) throw new TypeError('session id is invalid.');
  return id;
};

export interface CapabilityRoute {
  method: string;
  params: Record<string, unknown>;
}

type Override = (args: readonly unknown[], ctx: { threadId?: string }) => CapabilityRoute;

const defined = (params: Record<string, unknown>, threadId: string | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries({ threadId, ...params }).filter(([, value]) => value !== undefined));

// Actions whose Rust op exists under another namespace or name than `<namespace>/<action>` (operations_map.json:
// `getBotOrder`/`setBotOrder` → `config/*`, `setAgentRoute` → `route/set{agentId, route}`) and that the TUI lacks, plus the
// seven the gap analysis closed (desktop-gaps-1: queue edits, review reads, `setModel`).
export const DESKTOP_OVERRIDES: Readonly<Record<string, Override>> = {
  getBotOrder: (_args, { threadId }) => ({ method: 'config/getBotOrder', params: defined({}, threadId) }),
  setBotOrder: ([order], { threadId }) => ({ method: 'config/setBotOrder', params: defined({ order }, threadId) }),
  setAgentRoute: ([agentId, route], { threadId }) => ({
    method: 'route/set',
    params: defined({ agentId, route }, threadId),
  }),
  prioritizeQueued: ([selectedId], { threadId }) => ({
    method: 'turn/steer',
    params: defined({ queuedId: selectedId }, threadId),
  }),
  restoreQueued: ([currentText, selectedId], { threadId }) => ({
    method: 'thread/queue/delete',
    params: defined({ queuedId: selectedId, currentText, restore: true }, threadId),
  }),
  getSessionReviewDiff: (_args, { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'session' }, threadId),
  }),
  getSessionReviewFilePatch: ([file, oldPath], { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'session', path: file, oldPath }, threadId),
  }),
  // `refresh`/`poll` are dropped: Node's `readTurnReview` ignores them.
  getTurnReviewDiff: ([options], { threadId }) => {
    const { summary, known } = (options ?? {}) as { summary?: unknown; known?: unknown };
    return {
      method: 'review/diff/get',
      params: defined({ scope: 'turn', summary: summary === true ? true : undefined, known }, threadId),
    };
  },
  getTurnReviewFilePatch: ([file], { threadId }) => ({
    method: 'review/diff/get',
    params: defined({ scope: 'turn', path: file }, threadId),
  }),
  getTurnChanges: ([options], { threadId }) => {
    const { checkpointId, patch, file } = (options ?? {}) as { checkpointId?: unknown; patch?: unknown; file?: unknown };
    return {
      method: 'review/diff/get',
      params: defined({ scope: 'turn', checkpointId, patch, path: file }, threadId),
    };
  },
  setModel: ([model], { threadId }) => ({ method: 'route/set', params: defined({ route: { model } }, threadId) }),
  // Node's `clear(options)` rebuilds the prompt of the emptied session only for `rebuildPrompt === true`; its other options
  // (`archiveAs`, `recoverAgent`) are the TUI's.
  clear: ([options], { threadId }) => ({
    method: 'thread/clear',
    params: defined({ rebuildPrompt: (options as { rebuildPrompt?: unknown } | null | undefined)?.rebuildPrompt === true ? true : undefined }, threadId),
  }),
};

/** Where each desktop override's thread comes from (see `OVERRIDE_THREAD_SOURCE`): every one addresses the call's session. */
export const DESKTOP_OVERRIDE_THREAD_SOURCE: Readonly<Record<string, string>> = {
  getBotOrder: 'session',
  setBotOrder: 'session',
  setAgentRoute: 'session',
  prioritizeQueued: 'session',
  restoreQueued: 'session',
  getSessionReviewDiff: 'session',
  getSessionReviewFilePatch: 'session',
  getTurnReviewDiff: 'session',
  getTurnReviewFilePatch: 'session',
  getTurnChanges: 'session',
  setModel: 'session',
  clear: 'session',
};
/** The core request for `capability(...args)` issued by the surface that paints `sessionId` (none = control session).
 *  An action with no Rust op is refused here, before anything is sent: `unknownMethod`. */
export function routeCapability(capability: string, args: readonly unknown[], sessionId?: string): CapabilityRoute {
  const ctx = sessionId ? { threadId: sessionId } : {};
  const override = DESKTOP_OVERRIDES[capability];
  return override ? override(args, ctx) : resolveAction(capability, args, ctx);
}

export interface CapabilityLane {
  invoke<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] | undefined,
    sessionId: string | undefined
  ): Promise<DesktopCapabilityResult<T>>;
  read(requests: ReadonlyArray<DesktopCapabilityReadRequest>): Promise<DesktopCapabilityReadResult[]>;
  /** `SessionHostLifecycle.renameSession` on a core connection: the host's own checks, then `thread/name/set`. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** The DesktopService session methods a core connection serves itself (there is no Node host: protocol.md §12.3).
   *  `setSessionFavorite`/`setSessionProject` are `thread/metadata/update` (the metadata lives on the thread, SPEC.md metadata
   *  row), `setSessionArchived` is `thread/archive`/`thread/unarchive` (the core cascades over sub-agent sessions). */
  setSessionFavorite(sessionId: string, favorite: boolean): Promise<void>;
  setSessionProject(sessionId: string, projectPath: string): Promise<void>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  /** `thread/delete`. A session the core does not have is a no-op, as in Node (`deleteSessionLocked`: deleting a missing session is
   *  never an error surfaced to the UI); the harness case `deleteSession-missing` records Node ok / Rust `threadNotFound`. */
  deleteSession(sessionId: string): Promise<void>;
  /** `thread/backgroundTerminals/terminate` | `release`, answered as the host did: a failed call is `{stopped|released: false, error}`. */
  stopShellJob(sessionId: string, taskId: string): Promise<ShellJobResult>;
  releaseShellJob(sessionId: string, taskId: string): Promise<{ released: boolean; error?: string }>;
  /** The config key `quotaAutoResume` (desktop-services.md A2/D1): read from the `config` section, written with
   *  `config/value/write`; on unless it is `false`. */
  getQuotaAutoResume(): Promise<boolean>;
  setQuotaAutoResume(enabled: boolean): Promise<boolean>;
  /** `resolveToolApprovalForSession`: `thread/approval/answer` on the `item/*` server request the card of `sessionId` shows (the
   *  card's `id` is the request id). The core stamps the device itself, so the decision's `device` is not sent. `false` when the
   *  core is no longer asking for that id or another decision resolved it first, as Node answered a settled approval. */
  resolveToolApproval(sessionId: string, id: string, decision: Record<string, unknown>): Promise<boolean>;
}

export interface ShellJobResult {
  stopped: boolean;
  unconfirmed?: boolean;
  finished?: boolean;
  error?: string;
}

/** The capabilities that name their session as an argument and that Node answers, for a session that is not there, with
 *  `session is not the active session` (`session-api/lifecycle.mjs`, `quota-resume.mjs` `requireAddressed`); the core
 *  answers `threadNotFound`. */
const ADDRESSED_SESSION_CAPABILITIES: ReadonlySet<string> = new Set([
  'continueSessionInModel',
  'scheduleQuotaResume',
  'cancelQuotaResume',
]);

const hasRpcReason = (error: unknown, ...reasons: string[]): boolean => {
  const detail = (error as { detail?: { kind?: unknown; data?: { reason?: unknown } } } | null)?.detail;
  return detail?.kind === 'rpc' && typeof detail.data?.reason === 'string' && reasons.includes(detail.data.reason);
};

const isThreadNotFound = (error: unknown): boolean => hasRpcReason(error, 'threadNotFound');

/** Whether `capability(...args)` addresses the call's own session, from declared metadata only: the generated method table's
 *  `thread` flag (`METHOD_ARGS`) for an ordinary mapping, and for an override its declared source
 *  (`OVERRIDE_THREAD_SOURCE`, `DESKTOP_OVERRIDE_THREAD_SOURCE`). Node sends every call that names no session to the control
 *  session (`session-host-lifecycle.ts` `invokeCapability`/`readCapabilities`), so such a call without a session is addressed to
 *  the control thread; the core would otherwise answer from the user cwd or its own process folder. An op that has no thread, and an
 *  op whose thread is an argument (`deleteSession(sessionId)`, `inheritFrom(sourceId)`), is left as it is, whatever id the argument
 *  holds; `retryFailedTurn` takes the session only when its argument is left out. An action with no op throws. */
const usesCallSession = (capability: string, args: readonly unknown[]): boolean => {
  const { method } = routeCapability(capability, args);
  let source: string | undefined;
  if (Object.hasOwn(DESKTOP_OVERRIDES, capability)) source = DESKTOP_OVERRIDE_THREAD_SOURCE[capability];
  else if (Object.hasOwn(ACTION_OVERRIDES, capability)) source = OVERRIDE_THREAD_SOURCE[capability];
  else source = METHOD_ARGS[method]?.thread ? 'session' : 'none';
  if (source === undefined) throw new Error(`capability ${capability} declares no thread source`);
  return source === 'session' || (source === 'argument-else-session' && !args[0]);
};
const failureMessage = (error: unknown): string => {
  const shown = coreErrorForWindow(error);
  return shown instanceof Error ? shown.message : String(shown);
};

const startedThreadId = (started: unknown): string => {
  const id = (started as { thread?: { id?: unknown } } | null)?.thread?.id;
  if (typeof id !== 'string' || !id) throw new Error('The core did not start a control thread.');
  return id;
};

/** Every call is a request of the connection's core. The control thread is started (`thread/start` of `kind: "control"`, the
 *  way Node creates its control session in `ensureControlSession`) on first need and kept. A reply carries the state of the thread the call was addressed to,
 *  read from the core when the reply arrives (`thread/read` without items, folded by the client library's own
 *  `sessionReducer`/`desktopSessionState`, with the `hostShellJobs` section the core pushes): nothing is held between calls.
 *  The pending approvals are the ones the core asked this connection
 *  for (`item/*` server requests), joined by the library's own projection, so `toolApproval` is what Node's reply shows. */
export function createCapabilityLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'snapshot' | 'noteUserInput' | 'respond' | 'pendingServerRequests'>;
}): CapabilityLane {
  const request = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });
  // The approvals the core is waiting on are the live client's own `pendingServerRequests` (added when the core asks, removed when
  // it resolves the ask, all dropped with the socket), read when needed: nothing is cached here, so a request of a closed or replaced
  // connection is never offered and an answer never crosses connections.
  const pendingApprovals = (): unknown[] => protocol.pendingServerRequests().filter((asked) => asked.method.startsWith('item/'));
  let control: Promise<string> | null = null;
  const controlThread = (): Promise<string> => {
    if (control) return control;
    const pending = request('thread/start', { kind: 'control' }).then(startedThreadId);
    control = pending;
    // A failed start is tried again by the next call; this one still rejects to its caller.
    pending.catch(() => {
      if (control === pending) control = null;
    });
    return pending;
  };
  const send = async (capability: string, args: readonly unknown[], sessionId?: string): Promise<unknown> => {
    // `noteUserInput(at)` is the `client/activity {at}` notification (rate-limited by the connection), not a request; Node's
    // session-api wrapper answers it `{ ok: true }`.
    if (capability === 'noteUserInput') {
      protocol.noteUserInput(args[0] as number);
      return { ok: true };
    }
    let thread = sessionId;
    // An action with no op fails in `usesCallSession`, before a thread is started for it.
    if (!thread && usesCallSession(capability, args)) thread = await controlThread();
    // `retryFailedTurn(sessionId, turnKey)` names its thread as its first argument; left out, it is the one addressed.
    const named = capability === 'retryFailedTurn' && !args[0] ? [thread, ...args.slice(1)] : args;
    const { method, params } = routeCapability(capability, named, thread);
    // `inheritFrom` answers as Node's does (`lifecycle/inheritance.mjs`): the heir, its source, the messages carried and its route.
    if (capability === 'inheritFrom') {
      // The core answers a source thread it does not have with `threadNotFound`; Node's `inheritFrom` throws its own text.
      const forked = (await request(method, params).catch((error: unknown) => {
        throw isThreadNotFound(error) ? new Error(`inheritFrom: session ${String(args[0]).trim()} was not found`) : error;
      })) as { thread: { id: string }; messages: number; provider: unknown; model: unknown };
      return {
        sessionId: forked.thread.id,
        sourceSessionId: args[0],
        messages: forked.messages,
        provider: forked.provider,
        model: forked.model,
      };
    }
    // The core answers these route ops with the route object / normalized mode; Node's session-api wrapper
    // (`session-api/settings.mjs`) answers the effort in force, nothing, and `true`.
    if (capability === 'setEffort') {
      const route = ((await request(method, params)) ?? {}) as {
        effectiveEffort?: unknown;
        effort?: unknown;
        preset?: { effort?: unknown } | null;
      };
      return route.effectiveEffort || route.effort || route.preset?.effort || 'auto';
    }
    if (capability === 'setToolMode') {
      await request(method, params);
      return undefined;
    }
    if (capability === 'setModel') {
      await request(method, params);
      return true;
    }
    // `rewindToItem` (`intake/rewind.mjs`) answers `null`, never an error, for an item that is not a rewindable prompt and for a
    // session that is busy; the core refuses those as `itemNotFound` / `preconditionFailed`.
    if (capability === 'rewindToItem') {
      return request(method, params).catch((error: unknown) => {
        if (hasRpcReason(error, 'itemNotFound', 'preconditionFailed')) return null;
        throw error;
      });
    }
    // `prioritizeQueued` (`session-flow/queue.mjs`) answers an entry that is not queued with a count of none; the core refuses it
    // as `queuedEntryNotFound`, which would leave the entry marked sending in the renderer; a queued one is promoted and answers a count
    // of one, whether or not a turn runs (the core's `turn/steer` acknowledgement is not Node's reply).
    if (capability === 'prioritizeQueued') {
      return request(method, params).then(
        () => ({ count: 1, ids: [args[0]], priority: 'now' }),
        (error: unknown) => {
          if (hasRpcReason(error, 'queuedEntryNotFound')) return { count: 0, ids: [], priority: 'now' };
          throw error;
        }
      );
    }
    if (!ADDRESSED_SESSION_CAPABILITIES.has(capability)) return request(method, params);
    return request(method, params).catch((error: unknown) => {
      throw isThreadNotFound(error) ? new Error('session is not the active session') : error;
    });
  };
  const stateOf = async (threadId: string): Promise<SessionSnapshot> => {
    const read = await request('thread/read', { threadId, window: { none: true } });
    const hostShellJobs = protocol.snapshot().entries.find((entry) => entry.section === 'hostShellJobs')?.value;
    return desktopSessionState(
      sessionReducer.initial(read as Parameters<typeof sessionReducer.initial>[0]),
      pendingApprovals() as Parameters<typeof desktopSessionState>[1],
      hostShellJobs as Parameters<typeof desktopSessionState>[2]
    ) as unknown as SessionSnapshot;
  };
  return {
    async invoke<T>(capability: DesktopCapability, args: unknown[] = [], sessionId?: string) {
      try {
        const value = (await send(capability, args, sessionId)) as T;
        return { value, snapshot: await stateOf(sessionId ?? (await controlThread())) };
      } catch (error) {
        // Node sent a call naming its session to that session (`session-host-lifecycle.ts` `invokeCapability` -> the daemon's
        // `session-action.mjs`), which answers a session it does not have with its own text; the core answers `threadNotFound`.
        throw sessionId && isThreadNotFound(error) ? new Error(`session ${sessionId} is not available`) : error;
      }
    },
    async setSessionFavorite(sessionId, favorite) {
      await request('thread/metadata/update', { threadId: sessionIdOf(sessionId), favorite });
    },
    async setSessionProject(sessionId, projectPath) {
      await request('thread/metadata/update', { threadId: sessionIdOf(sessionId), projectPath });
    },
    async setSessionArchived(sessionId, archived) {
      await request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: sessionIdOf(sessionId) });
    },
    async deleteSession(sessionId) {
      try {
        await request('thread/delete', { threadId: sessionIdOf(sessionId) });
      } catch (error) {
        if (isThreadNotFound(error)) return;
        throw error;
      }
    },
    async stopShellJob(sessionId, taskId) {
      const id = sessionIdOf(sessionId);
      try {
        const result = ((await send('stopShellJob', [taskId], id)) ?? {}) as {
          stopped?: unknown;
          unconfirmed?: unknown;
          finished?: unknown;
          error?: unknown;
        };
        if (result.stopped === true) return { stopped: true };
        return {
          stopped: false,
          ...(result.unconfirmed === true ? { unconfirmed: true } : {}),
          ...(result.finished === true ? { finished: true } : {}),
          error: typeof result.error === 'string' && result.error ? result.error : 'The job was not stopped.',
        };
      } catch (error) {
        return { stopped: false, error: failureMessage(error) };
      }
    },
    async releaseShellJob(sessionId, taskId) {
      const id = sessionIdOf(sessionId);
      try {
        const result = ((await send('releaseShellJob', [taskId], id)) ?? {}) as { released?: unknown; error?: unknown };
        if (result.released === true) return { released: true };
        return {
          released: false,
          error: typeof result.error === 'string' && result.error ? result.error : 'The job was not released.',
        };
      } catch (error) {
        return { released: false, error: failureMessage(error) };
      }
    },
    async resolveToolApproval(sessionId, id, decision) {
      const asked = pendingApprovals().find((candidate) => {
        const { id: requestId } = candidate as { id: string | number };
        return String(requestId) === id && approvalSurface(candidate as Parameters<typeof approvalSurface>[0]) === sessionId;
      }) as { id: string | number; params: { threadId: string } } | undefined;
      if (!asked) return false;
      const { device: _device, ...answer } = decision;
      // Answered once the core's thread took the decision or another one had: `accepted` is Node's serialized answer
      // (session-host-lifecycle.ts:1086), false for the card that lost.
      const answered = await request('thread/approval/answer', { threadId: asked.params.threadId, approvalId: String(asked.id), result: answer });
      return (answered as { accepted?: unknown } | null)?.accepted === true;
    },
    async getQuotaAutoResume() {
      // The core publishes each subtree of the `config` section as an entry of its own, keyed by the subtree's name; this
      // switch's subtree is the boolean itself. Reading the section's first entry reads another subtree.
      const held = protocol.snapshot().entries.find((entry) => entry.section === 'config' && entry.key === 'quotaAutoResume');
      return held?.value !== false;
    },
    async setQuotaAutoResume(enabled) {
      await request('config/value/write', { path: 'quotaAutoResume', value: enabled });
      return enabled;
    },
    // Node's host throws `TypeError('Session title is invalid.')` for a title that is empty once normalized, before the
    // runtime is reached; the core cannot tell that case from a refusal ("Session is not available.", the runtime's `false`,
    // which it sends as a code-less `domainError`), so the host check stays here. `setName` and `publishCatalogs` are the
    // core's own (the title is stored and the section pushed by `thread/name/set`).
    async renameSession(sessionId, title) {
      const id = sessionIdOf(sessionId);
      const normalized = normalizeSessionTitle(title, '');
      if (!normalized) throw new TypeError('Session title is invalid.');
      await send('renameSessionTitle', [id, normalized], id);
    },
    // Node answers every read from the control session and ignores the request's `sessionId`; so does this (a read that takes a
    // `threadId` is addressed to the control thread). Reads are
    // independent getters, answered together; the result order stays positional.
    read: (requests) =>
      Promise.all(
        requests.map(async (item): Promise<DesktopCapabilityReadResult> => {
          try {
            return { ok: true, value: await send(item.capability, item.args ?? []) };
          } catch (error) {
            return { ok: false, error: failureMessage(error) };
          }
        })
      ),
  };
}