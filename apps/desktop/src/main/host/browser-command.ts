/**
 * `host/browser/command{action, input, threadId}` → result. The core owns the
 * tool contract, approvals and grants; this host runs the command on the
 * in-app browser through the same runner the loopback bridge used, so
 * results and redaction are unchanged. A failure is a JSON-RPC error whose
 * message is redacted and whose `data.timing` carries the failure timing.
 */
import type { HostCommandParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteBrowserControl } from '../../shared/contract';
import {
  normalizeBrowserCredentialId,
  normalizeBrowserHistoryQuery,
  normalizeBrowserImportRequest,
  normalizeRemoteBrowserControl,
  normalizeRemoteBrowserTabId,
} from '../../shared/remote-browser';
import { requiredSessionId } from '../desktop-state';
import { type BrowserRemoteMethod, normalizeRemoteTabUrl } from '../remote-browser-methods';
import type { BrowserCommand } from '../browser/command';
import { redactBrowserText } from '../browser/redaction';
import { browserFailureTiming } from '../browser/timing';
import {
  HOST_COMMAND_FAILED,
  HOST_INVALID_PARAMS,
  HOST_METHOD,
  type HostConnection,
  HostRpcError,
  objectParams,
} from './connection';

/** Concurrent commands the host runs; more are refused, as the bridge refused. */
export const MAX_CONCURRENT_BROWSER_COMMANDS = 32;

export interface BrowserCommandRunner {
  execute(command: BrowserCommand, signal: AbortSignal): Promise<unknown>;
  /** Called when the host role is claimed / released. */
  begin(): void;
  ready(): void;
  inactive(): void;
  end(): void;
}

export function toBrowserCommand(params: unknown): BrowserCommand {
  const { action, input, threadId } = objectParams<HostCommandParams>(params, HOST_METHOD.browserCommand);
  if (typeof action !== 'string' || !action) {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'host/browser/command needs an action.');
  }
  const fields = input === undefined || input === null ? {} : objectParams(input, 'input');
  const session_id = typeof threadId === 'string' && threadId ? threadId : fields.session_id;
  return { ...fields, action, ...(session_id !== undefined ? { session_id } : {}) } as BrowserCommand;
}

/** The streamed page's human-input path (what the phone's gestures use). */
export interface BrowserInputControl {
  remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<unknown>;
  /** A client's non-tool browser request, run on the window process. */
  remote(method: BrowserRemoteMethod, args: unknown[]): Promise<unknown>;
}

/** The non-tool actions, each with the argument check Node applies at both of its entries
 *  (ipc-browser.ts, remote-browser-methods.ts); the core forwards without validating. */
const REMOTE_ACTIONS: Record<string, (session: unknown, fields: Record<string, unknown>) => unknown[]> = {
  history: (_session, fields) => [normalizeBrowserHistoryQuery(fields.query)],
  tabOpen: (_session, fields) => [normalizeRemoteTabUrl(fields.url)],
  release: (_session, fields) => [normalizeRemoteBrowserTabId(fields.id)],
  credentialSuggestions: (session) => [requiredSessionId(session)],
  credentialFill: (session, fields) => [
    requiredSessionId(session),
    normalizeBrowserCredentialId(fields.credentialId),
  ],
  importSources: () => [],
  importStart: (_session, fields) => [normalizeBrowserImportRequest(fields)],
};

/** The action a phone's gesture arrives as: not a tool action, so it never meets the tool validator. */
export const BROWSER_INPUT_ACTION = 'input';

/** What a tool action gets once the core drives the browser through the engine methods (`host/browser/*`). */
export const BROWSER_ENGINE_COMMAND_REFUSED =
  'This desktop serves the browser through the host/browser engine methods; host/browser/command takes no tool action while the core uses them.';

/**
 * `engineMode`: the core drives the browser through the engine lane (it has called an engine method on this
 * connection). The core then never sends a tool action here, so one is refused with a clear error; the
 * non-tool actions (a phone's input, history, tabs, credentials, import) are served in both.
 */
export function createBrowserCommandHost(
  connection: HostConnection,
  runner: BrowserCommandRunner,
  input: BrowserInputControl,
  engineMode: () => boolean = () => false
) {
  const running = new Set<AbortController>();

  connection.handleRequest(HOST_METHOD.browserCommand, async (params, signal) => {
    const command = toBrowserCommand(params);
    if (command.action === BROWSER_INPUT_ACTION) {
      const { action: _action, session_id, ...fields } = command;
      if (typeof session_id !== 'string' || !session_id) {
        throw new HostRpcError(HOST_INVALID_PARAMS, 'host/browser/command input needs a threadId.');
      }
      let control: DesktopRemoteBrowserControl;
      try {
        control = normalizeRemoteBrowserControl(fields);
      } catch (error) {
        throw new HostRpcError(HOST_INVALID_PARAMS, (error as Error).message);
      }
      // Dispatched with no await before it, so gestures keep their arrival order;
      // not counted against the command cap, which bounds tool work.
      try {
        return (await input.remoteBrowserControl(session_id, control)) ?? null;
      } catch (error) {
        throw new HostRpcError(HOST_COMMAND_FAILED, redactBrowserText((error as Error)?.message || String(error)));
      }
    }
    const remoteArgs = Object.hasOwn(REMOTE_ACTIONS, command.action) ? REMOTE_ACTIONS[command.action] : undefined;
    if (remoteArgs) {
      const { action, session_id, ...fields } = command as unknown as Record<string, unknown>;
      let args: unknown[];
      try {
        args = remoteArgs(session_id, fields);
      } catch (error) {
        throw new HostRpcError(HOST_INVALID_PARAMS, (error as Error).message);
      }
      try {
        // As the window-process request path answers: `result ?? null` (main/index.ts, browserRemoteResolve).
        return (await input.remote(action as BrowserRemoteMethod, args)) ?? null;
      } catch (error) {
        throw new HostRpcError(HOST_COMMAND_FAILED, redactBrowserText((error as Error)?.message || String(error)));
      }
    }
    if (engineMode()) throw new HostRpcError(HOST_COMMAND_FAILED, BROWSER_ENGINE_COMMAND_REFUSED);
    if (running.size >= MAX_CONCURRENT_BROWSER_COMMANDS) {
      throw new HostRpcError(HOST_COMMAND_FAILED, 'too many concurrent browser commands');
    }
    const controller = new AbortController();
    running.add(controller);
    const abandon = () => controller.abort(new Error('browser command abandoned'));
    if (signal.aborted) abandon();
    else signal.addEventListener('abort', abandon, { once: true });
    try {
      return await runner.execute(command, controller.signal);
    } catch (error) {
      const message = redactBrowserText((error as Error)?.message || String(error));
      throw new HostRpcError(HOST_COMMAND_FAILED, message, { timing: browserFailureTiming(error) });
    } finally {
      signal.removeEventListener('abort', abandon);
      running.delete(controller);
    }
  });

  return {
    /** The host role is ours: serve the browser. */
    start(): void {
      runner.begin();
      runner.ready();
    },
    /** The role or the connection is gone: abandon in-flight commands, drop agent-only pages. */
    stop(): void {
      for (const controller of running) controller.abort(new Error('browser host stopped'));
      running.clear();
      runner.inactive();
      runner.end();
    },
  };
}
