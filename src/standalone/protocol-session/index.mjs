// Production assembly of the TUI session view: the real core discovery, WebSocket connector and
// `@mixdog/protocol-client` engine. Tests build the factory from `./session.mjs` with their own transport.
import { readFileSync } from 'node:fs';
import { sleep } from '../../runtime/shared/sleep.mjs';
import { ensureCore } from './ensure-core.mjs';
import { createProtocolSessionFactory } from './session.mjs';
import { createWebSocketConnector } from './ws-connector.mjs';

const CLIENT_LIBRARY = new URL('../../../packages/protocol-client/src/', import.meta.url);

let factory = null;

function clientVersion() {
  return String(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version);
}

async function assemble() {
  const { connect, uuidv7, sessionReducer, sessionStateOf } = await import(new URL('index.ts', CLIENT_LIBRARY).href);
  return createProtocolSessionFactory({
    connect,
    connector: createWebSocketConnector(),
    ensureCore,
    threadReducer: sessionReducer,
    stateOf: sessionStateOf,
    clientInfo: { name: 'mixdog-tui', title: 'Mixdog TUI', version: clientVersion(), kind: 'tui' },
    clock: { sleep },
    random: Math.random,
    newOpId: () => uuidv7(Date.now()),
  });
}

/** The session view the TUI holds (same facade `createSession` has always returned). */
export async function createSession(options = {}) {
  factory ??= assemble().catch((error) => {
    factory = null;
    throw error;
  });
  return (await factory)(options);
}
