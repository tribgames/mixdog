#!/usr/bin/env node
// Node's secure-desktop adapter (apps/desktop/src/main/remote-screen/secure-desktop-adapter.ts,
// `createSecureDesktopAdapter`): the helper client as the lease uses it — not installed it reports nothing and does
// nothing; the first activation dials the helper and a lost or failed connection is dialled again while activation is
// wanted, after a backoff of 1 s doubling to 30 s; a connect re-declares the video run and the activation; input becomes
// the protocol's events (a button without a position at the last pointer), and the Delete of Ctrl+Alt+Delete becomes the
// helper's `sas` while the helper still holds Ctrl and Alt; every point where the helper releases what it holds clears
// that record; dispose cancels the redial and closes the connection, also one that completes later. Each scenario is a
// script against a fake helper client that only records what it is told, on virtual time (the redial timer). The golden
// holds the script and the whole trace Node gave; Rust's adapter must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-adapter.mjs --tree <tree> [--only <scenario>])
import { VirtualTime, checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { createSecureDesktopAdapter } = await importTs(tree, 'apps/desktop/src/main/remote-screen/secure-desktop-adapter.ts');

const SESSION = { protocol: 4, version: '1.4.5', session: 1, desktop: 'Winlogon', locked: false };
const CTRL = { op: 'key', vk: 0x11, scan: 0x1d, extended: false, down: true };
const ALT = { op: 'key', vk: 0x12, scan: 0x38, extended: false, down: true };
const DELETE = { op: 'key', vk: 0x2e, scan: 0x53, extended: true, down: true };
const up = (key) => ({ ...key, down: false });

const settle = { op: 'settle' };
const advance = (ms) => ({ op: 'advance', ms });
const read = { op: 'read' };
const activate = (active, as = `active-${active}`) => [{ op: 'setActive', active, as }, { op: 'await', call: as }];
const connected = [{ op: 'connect', ok: true }, settle];
const input = (as, command) => [{ op: 'input', as, command }, { op: 'await', call: as }];
const keys = (prefix, ...commands) => commands.flatMap((command, index) => input(`${prefix}-${index}`, command));

const SCENARIOS = [
  {
    name: 'not installed: reports nothing, activation and input do nothing, a grant is refused',
    world: { available: false },
    steps: [
      read,
      ...activate(true),
      ...input('key', CTRL),
      { op: 'grant', as: 'grant', grant: { challenge: 'c', epoch: 1, signature: 's' } },
      { op: 'await', call: 'grant' },
      { op: 'videoRun', epoch: 2 },
      { op: 'dispose' },
      read,
    ],
  },
  {
    name: 'the first activation dials; the connect re-declares the run, activates and reports the change',
    world: {},
    steps: [
      read,
      { op: 'videoRun', epoch: 3 },
      ...activate(true),
      ...activate(true, 'again'),
      ...connected,
      read,
      ...activate(true, 'connected'),
      ...activate(false),
      read,
    ],
  },
  {
    name: 'a failed connect is dialled again after 1 s, doubling to 30 s; a connect resets the backoff',
    world: {},
    steps: [
      ...activate(true),
      { op: 'connect', ok: false },
      settle,
      advance(999),
      advance(1),
      { op: 'connect', ok: false },
      settle,
      advance(2000),
      { op: 'connect', ok: false },
      settle,
      advance(4000),
      { op: 'connect', ok: false },
      settle,
      advance(8000),
      { op: 'connect', ok: false },
      settle,
      advance(16000),
      { op: 'connect', ok: false },
      settle,
      advance(30000),
      { op: 'connect', ok: false },
      settle,
      advance(30000),
      ...connected,
      { op: 'close' },
      settle,
      advance(1000),
      { op: 'connect', ok: false },
      settle,
      advance(1999),
      advance(1),
    ],
  },
  {
    name: 'a deactivation cancels the redial; a close without wanted activation does not dial',
    world: {},
    steps: [
      ...activate(true),
      { op: 'connect', ok: false },
      settle,
      ...activate(false),
      advance(5000),
      ...activate(true, 'again'),
      ...connected,
      ...activate(false, 'off'),
      { op: 'close' },
      settle,
      advance(60000),
    ],
  },
  {
    name: 'a close while activation is wanted clears the frame and is dialled again',
    world: {},
    steps: [
      ...activate(true),
      ...connected,
      { op: 'frame', frame: { width: 2, height: 2, stride: 8, originX: -1, originY: 0 } },
      read,
      { op: 'close' },
      settle,
      read,
      advance(1000),
      ...connected,
      read,
    ],
  },
  {
    name: 'input becomes the protocol events; a button without a position goes to the last pointer',
    world: {},
    steps: [
      ...activate(true),
      ...connected,
      ...input('button-before', { op: 'button', button: 'left', down: true }),
      ...input('move', { op: 'move', x: -5, y: 7 }),
      ...input('button-at', { op: 'button', button: 'right', down: true, at: { x: 10, y: 20 } }),
      ...input('button-last', { op: 'button', button: 'right', down: false }),
      ...input('wheel', { op: 'wheel', x: 3, y: 4, dx: 0, dy: -120 }),
      ...input('button-wheel', { op: 'button', button: 'middle', down: true }),
      ...input('key', { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true }),
      ...input('text', { op: 'text', text: 'hé' }),
    ],
  },
  {
    name: 'a refused send rejects with the client’s error',
    world: { sendFails: 'input not taken by the helper within 10000 ms', grantFails: 'not connected' },
    steps: [
      ...activate(true),
      ...connected,
      ...input('key', { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true }),
      { op: 'grant', as: 'grant', grant: { challenge: 'c', epoch: 1, signature: 's' } },
      { op: 'await', call: 'grant' },
    ],
  },
  {
    name: 'Ctrl+Alt+Delete becomes sas while the helper holds Ctrl and Alt; any release point clears the record',
    world: {},
    steps: [
      ...activate(true),
      ...connected,
      ...keys('combo', CTRL, ALT, DELETE),
      ...keys('after-sas', DELETE),
      ...keys('right-side', { ...CTRL, vk: 0xa3 }, { ...ALT, vk: 0xa4 }, DELETE),
      ...keys('lifted', CTRL, ALT, up(ALT), DELETE),
      ...keys('run', CTRL, ALT),
      { op: 'videoRun', epoch: 5 },
      ...keys('after-run', DELETE),
      ...keys('same-run', CTRL, ALT),
      { op: 'videoRun', epoch: 5 },
      ...keys('after-same-run', DELETE),
      ...keys('changed', CTRL, ALT),
      { op: 'desktopChanged', desktop: 'Default', session: 1, locked: false },
      ...keys('after-change', DELETE),
      ...keys('expired', CTRL, ALT),
      { op: 'error', code: 'grant_expired' },
      ...keys('after-expired', DELETE),
      ...keys('unavailable', CTRL, ALT),
      { op: 'error', code: 'desktop_unavailable' },
      ...keys('after-unavailable', DELETE),
      ...keys('other-code', CTRL, ALT),
      { op: 'error', code: 'input_failed' },
      ...keys('after-other-code', DELETE),
      ...activate(false),
      ...keys('after-off', DELETE),
      ...activate(true, 'on-again'),
      ...keys('closed', CTRL, ALT),
      { op: 'close' },
      settle,
      ...keys('after-close', DELETE),
    ],
  },
  {
    name: 'the client’s events: desktop changes, challenges, issues and frames reach the listeners',
    world: {},
    steps: [
      { op: 'listen' },
      ...activate(true),
      ...connected,
      { op: 'desktopChanged', desktop: 'Default', session: 2, locked: true },
      read,
      { op: 'challenge', challenge: { nonce: 'n', challenge: 'c' } },
      { op: 'error', code: 'grant_required' },
      { op: 'frame', frame: { width: 1, height: 1, stride: 4, originX: 0, originY: 0 } },
      { op: 'unlisten' },
      { op: 'challenge', challenge: { nonce: 'n2', challenge: 'c2' } },
      { op: 'frame', frame: { width: 1, height: 1, stride: 4, originX: 5, originY: 5 } },
      read,
    ],
  },
  {
    name: 'the video run is sent while connected; a grant goes to the client',
    world: {},
    steps: [
      { op: 'videoRun', epoch: 1 },
      ...activate(true),
      ...connected,
      { op: 'videoRun', epoch: 2 },
      { op: 'grant', as: 'grant', grant: { challenge: 'c', epoch: 2, signature: 's' } },
      { op: 'await', call: 'grant' },
    ],
  },
  {
    name: 'dispose: the redial is cancelled, listeners dropped, the connection closed; a late connect is closed',
    world: {},
    steps: [
      { op: 'listen' },
      ...activate(true),
      { op: 'connect', ok: false },
      settle,
      { op: 'dispose' },
      advance(60000),
      ...activate(true, 'after'),
      { op: 'videoRun', epoch: 9 },
      { op: 'challenge', challenge: { nonce: 'n', challenge: 'c' } },
      { op: 'dispose' },
      read,
    ],
  },
  {
    name: 'a connect still running at dispose is closed when it succeeds',
    world: {},
    steps: [...activate(true), { op: 'dispose' }, ...connected, read],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

async function play(scenario) {
  const world = { available: true, sendFails: null, grantFails: null, ...scenario.world };
  const log = [];
  const note = (call, fields = {}) => log.push({ ev: 'service', call, ...fields });
  const handlers = { frame: new Set(), 'desktop-changed': new Set(), 'grant-challenge': new Set(), error: new Set(), close: new Set() };
  const emit = (event, ...args) => {
    for (const handler of [...handlers[event]]) handler(...args);
  };
  let session;
  const connects = [];
  const service = {
    available: world.available,
    session: () => (session ? { ...session } : undefined),
    connect: () => {
      note('connect');
      return new Promise((resolve, reject) => connects.push({ resolve, reject }));
    },
    on: (event, handler) => {
      handlers[event].add(handler);
      return () => handlers[event].delete(handler);
    },
    setActive: (active) => note('setActive', { active }),
    sendInput: (event) => {
      note('sendInput', { event: clone(event) });
      return world.sendFails ? Promise.reject(new Error(world.sendFails)) : Promise.resolve();
    },
    close: () => {
      note('close');
      session = undefined;
    },
    setVideoRun: (epoch) => note('setVideoRun', { epoch }),
    sendGrant: (grant) => {
      note('sendGrant', { grant: clone(grant) });
      return world.grantFails ? Promise.reject(new Error(world.grantFails)) : Promise.resolve();
    },
    sas: () => {
      note('sas');
      return Promise.resolve();
    },
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
        log.push({ ev: 'done', call: as, ok: true, value: clone(value) });
      },
      (error) => {
        entry.done = true;
        log.push({ ev: 'done', call: as, ok: false, error: error.message });
      }
    );
  };
  let listening = [];
  try {
    const adapter = createSecureDesktopAdapter(service);
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'read':
          log.push({
            ev: 'read',
            installed: adapter.installed(),
            connected: adapter.connected(),
            desktop: adapter.desktop(),
            session: adapter.session(),
            locked: adapter.locked(),
            latestFrame: adapter.latestFrame() ? { width: adapter.latestFrame().width, originX: adapter.latestFrame().originX } : null,
          });
          break;
        case 'setActive':
          start(step.as, adapter.setActive(step.active));
          break;
        case 'input':
          start(step.as, adapter.sendInput(clone(step.command)));
          break;
        case 'grant':
          start(step.as, adapter.sendGrant(clone(step.grant)));
          break;
        case 'videoRun':
          adapter.setVideoRun(step.epoch);
          break;
        case 'connect': {
          const pending = connects.shift();
          if (!pending) throw new Error(`${scenario.name}: no connect is running`);
          if (step.ok) {
            session = { ...SESSION };
            pending.resolve({ ...SESSION });
          } else {
            pending.reject(new Error('secure desktop helper unreachable'));
          }
          break;
        }
        case 'close':
          session = undefined;
          emit('close');
          break;
        case 'desktopChanged':
          if (session) session = { ...session, desktop: step.desktop, session: step.session, locked: step.locked };
          emit('desktop-changed', step.desktop, step.session, step.locked);
          break;
        case 'challenge':
          emit('grant-challenge', clone(step.challenge));
          break;
        case 'error':
          emit('error', step.code, `${step.code} reported`);
          break;
        case 'frame': {
          const { width, height, stride, originX, originY } = step.frame;
          emit('frame', { seq: 1, width, height, stride, format: 'bgra', timestampMs: 0, originX, originY, desktop: 'Winlogon', dirty: [] }, new Uint8Array(stride * height));
          break;
        }
        case 'listen':
          listening = [
            adapter.onDesktopChanged(() => log.push({ ev: 'changed' })),
            adapter.onGrantChallenge((challenge) => log.push({ ev: 'challenge', challenge: clone(challenge) })),
            adapter.onHelperIssue((code) => log.push({ ev: 'issue', code })),
            adapter.onFrame((frame) => log.push({ ev: 'frame', width: frame.width, height: frame.height, stride: frame.stride, originX: frame.originX, originY: frame.originY, bytes: frame.pixels.length })),
          ];
          break;
        case 'unlisten':
          for (const off of listening) off();
          listening = [];
          break;
        case 'dispose':
          adapter.dispose();
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
  return { ...scenario, trace: log, final: { elapsedMs: time.elapsed(), pendingTimers: time.pending().length, connectsRunning: connects.length } };
}

await record({
  sub: 'adapter',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
