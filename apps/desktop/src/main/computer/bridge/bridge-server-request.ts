/** The bridge's HTTP surface: the authenticated health probe, the command endpoint and the saved-login owner
 *  endpoint. A command is checked against the request policy here and runs in the core; a dropped connection is the
 *  caller's abort. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bridgeDiscoveryPublicIdentity } from '../../bridge/discovery-ownership';
import { MAX_COMPUTER_REQUEST_BYTES } from '../../../shared/core-src/runtime/computer-bridge/limits.mjs';
import type { ComputerBridgeRunResult } from '../../../../../../packages/protocol/src/index.ts';
import type { BridgeServerHost, BridgeServerState } from './bridge-server-contract';
import { runOnCore, sessionKeyOf } from './bridge-command-dispatch';
import { assertPublicComputerRequest, type BridgeCommand } from './request-policy';

type Respond = (response: ServerResponse, status: number, body: Record<string, unknown>) => void;

export interface BridgeRequestContext {
  host: Pick<BridgeServerHost, 'callCore'>;
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

/** A dropped connection is the only cancellation signal left when the runtime dies before it can send session_abort.
 *  Without this the queued input keeps driving the user's desktop until the command timeout. */
function watchDisconnect(request: IncomingMessage, response: ServerResponse) {
  let clientGone = false;
  const requestAbort = new AbortController();
  const abortOnDisconnect = (): void => {
    if (clientGone) return;
    clientGone = true;
    requestAbort.abort();
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

/** The health probe: answered only for the generation this handler serves. */
function respondHealth(
  response: ServerResponse,
  state: BridgeServerState,
  respond: Respond,
  activeToken: string,
  generation: number
): void {
  const identity = state.discoveryRecord;
  if (!identity || identity.token !== activeToken || identity.generation !== generation) {
    respond(response, 503, { ok: false, error: 'bridge generation is not active' });
    return;
  }
  respond(response, 200, { ok: true, identity: bridgeDiscoveryPublicIdentity(identity) });
}

/** The request body as a public command; throws why it is not one. */
async function readPublicCommand(request: IncomingMessage): Promise<BridgeCommand> {
  const value: unknown = JSON.parse(await readRequestBody(request));
  assertPublicComputerRequest(value);
  return value;
}

/** What the bridge answers for one command's result from the core: the HTTP status and the wire body. */
function answerOf(result: ComputerBridgeRunResult): { status: number; body: Record<string, unknown> } {
  if (result?.ok === true && result.value) return { status: 200, body: { ok: true, value: result.value } };
  return {
    status: typeof result?.status === 'number' ? result.status : 200,
    body: { ok: false, error: typeof result?.error === 'string' ? result.error : 'computer bridge returned no answer' },
  };
}

/** The command's result from the core, or the failure of the call as a failed result. */
async function runCommand(
  host: Pick<BridgeServerHost, 'callCore'>,
  command: BridgeCommand,
  signal: AbortSignal
): Promise<ComputerBridgeRunResult> {
  try {
    return await runOnCore(host.callCore, command, signal);
  } catch (error) {
    return { ok: false, error: (error as Error)?.message || String(error) };
  }
}

async function handleCommand(
  context: BridgeRequestContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const { host, state, respond } = context;
  let command: BridgeCommand;
  try {
    command = await readPublicCommand(request);
  } catch (error) {
    respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
    return;
  }
  state.sessions.add(sessionKeyOf(command));
  const disconnect = watchDisconnect(request, response);
  try {
    const answer = answerOf(await runCommand(host, command, disconnect.signal));
    if (!disconnect.clientGone()) respond(response, answer.status, answer.body);
  } finally {
    disconnect.release();
  }
}

/** The owner a connection claims: empty and 0 when its body cannot be read. */
async function readOwnerClaim(request: IncomingMessage): Promise<{ ownerId: string; pid: number }> {
  try {
    const value = JSON.parse(await readRequestBody(request)) as { runtime_id?: unknown; pid?: unknown };
    return { ownerId: typeof value?.runtime_id === 'string' ? value.runtime_id : '', pid: Number(value?.pid) };
  } catch {
    return { ownerId: '', pid: 0 };
  }
}

/** A runtime's saved-login owner connection: the core binds the owner to its process by id and OS creation time
 *  (`owner_attach`), then the connection is answered and held open. Its close, whichever side ended it, only
 *  detaches (`owner_detach`); an owner's protection retires early only when the OS proves its process ended, which
 *  the core checks. */
async function handleOwner(
  host: Pick<BridgeServerHost, 'callCore'>,
  request: IncomingMessage,
  response: ServerResponse,
  respond: Respond
): Promise<void> {
  const detachOwner = (ownerId: string): void => {
    void runCommand(host, { action: 'owner_detach', runtime_id: ownerId }, new AbortController().signal);
  };
  // Watched before the first await: a connection that closes while its body or its process is read is never
  // attached, and one attached later detaches exactly once.
  let closed = false;
  let detach: (() => void) | null = null;
  response.once('close', () => {
    closed = true;
    const release = detach;
    detach = null;
    release?.();
  });
  const { ownerId, pid } = await readOwnerClaim(request);
  const attached =
    Number.isSafeInteger(pid) && pid > 0
      ? await runCommand(host, { action: 'owner_attach', runtime_id: ownerId, pid }, new AbortController().signal)
      : null;
  if (closed) {
    // Attached for a connection that is already gone: it ends at once.
    if (attached?.ok) detachOwner(ownerId);
    return;
  }
  if (!attached?.ok) {
    respond(response, 400, { ok: false, error: 'invalid request: unknown or ended runtime owner' });
    return;
  }
  detach = () => detachOwner(ownerId);
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.write('{"ok":true}\n');
}

export function createBridgeRequestHandler(
  context: BridgeRequestContext,
  activeToken: string,
  generation: number
): (request: IncomingMessage, response: ServerResponse) => void {
  const { host, state, respond } = context;
  const authorized = (request: IncomingMessage): boolean =>
    String(request.headers.authorization || '') === `Bearer ${activeToken}`;

  return (request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') {
        if (!authorized(request)) {
          respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        respondHealth(response, state, respond, activeToken, generation);
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
      if (request.url === '/owner') await handleOwner(host, request, response, respond);
      else await handleCommand(context, request, response);
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        /* already gone */
      }
    });
  };
}
