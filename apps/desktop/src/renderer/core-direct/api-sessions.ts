import type { DesktopApi, DesktopAgentPoolRow, SessionSnapshot, ToolApprovalDecision } from '../../shared/contract';
import type { DirectKey } from '../../shared/desktop-api-split';
import { createCapabilityLane, type CapabilityLane } from '../../shared/core-lanes/capability-route.ts';
import { createServiceLane, type ServiceLane } from '../../shared/core-lanes/service-route.ts';
import { createSessionLane, type SessionLane } from '../../shared/core-lanes/session-lane.ts';
import { modelRouteWrite } from '../../shared/model-route-write';
import { createSnapshotDeltaEncoder, isNoDelta } from '../../main/state-delta';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';
import { createSessionStates } from './session-states.ts';

/** The shell snapshot this window holds (Node's `publishShell`): null until a start call published one. The start calls of the
 *  files group publish through `shell.publish`; `getSnapshot` and `subscribeState` read it. */
export interface ShellState {
  get(): SessionSnapshot;
  publish(snapshot: SessionSnapshot): void;
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
}

/** What one window runs its session methods on. The lanes keep state of their own (the visible set and its version, the
 *  control thread), so a window has exactly one of each. */
export interface SessionLanes {
  readonly capability: CapabilityLane;
  readonly service: ServiceLane;
  readonly session: SessionLane;
  readonly shell: ShellState;
  onAttached(listener: (sessionId: string) => void): void;
}

const lanes = new WeakMap<DirectContext, SessionLanes>();

/** The remote session this window shows (the `remoteSession` entry of the host state), if any. */
function remoteSessionIdOfWindow(ctx: DirectContext): string | undefined {
  const held = ctx.connection.snapshot().entries.find((e) => e.section === 'hostState' && e.key === 'remoteSession');
  const id = (held?.value as { sessionId?: unknown } | null | undefined)?.sessionId;
  return typeof id === 'string' ? id : undefined;
}

export function sessionLanesOf(ctx: DirectContext): SessionLanes {
  const held = lanes.get(ctx);
  if (held) return held;
  let snapshot = null as SessionSnapshot;
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();
  let attached: ((sessionId: string) => void) | undefined;
  const shell: ShellState = {
    get: () => snapshot,
    publish(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const made: SessionLanes = {
    capability: createCapabilityLane({ protocol: ctx.connection }),
    // Before a start call published a shell snapshot, the blank snapshot is composed for the remote session this window shows.
    service: createServiceLane({
      protocol: ctx.connection,
      snapshot: () => shell.get() ?? ({ remoteSessionId: remoteSessionIdOfWindow(ctx) } as unknown as SessionSnapshot),
      onAttached: (id) => attached?.(id),
    }),
    session: createSessionLane({ protocol: ctx.connection }),
    shell,
    onAttached(listener) {
      attached = listener;
    },
  };
  lanes.set(ctx, made);
  return made;
}

/** ipc-validation.ts TRANSCRIPT_WINDOW_MAX_ITEMS: a read past it is held there. */
const TRANSCRIPT_WINDOW_MAX_ITEMS = 8_192;
/** The name a window's own actions carry when the core names none (session-device.ts `hostDeviceName`'s blank case). */
const DEFAULT_DEVICE_NAME = 'Main PC';

/** requiredString / requiredSessionId shaped the value they let through: a string is trimmed. */
const trimmed = <T>(value: T): T => (typeof value === 'string' ? (value.trim() as unknown as T) : value);
/** optionalSessionId: empty or omitted addresses the control session. */
const optionalId = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : trimmed(String(value));

type SessionsApi = Pick<DesktopApi, DirectKey<'sessions'>>;

export function createSessionsApi(ctx: DirectContext): SessionsApi {
  const { connection } = ctx;
  const lanes = sessionLanesOf(ctx);
  const { capability, service, session, shell } = lanes;
  const svc = <T>(method: string, args: unknown[] = []): Promise<T> => withDirectErrors(service.call<T>(method, args));
  const states = createSessionStates(connection, lanes);

  return {
    // ── the lists ──
    listSessions: () => withDirectErrors(session.listSessions()),
    subscribeSessions: (listener) => session.subscribeSessions(listener),
    listAgentPool: () => svc('listAgentPool'),
    // The core pushes the pool as the `agentPool` section; a change is the section's whole row list.
    subscribeAgentPool: (listener) =>
      connection.onStoreChange((change) => {
        if (change.type !== 'section' || change.section !== 'agentPool') return;
        const rows = connection.client()?.store.section('agentPool')?.value;
        listener(Array.isArray(rows) ? (rows as DesktopAgentPoolRow[]) : []);
      }),
    searchSessionContent: (query) => svc('searchSessionContent', [trimmed(query)]),
    markSessionRead: (sessionId, messageCount, consumedUnread) =>
      svc('markSessionRead', [trimmed(sessionId), messageCount, consumedUnread === true]),

    // ── the session's own settings and lifecycle ──
    renameSession: (sessionId, title) => withDirectErrors(capability.renameSession(trimmed(sessionId), title)),
    setSessionArchived: (sessionId, archived) =>
      withDirectErrors(capability.setSessionArchived(trimmed(sessionId), archived)),
    setSessionFavorite: (sessionId, favorite) =>
      withDirectErrors(capability.setSessionFavorite(trimmed(sessionId), favorite)),
    setSessionProject: (sessionId, projectPath) =>
      withDirectErrors(capability.setSessionProject(trimmed(sessionId), projectPath)),
    // A session the core does not have is a no-op in the lane, as in Node. (The browser session the thread held is released by the
    // main process, which sees the thread leave the app feed.)
    deleteSession: (sessionId) =>
      withDirectErrors(capability.deleteSession(trimmed(sessionId))) as unknown as Promise<SessionSnapshot>,
    continueSessionInModel: (sessionId, route) => svc('continueSessionInModel', [trimmed(sessionId), route]),
    scheduleQuotaResume: (sessionId) => svc('scheduleQuotaResume', [trimmed(sessionId)]),
    cancelQuotaResume: (sessionId) => svc('cancelQuotaResume', [trimmed(sessionId)]),
    getQuotaAutoResume: () => withDirectErrors(capability.getQuotaAutoResume()),
    setQuotaAutoResume: (enabled) => withDirectErrors(capability.setQuotaAutoResume(enabled)),
    stopShellJob: (sessionId, taskId) => withDirectErrors(capability.stopShellJob(trimmed(sessionId), trimmed(taskId))),
    releaseShellJob: (sessionId, taskId) =>
      withDirectErrors(capability.releaseShellJob(trimmed(sessionId), trimmed(taskId))),
    getTaskWorkspace: () => svc('getTaskWorkspace'),
    // The device the core stamps this window's actions with (`connection.device` of the initialize reply).
    async viewerDevice() {
      await connection.whenSynced();
      const device = (connection.protocolClient()?.server as { connection?: { device?: unknown } } | undefined)
        ?.connection?.device;
      return typeof device === 'string' && device.trim() ? device.trim() : DEFAULT_DEVICE_NAME;
    },

    // ── agents ──
    openAgentHome: (agentId) => svc('openAgentHome', [trimmed(agentId)]),
    resetAgentHome: (agentId) => svc('resetAgentHome', [trimmed(agentId)]),
    listAgentMemory: (agentId) => svc('listAgentMemory', [trimmed(agentId)]),
    deleteAgentMemory: (agentId, entry) => svc('deleteAgentMemory', [trimmed(agentId), entry]),
    agentRoomAction: (action, args) => svc('agentRoomAction', [trimmed(action), Array.isArray(args) ? args : []]),

    // ── models ──
    listProviderModels: async (options = {}) => withDirectErrors((await session.chat()).listProviderModels(options)),
    setModelRoute: async (selection, sessionId) => {
      const target = optionalId(sessionId);
      return (await withDirectErrors(capability.invoke('setRoute', [modelRouteWrite(selection, target)], target)))
        .snapshot;
    },
    setFast: async (enabled, sessionId) =>
      (await withDirectErrors(capability.invoke('setFast', [enabled], optionalId(sessionId)))).snapshot,
    // The core announces a frame the relay refused as `ui/relayPayloadRefused` on the app feed (the size and the ceiling, each null
    // when the relay reported none); the window shows the toast.
    subscribeRelayPayloadRefused: (listener) =>
      connection.onEvent((event) => {
        if (event.type !== 'notification') return;
        const { method, params } = (
          event as { notification: { method: string; params?: { bytes?: unknown; limit?: unknown } } }
        ).notification;
        if (method !== 'ui/relayPayloadRefused') return;
        const size = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
        listener({ bytes: size(params?.bytes), limit: size(params?.limit) });
      }),

    // ── chat ──
    submitNewTask: async (prompt, options = {}, draft = {}) =>
      withDirectErrors((await session.chat()).submitNewTask(prompt, options, draft)),
    submitToSession: (sessionId, prompt, options = {}) => svc('submitToSession', [trimmed(sessionId), prompt, options]),
    abortSession: (sessionId, options = {}) => svc('abortSession', [trimmed(sessionId), options]),
    inheritSession: async (sourceSessionId, selection, options) =>
      withDirectErrors(
        (await session.chat()).inheritSession(trimmed(sourceSessionId), selection ?? null, {
          compact: (options as { compact?: unknown } | null | undefined)?.compact === true,
        })
      ),
    async resolveToolApprovalForSession(sessionId, id, decision) {
      const shown: ToolApprovalDecision =
        typeof decision?.reply === 'string' ? { ...decision, reply: decision.reply.trim() } : decision;
      const accepted = await withDirectErrors(
        capability.resolveToolApproval(trimmed(sessionId), trimmed(id), shown as unknown as Record<string, unknown>)
      );
      // An answer that stored a standing grant is announced, so open "Always allowed" lists read again.
      if (accepted === true && (shown.remember === 'agent' || shown.remember === 'always')) {
        void connection.call('ui/settings/announce', { scope: 'permissions' }).catch(() => undefined);
      }
      return accepted;
    },
    // The attachment a session's transcript names, served and verified by the core.
    async readSessionAttachment(sessionId, attachmentId) {
      const { attachment, bytes, viewName, dataUrl } = (await connection.call('desktop/attachment/resolve', {
        sessionId: trimmed(sessionId),
        attachmentId,
      })) as { attachment: { mimeType: string }; bytes: number; viewName: string; dataUrl: string };
      return { name: viewName, mimeType: attachment.mimeType, size: bytes, dataUrl };
    },

    // ── the transcript ──
    previewSession: (sessionId) => withDirectErrors(session.previewSession(trimmed(sessionId))),
    prefetchSession(sessionId, transcriptItemLimit, readTraceId, options) {
      const id = trimmed(sessionId);
      const limit =
        typeof transcriptItemLimit === 'number'
          ? Math.min(transcriptItemLimit, TRANSCRIPT_WINDOW_MAX_ITEMS)
          : undefined;
      const traceId = typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined;
      const retry = options?.retry === true ? { retry: true } : undefined;
      return states.read(id, traceId, () => withDirectErrors(session.prefetchSession(id, limit, traceId, retry)));
    },
    readTranscriptHistory: async (sessionId, request) =>
      withDirectErrors((await session.chat()).readTranscriptHistory(trimmed(sessionId), request, true)),
    setVisibleSessions: (sessionIds) => states.setVisible(sessionIds),

    // ── the states ──
    getSnapshot: async () => shell.get(),
    // Each listener holds its own baseline: the engine state that leaves it unchanged is not delivered again (`sendEngineState`).
    subscribeState(listener) {
      const encoder = createSnapshotDeltaEncoder();
      return shell.subscribe((snapshot) => {
        if (!isNoDelta(encoder.encode(snapshot))) listener(snapshot);
      });
    },
    subscribeSessionState: (listener) => states.subscribe(listener),
    sessionStreamPosition: async (sessionId) => connection.protocolClient()?.feedPosition(trimmed(sessionId)) ?? null,
    resyncSessionState: (sessionId, options) => states.resync(sessionId, options),
  };
}
