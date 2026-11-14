/**
 * The loopback browser bridge of the Node-hosted runtime, forwarding to the core: every command the runtime's `browser` tool posts is
 * run by the core's browser command path (`browser/bridge/run`; a turn's start or end by `browser/bridge/turn`; a dropped caller by
 * `browser/bridge/abort`). The HTTP contract, `browser-bridge.json` and the timing of a reply are bridge-server.ts's, as before; the
 * tool's validation, the runtime-only actions, the approval cards, the 32-command allowance and the redaction of the session's
 * secrets are the core's.
 */
import { bridgeDiscoveryDirectory } from '../bridge/discovery-file';
import type { BrowserCommand } from './host-types';
import { BridgeCommandFailure, BrowserBridgeServer } from './bridge-server';
import { assertBrowserTaskCleanupContext } from './host-policy';
import { redactBrowserText } from './redaction';

const RUN = 'browser/bridge/run';
const TURN = 'browser/bridge/turn';
const ABORT = 'browser/bridge/abort';

/** What the connection to the core offers (`HostConnection.request`): rejects when the core is not reachable. */
export type CoreRequest = (method: string, params: unknown) => Promise<unknown>;

/** The pane side of the bridge's life: debuggers on the visible pages while it serves, the idle reclaim timer and the end of the
 *  agent-only pages (the command runner's own start, ready, inactive and end). */
export interface BridgeLifecycle {
  begin(): void;
  ready(): void;
  inactive(): void;
  end(): void;
}

export interface BrowserBridgeForwardOptions {
  request: CoreRequest;
  lifecycle: BridgeLifecycle;
  /** Where the discovery file is published (default: the shared bridge directory). */
  dataDirectory?: string | (() => string);
  keepAliveMs?: number;
  /** The redaction of an error's message (the host's own policy by default; a seam for tests). */
  redactError?: (value: string) => string;
}

interface BridgeReply {
  ok?: boolean;
  value?: unknown;
  error?: unknown;
  timing?: unknown;
  status?: unknown;
}

let nextSignal = 0;

function failure(reply: BridgeReply): BridgeCommandFailure {
  const status = typeof reply.status === 'number' ? reply.status : undefined;
  return new BridgeCommandFailure(typeof reply.error === 'string' && reply.error ? reply.error : 'browser command failed', reply.timing, status);
}

function answer(raw: unknown): unknown {
  const reply = (raw && typeof raw === 'object' ? raw : {}) as BridgeReply;
  if (reply.ok === true) return reply.value;
  throw failure(reply);
}

/** The same check the bridge made of a turn's start or end before it marked it. */
function turnParams(command: BrowserCommand & Record<string, unknown>): Record<string, unknown> {
  const { session_id, turn_id, internalStep, unattended_run, unattended_agent, session_life, mail_link, ...input } = command;
  if (internalStep !== undefined) throw new Error('internalStep is not a bridge input');
  assertBrowserTaskCleanupContext(session_id, turn_id, input);
  return {
    phase: input.action === 'begin_turn' ? 'begin' : 'finish',
    sessionId: session_id,
    turnId: turn_id,
    ...(input.aborted === true ? { aborted: true } : {}),
  };
}

/** One command through the core; `signal` ending it (the runtime's connection dropped) stops the core's work too. */
export function forwardBrowserCommand(request: CoreRequest, command: BrowserCommand, signal: AbortSignal): Promise<unknown> {
  const fields = command as BrowserCommand & Record<string, unknown>;
  const isTurn = fields.action === 'begin_turn' || fields.action === 'finish_turn';
  if (isTurn) {
    try {
      return request(TURN, turnParams(fields)).then(answer);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const signalId = `browser-bridge-${++nextSignal}`;
  const running = request(RUN, { command, signalId });
  const stopped = new Promise<never>((_, reject) => {
    const stop = (): void => {
      void request(ABORT, { signalId }).catch(() => undefined);
      reject(signal.reason instanceof Error ? signal.reason : new Error('browser command cancelled'));
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    void running.then(
      () => signal.removeEventListener('abort', stop),
      () => signal.removeEventListener('abort', stop)
    );
  });
  stopped.catch(() => undefined);
  return Promise.race([running.then(answer), stopped]);
}

export function createBrowserBridgeForward(options: BrowserBridgeForwardOptions) {
  const { request, lifecycle } = options;
  const server = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: options.dataDirectory ?? bridgeDiscoveryDirectory,
    keepAliveMs: options.keepAliveMs,
    execute: (command, signal) => forwardBrowserCommand(request, command, signal),
    redactError: options.redactError ?? redactBrowserText,
    onReady: () => lifecycle.ready(),
    onInactive: () => lifecycle.inactive(),
  });
  return {
    start(): void {
      lifecycle.begin();
      server.start();
    },
    async stop(): Promise<void> {
      await server.stop();
      lifecycle.end();
    },
  };
}
