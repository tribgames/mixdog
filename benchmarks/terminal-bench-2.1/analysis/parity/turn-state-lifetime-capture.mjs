#!/usr/bin/env node
// The lifetime of a Codex turn state in Node, step by step, through Node's own functions: a socket's frame
// (`_withCodexWsClientMetadata`, which activates the frame's turn with the socket as owner), a response event on a
// socket (`_captureTurnStateFromEvent`), a socket closing (`_onEntryClosed` → `retireCodexTurnStateOwner(poolKey,
// entry)`, `openai-ws-pool.mjs:812`), an HTTP request (`activateCodexTurnState(poolKey, turnId)`,
// `openai-oauth-http-sse.mjs:93`) and its answer (`captureCodexTurnState(poolKey, turnId, header)`,
// `openai-http-sse-request.mjs:274`), and the session's sockets closed (`clearCodexTurnStateScope(poolKey)`,
// `openai-ws-pool.mjs:977`). What each frame and HTTP request carries as `x-codex-turn-state` is recorded.
// Events go only to a socket that holds no token, where `_captureTurnStateFromEvent` does not return early.
// Usage: node turn-state-lifetime-capture.mjs <node-tree> --node-commit <sha> --out <file>
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const providers = join(tree, 'src/runtime/agent/orchestrator/providers');
const load = (file) => import(pathToFileURL(join(providers, file)).href);
const { _withCodexWsClientMetadata } = await load('openai-codex-metadata.mjs');
const { _captureTurnStateFromEvent } = await load('openai-ws-stream/turn-state-headers.mjs');
const { activateCodexTurnState, captureCodexTurnState, retireCodexTurnStateOwner, clearCodexTurnStateScope } = await load('openai-turn-state.mjs');

const POOL = 'pool-a';
const INSTALLATION = '11111111-2222-4333-8444-555555555555';
const STEPS = [
  { do: 'frame', socket: 1, turn: 'turn-1' },
  { do: 'event', socket: 1, token: 'ts-1' },
  { do: 'frame', socket: 1, turn: 'turn-1' },
  { do: 'frame', socket: 2, turn: 'turn-1' },
  { do: 'event', socket: 2, token: 'ts-2' },
  { do: 'http', turn: 'turn-1' },
  { do: 'close', socket: 1 },
  { do: 'frame', socket: 2, turn: 'turn-1' },
  { do: 'frame', socket: 2, turn: 'turn-2' },
  { do: 'frame', socket: 2, turn: 'turn-2' },
  { do: 'frame', socket: 2, turn: 'turn-1' },
  { do: 'http', turn: 'turn-2' },
  { do: 'answer', turn: 'turn-2', token: 'ts-h' },
  { do: 'http', turn: 'turn-2' },
  { do: 'frame', socket: 2, turn: 'turn-2' },
  { do: 'frame', socket: 3, turn: 'turn-3' },
  { do: 'close', socket: 3 },
  { do: 'frame', socket: 2, turn: 'turn-3' },
  { do: 'event', socket: 2, token: 'ts-3' },
  { do: 'frame', socket: 2, turn: 'turn-3' },
  { do: 'session-closed' },
  { do: 'frame', socket: 2, turn: 'turn-3' },
  { do: 'http', turn: 'turn-3' },
];

const sockets = new Map();
const socket = (n) => {
  if (!sockets.has(n)) sockets.set(n, { turnState: null, turnStateScope: null, turnStateTurnId: null });
  return sockets.get(n);
};
const steps = STEPS.map((step) => {
  switch (step.do) {
    case 'frame': {
      const context = { poolKey: POOL, sendOpts: { turnId: step.turn, installationId: INSTALLATION, sessionId: 'session-a' } };
      const frame = _withCodexWsClientMetadata({ type: 'response.create' }, socket(step.socket), true, context);
      return { ...step, sent: frame.client_metadata['x-codex-turn-state'] ?? null };
    }
    case 'event':
      if (socket(step.socket).turnState) throw new Error('an event to a socket holding a token is not a case here');
      _captureTurnStateFromEvent(socket(step.socket), { type: 'response.created', headers: { 'x-codex-turn-state': step.token } });
      return step;
    case 'close':
      retireCodexTurnStateOwner(socket(step.socket).turnStateScope || POOL, socket(step.socket));
      sockets.delete(step.socket);
      return step;
    case 'http':
      return { ...step, sent: activateCodexTurnState(POOL, step.turn) };
    case 'answer':
      captureCodexTurnState(POOL, step.turn, step.token);
      return step;
    case 'session-closed':
      clearCodexTurnStateScope(POOL);
      return step;
    default:
      throw new Error(step.do);
  }
});
const self = fileURLToPath(import.meta.url);
const manifest = { exact: true, nodeCommit: arg('--node-commit'), node: process.version, pool: POOL, harness: { 'turn-state-lifetime-capture.mjs': crypto.createHash('sha256').update(readFileSync(self)).digest('hex') } };
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, steps }, null, 1)}\n`);
console.log(steps.map((s) => JSON.stringify(s)).join('\n'));
