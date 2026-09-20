/** The bridge's HTTP surface: the authenticated health probe and the command
 *  endpoint. A dropped connection is the caller's abort. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bridgeDiscoveryPublicIdentity } from '../../bridge/discovery-ownership';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { isComputerLifecycleControl } from './action-sets';
import type { BridgeServerHost, BridgeServerState } from './bridge-server-contract';
import { assertPublicComputerRequest } from './request-policy';
import {
  MAX_COMPUTER_REQUEST_BYTES,
  MAX_COMPUTER_RESPONSE_BYTES,
  validateComputerReply,
} from '../../../../../../src/runtime/computer-bridge/limits.mjs';

type Respond = (response: ServerResponse, status: number, body: Record<string, unknown>) => void;

export interface BridgeRequestContext {
  host: Pick<BridgeServerHost, 'abortComputerSession' | 'executeSerialized' | 'reapIdleSessionWorkers' | 'waitForUser'>;
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
    if (command.action === 'session_abort') return host.abortComputerSession(command);
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
    state.activeRequests++;
    // The heartbeat alone reclaims too late: a burst of short sessions can
    // exhaust the worker limit between two beats, and the caller owns none
    // of those sessions. Reclaim on the request path as well.
    host.reapIdleSessionWorkers();
    const disconnect = watchDisconnect(request, response, command, host.abortComputerSession);
    try {
      const value = await runCommand(command, disconnect.signal);
      validateComputerReply(value);
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_COMPUTER_RESPONSE_BYTES) {
        throw new Error('computer response exceeds byte limit; input may have executed and was not replayed');
      }
      if (!disconnect.clientGone()) respond(response, 200, { ok: true, value });
    } catch (error) {
      if (!disconnect.clientGone()) {
        respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
      }
    } finally {
      state.activeRequests--;
      disconnect.release();
    }
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
      if (request.method !== 'POST' || request.url !== '/command') {
        respond(response, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!authorized(request)) {
        respond(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      await handleCommand(request, response);
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        /* already gone */
      }
    });
  };
}
