import type {
  DesktopNewTaskSubmitResult,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopTranscriptHistoryPage,
  DesktopTranscriptHistoryRequest,
  SessionSnapshot,
} from '../shared/contract';
import { CORE_TRANSCRIPT_HISTORY_POSITION, validTranscriptHistoryPosition } from '../shared/contract-session';
import { blankSnapshot, remoteSessionIdOf, startFolder, withRemoteSession } from '../shared/blank-snapshot.ts';
import type { StartCall } from '../shared/blank-snapshot.ts';
import { MAX_SECRET_LENGTH, SECRET_REQUEST_ID } from '../shared/secret-slots.ts';
import { viewIsStale } from '../main/remote-view-staleness.ts';
import { remoteToolOutput, remoteTranscriptRow, remoteTranscriptSnapshot } from '../main/remote-transcript.ts';
import { historyPositionOf, rowsOf } from '../../../../packages/protocol-client/src/rows.ts';
// Types only: the adapter module (remote-protocol-chat.ts) imports this one, so nothing here may need it loaded first.
import type { ChatApi, ChatClient, ChatShared } from './remote-protocol-chat.ts';

// remote-session-methods.ts READ_NOT_VIEWED / READ_NOT_HELD
export const READ_NOT_VIEWED = 'This session is not open on this device.';
export const READ_NOT_HELD = 'This row is not in the transcript this device holds.';

/** remote-methods.ts STALE_SESSION_VIEW_MESSAGE. */
export const STALE_SESSION_VIEW_MESSAGE =
  'This conversation changed on another device. Review the latest messages, then send again.';

/** ipc-validation.ts: the page size of a historical-position read. */
const HISTORY_PAGE_ITEMS = 512;
const HISTORY_ROW_ID_MAX_CHARS = 512;
/** session-service transcript-window.mjs: the newest rows read to judge what the connection has not been shown. */
const LATEST_ROWS = HISTORY_PAGE_ITEMS;
const HELD_HISTORY_ROWS = 400;
const HELD_HISTORY_SESSIONS = 8;
/** session-host.ts agentRoomAction */
const ROOM_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'continue', 'leave', 'reset', 'remove']);

export interface ChatHostShared extends ChatShared {
  /** A thread's items as the transcript rows the client folds (`rowOf` of each, then `mergeToolRows`; packages/protocol-client). */
  foldRows(items: readonly unknown[]): unknown[];
}

export interface ChatHostOptions {
  /** The `hostState` value of key `remoteSession` (`{ sessionId: string | null }`), or undefined while the core has not sent one. */
  remoteSession(): unknown;
}

/** ipc-validation.ts requiredString */
function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

/** ipc-validation.ts requiredTranscriptHistoryRequest */
export function requiredTranscriptHistoryRequest(value: unknown): DesktopTranscriptHistoryRequest {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const id = input?.before ?? input?.after;
  const limit = input?.limit;
  const budget = input?.byteBudget;
  if (
    !input ||
    (input.before != null && input.after != null) ||
    typeof id !== 'string' ||
    !id ||
    id.length > HISTORY_ROW_ID_MAX_CHARS ||
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > HISTORY_PAGE_ITEMS ||
    (budget !== undefined && budget !== null && (!Number.isSafeInteger(budget) || (budget as number) < 1)) ||
    (input.position != null && !validTranscriptHistoryPosition(input.position))
  ) {
    throw new TypeError('transcript history request is invalid.');
  }
  return {
    ...(input.before != null ? { before: id } : { after: id }),
    limit: limit as number,
    ...(typeof budget === 'number' ? { byteBudget: budget } : {}),
    ...(typeof input.position === 'string' ? { position: input.position } : {}),
  } as DesktopTranscriptHistoryRequest;
}

/** Whether the host's submission intake takes this prompt: its text without attachment-reference parts, or the submit's `displayText`, is not blank. The core would start an empty turn, so the refusal is made here. */
function showsText(prompt: unknown, submit: unknown): boolean {
  const displayText = (submit as { displayText?: unknown } | null)?.displayText;
  if (typeof displayText === 'string' && displayText.trim()) return true;
  const shown = Array.isArray(prompt)
    ? prompt.filter((part) => !(part?.type === 'text' && part.attachmentReference && typeof part.text === 'string'))
    : prompt;
  const text = Array.isArray(shown)
    ? shown
        .map((part) => (typeof part === 'string' ? part : part?.type === 'image' ? '[Image]' : part?.text || ''))
        .filter(Boolean)
        .join('\n')
    : String(shown ?? '');
  return text.trim() !== '';
}

const reasonOf = (error: unknown): unknown =>
  (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;

type Send = (method: string, params: unknown) => Promise<unknown>;

/** History pages read from the core; the whole rows handed out are held, by session and row id, because a row outside the live fold has no other place to read its full output from. */
function createTranscriptHistory(send: Send, shared: ChatHostShared) {
  const heldHistory = new Map<string, Map<string, unknown>>();
  const holdHistory = (sessionId: string, rows: readonly unknown[]): void => {
    const held = heldHistory.get(sessionId) ?? new Map<string, unknown>();
    heldHistory.delete(sessionId);
    heldHistory.set(sessionId, held);
    for (const row of rows) {
      const id = (row as { id?: unknown } | null)?.id;
      if (id == null) continue;
      held.delete(String(id));
      held.set(String(id), row);
    }
    while (held.size > HELD_HISTORY_ROWS) held.delete(held.keys().next().value as string);
    while (heldHistory.size > HELD_HISTORY_SESSIONS) heldHistory.delete(heldHistory.keys().next().value as string);
  };
  return {
    heldRows: (sessionId: string): ReadonlyMap<string, unknown> | undefined => heldHistory.get(sessionId),
    /** `desktop`: the desktop's own pages keep every row whole; the phone's rows are the capped projection of remoteTranscriptRow. */
    async read(
      sessionId: string,
      request: DesktopTranscriptHistoryRequest,
      desktop: boolean
    ): Promise<DesktopTranscriptHistoryPage> {
      const history = requiredTranscriptHistoryRequest(request);
      const state = shared.sessionStateOf(sessionId);
      if (!state) throw new Error(READ_NOT_VIEWED);
      const older = 'before' in history;
      const anchor = (history as { before?: string; after?: string })[older ? 'before' : 'after'];
      const boundary = older ? state.items?.[0] : state.items?.at(-1);
      const cursor =
        history.position && CORE_TRANSCRIPT_HISTORY_POSITION.test(history.position)
          ? history.position
          : boundary?.id === anchor
            ? historyPositionOf(boundary, older ? 'before' : 'after')
            : undefined;
      let page: { data?: unknown[]; hasOlder?: boolean; hasNewer?: boolean };
      try {
        page = (await send('thread/items/list', {
          threadId: sessionId,
          cursor: cursor ?? { type: 'item', itemId: anchor },
          sortDirection: older ? 'desc' : 'asc',
          limit: history.limit,
          ...(history.byteBudget ? { byteBudget: history.byteBudget } : {}),
        })) as typeof page;
      } catch (error) {
        if (reasonOf(error) === 'cursorInvalidated')
          return { items: [], hasOlder: false, hasNewer: false, reset: true } as DesktopTranscriptHistoryPage;
        throw error;
      }
      const items = shared.foldRows(page.data ?? []);
      const positions = items.map((item) => historyPositionOf(item, older ? 'before' : 'after') ?? null);
      const positionEdges = items.map((item) => {
        const before = historyPositionOf(item, 'before');
        const after = historyPositionOf(item, 'after');
        return before === after
          ? null
          : { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
      });
      holdHistory(sessionId, items);
      return {
        items: desktop ? items : items.map((item) => remoteTranscriptRow(item, false).row),
        hasOlder: page.hasOlder === true,
        hasNewer: page.hasNewer === true,
        ...(positions.some((position) => position !== null) ? { positions } : {}),
        ...(positionEdges.some((edges) => edges !== null) ? { positionEdges } : {}),
      } as DesktopTranscriptHistoryPage;
    },
  };
}

export function createChatHostApi(client: ChatClient, shared: ChatHostShared, base: ChatApi, options: ChatHostOptions) {
  const remoteId = (): string => remoteSessionIdOf(options.remoteSession());
  const decorated = <T>(snapshot: T): T => withRemoteSession(remoteTranscriptSnapshot(snapshot) as T, remoteId());
  const send: Send = (method, params) =>
    client.call(method, params).catch((error: unknown) => {
      throw shared.coreErrorForWindow(error);
    });
  const history = createTranscriptHistory(send, shared);
  const start = async (call: StartCall, projectPath?: string): Promise<SessionSnapshot> => {
    const { cwd, projectPath: project } = await startFolder(
      ({ method, params }) => send(method, params),
      call,
      projectPath
    );
    return blankSnapshot(cwd, project, remoteId());
  };
  /** Keep individual row IDs here: a tool group in this page can begin before
   * the phone's window and otherwise swallow its first row's ID. */
  const latestRows = async (threadId: string): Promise<unknown[]> => {
    const page = (await send('thread/items/list', { threadId, limit: LATEST_ROWS })) as {
      data?: Parameters<typeof rowsOf>[0][];
    };
    return (page.data ?? []).flatMap(rowsOf);
  };
  /** remote-relay-device-methods.ts staleView: the rows this connection holds against the thread's latest rows. */
  const staleView = async (threadId: string): Promise<boolean> => {
    const held = shared.sessionStateOf(threadId)?.items;
    if (!held) return false;
    const device = client.server.connection?.device || 'Web app';
    if (!viewIsStale(held, await latestRows(threadId), device)) return false;
    // Node re-sent the current transcript (`sessionStates.refresh`).
    const [resume] = shared.routeService('prefetchSession', [threadId]).requests;
    void client.resumeThread(threadId, resume?.params.window).catch(() => undefined);
    return true;
  };

  return {
    ...base,
    startTask: (): Promise<SessionSnapshot> => start('startTask'),
    startProject: (projectPath: string): Promise<SessionSnapshot> =>
      start('startProject', requiredString(projectPath, 'projectPath')),
    startProjectTask: (projectPath: string): Promise<SessionSnapshot> =>
      start('startProjectTask', requiredString(projectPath, 'projectPath')),
    submitToSession: async (
      sessionId: string,
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {}
    ): Promise<boolean> => {
      if (await staleView(sessionId)) throw new Error(STALE_SESSION_VIEW_MESSAGE);
      if (!showsText(prompt, submit)) return false;
      return base.submitToSession(sessionId, prompt, submit);
    },
    submitNewTask: async (
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {},
      draft: Parameters<ChatApi['submitNewTask']>[2] = {}
    ): Promise<DesktopNewTaskSubmitResult> => {
      if (!showsText(prompt, submit))
        return { accepted: false, sessionId: '', snapshot: null } as unknown as DesktopNewTaskSubmitResult;
      const started = await base.submitNewTask(prompt, submit, draft);
      return (
        started.snapshot ? { ...started, snapshot: decorated(started.snapshot) } : started
      ) as DesktopNewTaskSubmitResult;
    },
    inheritSession: async (...args: Parameters<ChatApi['inheritSession']>) => {
      const forked = await base.inheritSession(...args);
      return { ...forked, snapshot: decorated(forked.snapshot) };
    },
    setModelRoute: async (...args: Parameters<ChatApi['setModelRoute']>) =>
      decorated(await base.setModelRoute(...args)),
    setFast: async (...args: Parameters<ChatApi['setFast']>) => decorated(await base.setFast(...args)),
    readTranscriptHistory: (
      sessionId: string,
      request: DesktopTranscriptHistoryRequest,
      desktop = false
    ): Promise<DesktopTranscriptHistoryPage> => history.read(sessionId, request, desktop),
    readTranscriptItem: async (sessionId: string, itemId: string, replayToken?: string) => {
      try {
        return await base.readTranscriptItem(sessionId, itemId, replayToken);
      } catch (error) {
        const held = replayToken === undefined ? history.heldRows(sessionId) : undefined;
        const output = held ? remoteToolOutput({ items: [...held.values()] }, itemId) : null;
        if (output) return output;
        throw error;
      }
    },
    provideSecretInput: async (requestId: string, value: string): Promise<boolean> => {
      const id = requiredString(requestId, 'secret request id', 120);
      const secret = typeof value === 'string' ? value : '';
      // secret-requests.ts provide(): the card's value for an id the runtime minted; anything else is not taken.
      if (!SECRET_REQUEST_ID.test(id) || !secret || secret.length > MAX_SECRET_LENGTH) return false;
      await send('approval/provideSecret', { requestId: id, secret });
      return true;
    },
    agentRoomAction: async (action: string, args: unknown[]): Promise<unknown> => {
      const name = requiredString(action, 'action', 32);
      if (!ROOM_ACTIONS.has(name)) throw new TypeError(`Unknown room action "${name}".`);
      return base.agentRoomAction(name, Array.isArray(args) ? args : []);
    },
    openAgentHome: (agentId: string) => base.openAgentHome(requiredString(agentId, 'agentId', 200)),
    resetAgentHome: (agentId: string) => base.resetAgentHome(requiredString(agentId, 'agentId', 200)),
  };
}

export type ChatHostApi = ReturnType<typeof createChatHostApi>;
