// PH-2 "Chat" calls that need more than a request mapping, over `mixdogd`: the three start calls (Node's blank snapshot, no
// thread), the remote-session fields every snapshot carries, transcript paging, the stale-view refusal, and the refusal
// texts. Each answers what Node's host (b6f10295a) answered the phone; the expectations are its recordings
// (native/core/fixtures/phone-chat/host.json, remote-protocol-chat-host.test.mjs).
//
// It wraps the base adapter of remote-protocol-chat.ts (`createChatApi`) and replaces only the calls it owns:
//   import { createChatHostApi } from './remote-protocol-chat-host.ts';
//   const api = createChatHostApi(client, shared, createChatApi(client, shared, options), hostOptions);
import type {
  DesktopNewTaskSubmitResult,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopTranscriptHistoryPage,
  DesktopTranscriptHistoryRequest,
  SessionSnapshot,
} from '../shared/contract';
import { blankSnapshot, remoteSessionIdOf, startFolder, withRemoteSession } from '../shared/blank-snapshot.ts';
import type { StartCall } from '../shared/blank-snapshot.ts';
import { viewIsStale } from '../main/remote-view-staleness.ts';
import type { ChatApi, ChatClient, ChatShared } from './remote-protocol-chat.ts';
import { READ_NOT_VIEWED } from './remote-protocol-chat.ts';

/** remote-methods.ts STALE_SESSION_VIEW_MESSAGE. */
export const STALE_SESSION_VIEW_MESSAGE = 'This conversation changed on another device. Review the latest messages, then send again.';

/** ipc-validation.ts: the page size of a historical-position read. */
const HISTORY_PAGE_ITEMS = 512;
const HISTORY_ROW_ID_MAX_CHARS = 512;
const HISTORY_POSITION = /^(?:s:\d{1,15}:\d{1,15}|a:\d{1,15}:\d{1,15}:\d{1,15})$/;
/** session-service transcript-window.mjs: the newest rows read to judge what the connection has not been shown. */
const LATEST_ROWS = HISTORY_PAGE_ITEMS;
/** secret-requests.ts */
const SECRET_REQUEST_ID = /^secret_[A-Za-z0-9-]{8,80}$/;
const MAX_SECRET_LENGTH = 4_096;
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
    (input.position != null && (typeof input.position !== 'string' || !HISTORY_POSITION.test(input.position)))
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

/** Whether Node's submission intake would take this prompt: `promptDisplayText` (queue-helpers.mjs:89) of it is not blank, or the submit names a
 *  display text (submission.mjs:14-15 answers `false` otherwise, and the host's reply is `false` / `accepted: false`). The text is
 *  `promptContentText` (prompt-utils.mjs:10) of the content without its attachment-reference parts. The core takes a blank prompt and
 *  starts an empty turn, so the refusal is made here, before anything is sent. */
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

const reasonOf = (error: unknown): unknown => (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;

export function createChatHostApi(client: ChatClient, shared: ChatHostShared, base: ChatApi, options: ChatHostOptions) {
  const remoteId = (): string => remoteSessionIdOf(options.remoteSession());
  const decorated = <T>(snapshot: T): T => withRemoteSession(snapshot, remoteId());
  const send = (method: string, params: unknown): Promise<unknown> =>
    client.call(method, params).catch((error: unknown) => {
      throw shared.coreErrorForWindow(error);
    });
  const start = async (call: StartCall, projectPath?: string): Promise<SessionSnapshot> => {
    const { cwd, projectPath: project } = await startFolder(({ method, params }) => send(method, params), call, projectPath);
    return blankSnapshot(cwd, project, remoteId());
  };
  /** The rows the core holds newest in a thread, as the transcript rows this client would fold. */
  const latestRows = async (threadId: string): Promise<unknown[]> => {
    const page = (await send('thread/items/list', { threadId, limit: LATEST_ROWS })) as { data?: unknown[] };
    return shared.foldRows(page.data ?? []);
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
    startProject: (projectPath: string): Promise<SessionSnapshot> => start('startProject', requiredString(projectPath, 'projectPath')),
    startProjectTask: (projectPath: string): Promise<SessionSnapshot> => start('startProjectTask', requiredString(projectPath, 'projectPath')),
    submitToSession: async (sessionId: string, prompt: DesktopPromptContent, submit: DesktopSubmitOptions = {}): Promise<boolean> => {
      if (await staleView(sessionId)) throw new Error(STALE_SESSION_VIEW_MESSAGE);
      if (!showsText(prompt, submit)) return false;
      return base.submitToSession(sessionId, prompt, submit);
    },
    submitNewTask: async (
      prompt: DesktopPromptContent,
      submit: DesktopSubmitOptions = {},
      draft: Parameters<ChatApi['submitNewTask']>[2] = {}
    ): Promise<DesktopNewTaskSubmitResult> => {
      if (!showsText(prompt, submit)) return { accepted: false, sessionId: '', snapshot: null } as unknown as DesktopNewTaskSubmitResult;
      return decorated(await base.submitNewTask(prompt, submit, draft)) as DesktopNewTaskSubmitResult;
    },
    inheritSession: async (...args: Parameters<ChatApi['inheritSession']>) => {
      const forked = await base.inheritSession(...args);
      return { ...forked, snapshot: decorated(forked.snapshot) };
    },
    setModelRoute: async (...args: Parameters<ChatApi['setModelRoute']>) => decorated(await base.setModelRoute(...args)),
    setFast: async (...args: Parameters<ChatApi['setFast']>) => decorated(await base.setFast(...args)),
    readTranscriptHistory: async (sessionId: string, request: DesktopTranscriptHistoryRequest): Promise<DesktopTranscriptHistoryPage> => {
      const history = requiredTranscriptHistoryRequest(request);
      if (!shared.sessionStateOf(sessionId)) throw new Error(READ_NOT_VIEWED);
      const older = 'before' in history;
      const anchor = (history as { before?: string; after?: string })[older ? 'before' : 'after'];
      let page: { data?: unknown[]; hasOlder?: boolean; hasNewer?: boolean };
      try {
        page = (await send('thread/items/list', {
          threadId: sessionId,
          cursor: { type: 'item', itemId: anchor },
          sortDirection: older ? 'desc' : 'asc',
          limit: history.limit,
          ...(history.byteBudget ? { byteBudget: history.byteBudget } : {}),
        })) as typeof page;
      } catch (error) {
        // The row is gone (a rewind or a clear): the reader returns to the live tail.
        if (reasonOf(error) === 'cursorInvalidated') return { items: [], hasOlder: false, hasNewer: false, reset: true } as DesktopTranscriptHistoryPage;
        throw error;
      }
      return { items: shared.foldRows(page.data ?? []), hasOlder: page.hasOlder === true, hasNewer: page.hasNewer === true } as DesktopTranscriptHistoryPage;
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

