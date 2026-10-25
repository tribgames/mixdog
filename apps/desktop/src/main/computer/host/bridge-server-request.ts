/** The bridge's HTTP surface: the authenticated health probe and the command
 *  endpoint. A dropped connection is the caller's abort. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bridgeDiscoveryPublicIdentity } from '../../bridge/discovery-ownership';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { computerUseCoordinator } from '../session/coordinator';
import { isComputerLifecycleControl, READ_ACTIONS } from './action-sets';
import { bindComputerSecret, secretInputs, typeComputerSecret } from '../../secret-input';
import type { BridgeServerHost, BridgeServerState } from './bridge-server-contract';
import { assertPublicComputerRequest } from './request-policy';
import { reconcileSavedLoginOwners } from './saved-login';
import {
  MAX_COMPUTER_REQUEST_BYTES,
  MAX_COMPUTER_RESPONSE_BYTES,
  validateComputerReply,
} from '../../../../../../src/runtime/computer-bridge/limits.mjs';

type Respond = (response: ServerResponse, status: number, body: Record<string, unknown>) => void;

export interface BridgeRequestContext {
  host: Pick<
    BridgeServerHost,
    'abortComputerSession' | 'executeSerialized' | 'reapIdleSessionWorkers' | 'waitForUser' | 'processFate'
  >;
  state: BridgeServerState;
  respond: Respond;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_COMPUTER_REQUEST_BYTES) throw new Error('computer request exceeds byte limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** A dropped connection is the only cancellation signal left when the
 *  runtime dies before it can send session_abort. Without this the queued
 *  input keeps driving the user's desktop until the command timeout. */
function watchDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
  command: ComputerCommand,
  abortComputerSession: BridgeRequestContext['host']['abortComputerSession']
) {
  let clientGone = false;
  const requestAbort = new AbortController();
  const abortOnDisconnect = (): void => {
    if (clientGone) return;
    clientGone = true;
    requestAbort.abort();
    if (command.action === 'wait_for_user') return;
    if (isComputerLifecycleControl(command)) return;
    void abortComputerSession(command).catch(() => {
      /* host already idle */
    });
  };
  request.once('aborted', abortOnDisconnect);
  response.once('close', () => {
    if (!response.writableEnded) abortOnDisconnect();
  });
  return {
    signal: requestAbort.signal,
    clientGone: () => clientGone,
    release: () => request.removeListener('aborted', abortOnDisconnect),
  };
}

export function createBridgeRequestHandler(
  context: BridgeRequestContext,
  activeToken: string,
  generation: number
): (request: IncomingMessage, response: ServerResponse) => void {
  const { host, state, respond } = context;
  const authorized = (request: IncomingMessage): boolean =>
    String(request.headers.authorization || '') === `Bearer ${activeToken}`;

  function handleHealth(response: ServerResponse): void {
    const identity = state.discoveryRecord;
    if (!identity || identity.token !== activeToken || identity.generation !== generation) {
      respond(response, 503, { ok: false, error: 'bridge generation is not active' });
      return;
    }
    respond(response, 200, { ok: true, identity: bridgeDiscoveryPublicIdentity(identity) });
  }

  function runCommand(command: ComputerCommand, signal: AbortSignal): Promise<ComputerCommandResult> {
    if (command.action === 'wait_for_user' && host.waitForUser) return host.waitForUser(command, signal);
    const sessionId = String(command.session_id || '');
    // Runtime-only: bind a secret request to its window and field at request
    // time, then type the secret the user handed the desktop (secret-input.ts).
    if (command.action === 'secret_bind') {
      return Promise.resolve(bindComputerSecret(command as Parameters<typeof bindComputerSecret>[0]));
    }
    if (command.action === 'secret_input') {
      return typeComputerSecret(command as Parameters<typeof typeComputerSecret>[0], (typed) =>
        host.executeSerialized(typed as unknown as ComputerCommand)
      );
    }
    // While a typed secret's field may hold focus, no capture leaves the host;
    // the next input action (which moves on) lifts the hold.
    if (secretInputs.focusArmed(sessionId)) {
      if (READ_ACTIONS.has(command.action)) {
        return Promise.reject(
          new Error('capture_withheld: a secret field may be focused; move focus (Tab or a click elsewhere) first')
        );
      }
      if (!isComputerLifecycleControl(command)) secretInputs.clearFocus(sessionId);
    }
    // The runtime's authoritative settlement of one agent turn: no fill of that
    // turn (or an older one of the session) is admitted from here on, and the
    // saved-login protection they set up retires once those still running
    // have finished. Input cleanup (execution_end, session_abort,
    // session_release) never retires it, and a late settlement never reaches
    // a newer turn (secret-input.ts).
    if (command.action === 'turn_settle') {
      const turnId = Number(command.turn_id);
      const ownerId = typeof command.runtime_id === 'string' ? command.runtime_id : '';
      if (!sessionId || !Number.isSafeInteger(turnId) || turnId < 1 || !ownerId) {
        return Promise.reject(
          new Error('invalid_request: turn_settle needs a session_id, a positive turn_id and a runtime_id')
        );
      }
      void secretInputs.settleSavedLoginTurn({ sessionId, turnId, ownerId });
      return Promise.resolve({ text: 'turn settlement accepted' });
    }
    if (command.action === 'session_abort') {
      // The caller aborts when its turn is cancelled; that turn never sends
      // execution_end, so its visible execution and any pause it held end here.
      return host.abortComputerSession(command).then((result) => {
        computerUseCoordinator.endExecution(String(command.session_id || 'default'));
        return result;
      });
    }
    return host.executeSerialized(command);
  }

  async function handleCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let command: ComputerCommand;
    try {
      const value: unknown = JSON.parse(await readRequestBody(request));
      assertPublicComputerRequest(value);
      command = value;
    } catch (error) {
      respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
      return;
    }
    if (state.activeRequests >= (isComputerLifecycleControl(command) ? 40 : 32)) {
      respond(response, 429, { ok: false, error: 'computer_capacity_exhausted: too many active requests' });
      return;
    }
    // A saved-login fill counts as running from the moment it is accepted,
    // before any queueing or target preparation, so its turn's settlement
    // waits for it; one of a settled turn or an absent owner is refused here.
    let finishFill: (() => void) | null = null;
    if (command.action === 'fill_saved_login') {
      const admitted = secretInputs.admitSavedLoginFill({
        sessionId: String(command.session_id || ''),
        turnId: Number(command.turn_id),
        ownerId: typeof command.runtime_id === 'string' ? command.runtime_id : '',
      });
      if (typeof admitted === 'string') {
        respond(response, 200, { ok: false, error: `saved_login_unavailable: ${admitted}; no input was sent` });
        return;
      }
      finishFill = admitted;
    }
    state.activeRequests++;
    // The heartbeat alone reclaims too late: a burst of short sessions can
    // exhaust the worker limit between two beats, and the caller owns none
    // of those sessions. Reclaim on the request path as well.
    host.reapIdleSessionWorkers();
    const disconnect = watchDisconnect(request, response, command, host.abortComputerSession);
    try {
      const value = await runCommand(command, disconnect.signal);
      // A secret typed in this session never comes back in a reply.
      if (typeof value?.text === 'string')
        value.text = secretInputs.redact(String(command.session_id || ''), value.text);
      // Nor do the pixels of a field a saved login was typed into, whatever
      // recovery observation a failed fill came back with.
      if (command.action === 'fill_saved_login') delete value.image;
      validateComputerReply(value);
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_COMPUTER_RESPONSE_BYTES) {
        throw new Error('computer response exceeds byte limit; input may have executed and was not replayed');
      }
      if (!disconnect.clientGone()) respond(response, 200, { ok: true, value });
    } catch (error) {
      if (!disconnect.clientGone()) {
        // Errors are model-bound too: a remembered secret never comes back in one.
        const message = (error as Error).message || String(error);
        respond(response, 200, { ok: false, error: secretInputs.redact(String(command.session_id || ''), message) });
      }
    } finally {
      state.activeRequests--;
      disconnect.release();
      finishFill?.();
    }
  }

  /** A runtime's saved-login owner connection (secret-input.ts SavedLoginTurn):
   *  its process is bound by id and OS creation time, then the connection is
   *  answered and held open. Its close, whichever side ended it, only
   *  detaches; an owner's protection retires early only when the OS proves
   *  its process ended (reconcileSavedLoginOwners), checked here as its
   *  connection detaches and whenever any owner attaches, and by a capture
   *  its guard would withhold (saved-login.ts assertSavedLoginPixelsAllowed). */
  async function handleOwner(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let ownerId = '';
    let pid = 0;
    const fate = host.processFate;
    // Watched before the first await: a connection that closes while its
    // body or its process is read is never attached, and one attached later
    // detaches exactly once.
    let closed = false;
    let detach: (() => void) | null = null;
    response.once('close', () => {
      closed = true;
      const release = detach;
      detach = null;
      if (!release) return;
      release();
      if (fate) void reconcileSavedLoginOwners(fate);
    });
    try {
      const value = JSON.parse(await readRequestBody(request)) as { runtime_id?: unknown; pid?: unknown };
      ownerId = typeof value?.runtime_id === 'string' ? value.runtime_id : '';
      pid = Number(value?.pid);
    } catch {
      /* answered below */
    }
    const identity = fate && Number.isSafeInteger(pid) && pid > 0 ? await fate({ pid, created: '' }).catch(() => null) : null;
    if (closed) return;
    detach =
      identity?.state === 'running' ? secretInputs.attachSavedLoginOwner(ownerId, { pid, created: identity.created }) : null;
    if (!detach || !fate) {
      respond(response, 400, { ok: false, error: 'invalid request: unknown or ended runtime owner' });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.write('{"ok":true}\n');
    void reconcileSavedLoginOwners(fate);
  }

  return (request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') {
        if (!authorized(request)) {
          respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        handleHealth(response);
        return;
      }
      if (request.method !== 'POST' || (request.url !== '/command' && request.url !== '/owner')) {
        respond(response, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!authorized(request)) {
        respond(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (request.url === '/owner') await handleOwner(request, response);
      else await handleCommand(request, response);
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        /* already gone */
      }
    });
  };
}
