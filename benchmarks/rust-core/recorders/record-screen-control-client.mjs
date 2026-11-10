#!/usr/bin/env node
// Node's helper client after authentication (apps/desktop/src/main/secure-desktop/client.ts, `SecureDesktopClient`):
// the session view and its events, the fire-and-forget control writes (`setActive`, `setVideoRun`), the bounded sends
// (`sendInput`, `sendGrant`, `sas`: resolved once the write was handed to the pipe, rejected at once when not
// connected, when the write fails, when the connection ends first, or after the helper's frame deadline of
// `FRAME_DEADLINE_MS`), and `close`. Each scenario is a script against a fake pipe that plays the helper's side of the
// handshake (the real HMAC proofs, through the tree's own protocol code, with a fixed install secret) and then only
// records what the client writes, handing each write's outcome back when the script says; on virtual time (the send
// deadline). The handshake itself is not part of the trace: Rust's client starts from an authenticated link. The
// golden holds the script and the whole trace Node gave; Rust's client must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-client.mjs --tree <tree> [--only <scenario>])
import { VirtualTime, checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { createSecureDesktopClient } = await importTs(tree, 'apps/desktop/src/main/secure-desktop/client.ts');
const { FrameParser, decodeNonce, encodeControl, serverAuthTag } = await importTs(tree, 'apps/desktop/src/main/secure-desktop/protocol.ts');

const SECRET = Buffer.alloc(32, 7).toString('base64');
const SERVER_NONCE = Buffer.alloc(16, 9).toString('base64');
const HELLO = { type: 'server-hello', protocol: 4, version: '1.4.5', session: 1, desktop: 'Winlogon', locked: false };
const KEY = { kind: 'key', down: true, vk: 65, scan: 30, extended: false };
const GRANT = { challenge: 'c', epoch: 2, signature: 's' };

const settle = { op: 'settle' };
const advance = (ms) => ({ op: 'advance', ms });
const read = { op: 'session' };
const connected = [{ op: 'connect', as: 'connect' }, { op: 'await', call: 'connect' }];
const send = (as, what, extra = {}) => ({ op: 'send', as, what, ...extra });
const written = (n, error) => ({ op: 'written', n, ...(error ? { error } : {}) });
const done = (call) => ({ op: 'await', call });

const SCENARIOS = [
  {
    name: 'before a connection: the bounded sends are refused at once and the control writes do nothing',
    steps: [
      read,
      send('input', 'input', { event: KEY }),
      send('grant', 'grant', { grant: GRANT }),
      send('sas', 'sas'),
      { op: 'setActive', active: true },
      { op: 'videoRun', epoch: 1 },
      done('input'),
      done('grant'),
      done('sas'),
      { op: 'close' },
    ],
  },
  {
    name: 'connected: the session is the hello; control writes go out unbounded; a taken send resolves',
    steps: [
      ...connected,
      read,
      { op: 'setActive', active: true },
      { op: 'videoRun', epoch: 3 },
      send('input', 'input', { event: KEY }),
      settle,
      written(2),
      done('input'),
    ],
  },
  {
    name: 'a write that fails rejects with its error',
    steps: [...connected, send('input', 'input', { event: KEY }), settle, written(0, 'EPIPE: broken pipe'), done('input')],
  },
  {
    name: 'a write the pipe never takes is rejected at the frame deadline, not before; a late outcome counts for nothing',
    steps: [
      ...connected,
      send('input', 'input', { event: KEY }),
      advance(9999),
      advance(1),
      done('input'),
      written(0),
      settle,
    ],
  },
  {
    name: 'sas and a grant are bounded the same way',
    steps: [
      ...connected,
      send('sas', 'sas'),
      send('grant', 'grant', { grant: GRANT }),
      settle,
      written(0),
      done('sas'),
      advance(10000),
      done('grant'),
    ],
  },
  {
    name: 'the connection closing rejects every pending send and emits close; later sends are refused',
    steps: [
      ...connected,
      { op: 'listen' },
      send('a', 'input', { event: KEY }),
      send('b', 'sas'),
      settle,
      { op: 'peerClose' },
      done('a'),
      done('b'),
      read,
      send('after', 'input', { event: KEY }),
      done('after'),
      written(0),
      settle,
      advance(10000),
    ],
  },
  {
    name: 'close deactivates and ends; a send already handed over settles from its own outcome',
    steps: [
      ...connected,
      send('input', 'input', { event: KEY }),
      settle,
      { op: 'close' },
      read,
      send('after', 'input', { event: KEY }),
      done('after'),
      written(0),
      done('input'),
      { op: 'close' },
    ],
  },
  {
    name: 'after authentication: a desktop change updates the session; challenges and errors are emitted',
    steps: [
      ...connected,
      { op: 'listen' },
      { op: 'peer', message: { type: 'desktop-changed', desktop: 'Default', session: 2, locked: true } },
      settle,
      read,
      { op: 'peer', message: { type: 'desktop-changed', desktop: 'Winlogon', session: 2 } },
      settle,
      read,
      { op: 'peer', message: { type: 'grant-challenge', nonce: SERVER_NONCE, challenge: SERVER_NONCE } },
      { op: 'peer', message: { type: 'error', code: 'grant_expired', message: 'the grant lapsed' } },
      settle,
    ],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

async function play(scenario) {
  const log = [];
  const writes = [];
  let peer = null;
  const createConnection = () => {
    const handlers = { data: [], error: [], close: [] };
    const parser = new FrameParser();
    let authenticated = false;
    const deliver = (message) => queueMicrotask(() => handlers.data.forEach((handler) => handler(encodeControl(message))));
    peer = {
      send: deliver,
      close: () => handlers.close.forEach((handler) => handler()),
    };
    return {
      on(event, handler) {
        handlers[event].push(handler);
        return this;
      },
      write(chunk, callback) {
        for (const frame of parser.push(chunk)) {
          const message = frame.message;
          if (!authenticated) {
            if (message.type === 'client-hello') {
              const mac = serverAuthTag(SECRET, decodeNonce(message.clientNonce), decodeNonce(SERVER_NONCE));
              deliver({ type: 'server-auth', protocol: 4, serverNonce: SERVER_NONCE, mac });
            } else if (message.type === 'client-auth') {
              authenticated = true;
              deliver(HELLO);
            }
            queueMicrotask(() => callback?.());
            continue;
          }
          log.push({ ev: 'write', n: writes.length, message: clone(message) });
          writes.push(callback);
        }
        return true;
      },
      end: () => log.push({ ev: 'end' }),
      destroy: () => log.push({ ev: 'destroy' }),
    };
  };
  const time = new VirtualTime(1_800_000_000_000);
  time.install();
  const calls = new Map();
  const start = (as, promise) => {
    const entry = { done: false };
    calls.set(as, entry);
    promise.then(
      (value) => {
        entry.done = true;
        log.push({ ev: 'done', call: as, ok: true, value: as === 'connect' ? 'hello' : clone(value) });
      },
      (error) => {
        entry.done = true;
        log.push({ ev: 'done', call: as, ok: false, error: error.message });
      }
    );
  };
  try {
    const client = createSecureDesktopClient({
      environment: { isPackaged: true, platform: 'win32', resourcesPath: '' },
      readState: () => ({ secret: SECRET, pipeName: '\\\\.\\pipe\\mixdog-test', productVersion: '1.4.5' }),
      createConnection,
    });
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'session':
          log.push({ ev: 'session', session: clone(client.session()) });
          break;
        case 'connect':
          start(step.as, client.connect());
          break;
        case 'send':
          if (step.what === 'input') start(step.as, client.sendInput(clone(step.event)));
          else if (step.what === 'grant') start(step.as, client.sendGrant(clone(step.grant)));
          else start(step.as, client.sas());
          break;
        case 'setActive':
          client.setActive(step.active);
          break;
        case 'videoRun':
          client.setVideoRun(step.epoch);
          break;
        case 'written': {
          const callback = writes[step.n];
          if (!callback) throw new Error(`${scenario.name}: no write ${step.n}`);
          callback(step.error ? new Error(step.error) : null);
          break;
        }
        case 'listen':
          client.on('desktop-changed', (desktop, session, locked) => log.push({ ev: 'desktop-changed', desktop, session, locked: locked ?? null }));
          client.on('grant-challenge', (challenge) => log.push({ ev: 'grant-challenge', challenge: clone(challenge) }));
          client.on('error', (code, message) => log.push({ ev: 'error', code, message }));
          client.on('close', () => log.push({ ev: 'close' }));
          break;
        case 'peer':
          peer.send(step.message);
          break;
        case 'peerClose':
          peer.close();
          break;
        case 'close':
          client.close();
          break;
        case 'advance':
          log.push({ ev: 'advance', ms: step.ms, ran: await time.advance(step.ms) });
          break;
        case 'settle':
          await checkpoint();
          break;
        case 'await':
          await checkpoint();
          if (!calls.get(step.call)?.done) throw new Error(`${scenario.name}: ${step.call} did not finish`);
          break;
        default:
          throw new Error(`unknown step ${step.op}`);
      }
    }
    await checkpoint();
  } finally {
    time.restore();
  }
  return { ...scenario, trace: log, final: { elapsedMs: time.elapsed(), pendingTimers: time.pending().length } };
}

await record({
  sub: 'client',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
