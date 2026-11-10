#!/usr/bin/env node
// Node's screen control composed as the app composes it (apps/desktop/src/main/index.ts:2321-2328 and
// remote-screen/screen-webrtc-sources.ts:177-209): one helper (`createSecureDesktopHelper`) whose adapter is
// `createSecureDesktopAdapter(createSecureDesktopClient(…))`, and a viewer's session (`createRemoteScreenSource`) on a
// lease of it. Each scenario drives the session end to end: the input desktop changes, the helper is activated and its
// client dials and authenticates over a fake pipe (which plays the helper's side of the handshake with the real HMAC
// proofs through the tree's protocol code, then records every message the client writes and takes each write one
// microtask later), the helper's challenge reaches the viewer, the viewer's run and grant go back through the pipe, and
// the viewer's input reaches the pipe as protocol messages (Ctrl+Alt+Delete as `sas`). The installer, the input host, the
// displays, the authorization, the indicator and the log are fakes that only record. The handshake is not part of the
// trace: Rust's client starts from an authenticated link. The golden holds the script and the whole trace Node gave;
// Rust's composed service must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-composed.mjs --tree <tree> [--only <scenario>])
import { VirtualTime, checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { createRemoteScreenSource } = await importTs(tree, 'apps/desktop/src/main/remote-screen/screen-source.ts');
const { createSecureDesktopHelper } = await importTs(tree, 'apps/desktop/src/main/remote-screen/secure-desktop-helper.ts');
const { createSecureDesktopAdapter } = await importTs(tree, 'apps/desktop/src/main/remote-screen/secure-desktop-adapter.ts');
const { createSecureDesktopClient } = await importTs(tree, 'apps/desktop/src/main/secure-desktop/client.ts');
const { FrameParser, decodeNonce, encodeControl, serverAuthTag } = await importTs(tree, 'apps/desktop/src/main/secure-desktop/protocol.ts');

const SECRET = Buffer.alloc(32, 7).toString('base64');
const SERVER_NONCE = Buffer.alloc(16, 9).toString('base64');
const CHALLENGE = Buffer.alloc(16, 3).toString('base64');
const HELLO = { type: 'server-hello', protocol: 4, version: '1.4.5', session: 1, desktop: 'Winlogon', locked: false };
const DISPLAY = {
  screenId: '7',
  label: 'Display 1',
  primary: true,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:0:0',
};
const DEFAULT_DESKTOP = { inputDesktop: 'Default', consent: false, logonUi: false };
const UAC = { inputDesktop: null, consent: true, logonUi: false };
const key = (vk, scan, down, extended = false) => ({ type: 'screen-key', action: down ? 'down' : 'up', vk, scan, extended });

const settle = { op: 'settle' };
const input = (as, value) => [{ op: 'input', as, input: value }, { op: 'await', call: as }];

const SCENARIOS = [
  {
    name: 'a UAC prompt with the helper installed: activated, dialled, granted, and input and Ctrl+Alt+Delete reach the helper’s pipe',
    world: { installState: 'installed' },
    steps: [
      { op: 'start', as: 'start' },
      { op: 'await', call: 'start' },
      ...input('denied-before', key(0x41, 0x1e, true)),
      { op: 'hostDesktop', local: UAC },
      settle,
      { op: 'query' },
      { op: 'peer', message: { type: 'grant-challenge', nonce: SERVER_NONCE, challenge: CHALLENGE } },
      settle,
      { op: 'grant' },
      settle,
      ...input('denied-no-video', key(0x41, 0x1e, true)),
      { op: 'helperVideo', value: true },
      ...input('a-down', key(0x41, 0x1e, true)),
      ...input('a-up', key(0x41, 0x1e, false)),
      ...input('ctrl', key(0x11, 0x1d, true)),
      ...input('alt', key(0x12, 0x38, true)),
      ...input('delete', key(0x2e, 0x53, true, true)),
      { op: 'peer', message: { type: 'desktop-changed', desktop: 'Default', session: 1, locked: false } },
      settle,
      { op: 'hostDesktop', local: DEFAULT_DESKTOP },
      settle,
      { op: 'query' },
      { op: 'stop', as: 'stop' },
      { op: 'await', call: 'stop' },
    ],
  },
  {
    name: 'a UAC prompt without the helper installed: blocked, the install is offered, and input is refused',
    world: { installState: 'not-installed', notInstalled: true },
    steps: [
      { op: 'start', as: 'start' },
      { op: 'await', call: 'start' },
      { op: 'hostDesktop', local: UAC },
      settle,
      ...input('refused', key(0x41, 0x1e, true)),
      { op: 'query' },
      { op: 'stop', as: 'stop' },
      { op: 'await', call: 'stop' },
    ],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

async function play(scenario) {
  const world = scenario.world;
  const log = [];
  const note = (who, call, fields = {}) => log.push({ ev: who, call, ...fields });
  let peer = null;
  const createConnection = () => {
    const handlers = { data: [], error: [], close: [] };
    const parser = new FrameParser();
    let authenticated = false;
    const deliver = (message) => queueMicrotask(() => handlers.data.forEach((handler) => handler(encodeControl(message))));
    peer = { send: deliver };
    note('pipe', 'open');
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
          } else {
            note('pipe', 'write', { message: clone(message) });
          }
          queueMicrotask(() => callback?.());
        }
        return true;
      },
      end: () => note('pipe', 'end'),
      destroy: () => note('pipe', 'destroy'),
    };
  };
  const installer = {
    state: async (controllerKey) => {
      note('installer', 'state', { key: controllerKey ?? null });
      return world.installState;
    },
    request: async (controllerKey) => {
      note('installer', 'request', { key: controllerKey });
      return { outcome: 'declined', state: world.installState };
    },
    ensureRunning: async () => {
      note('installer', 'ensureRunning');
      return { installed: world.installState === 'installed', running: true };
    },
  };
  let local = DEFAULT_DESKTOP;
  const hostDesktop = new Set();
  const host = {
    start: async () => note('host', 'start'),
    command: async (command) => {
      note('host', 'command', { command: clone(command) });
      return [];
    },
    alive: () => true,
    desktop: () => local,
    session: () => 1,
    onDesktop: (listener) => {
      hostDesktop.add(listener);
      return () => hostDesktop.delete(listener);
    },
    onExit: () => () => {},
    stop: async () => note('host', 'stop'),
    kill: () => note('host', 'kill'),
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
  let challenge = null;
  let run = null;
  try {
    const helper = createSecureDesktopHelper({
      adapter: () =>
        createSecureDesktopAdapter(
          createSecureDesktopClient({
            environment: { isPackaged: true, platform: 'win32', resourcesPath: '' },
            readState: () => (world.notInstalled ? undefined : { secret: SECRET, pipeName: '\\\\.\\pipe\\mixdog-test', productVersion: '1.4.5' }),
            createConnection,
          })
        ),
      installer,
    });
    const lease = helper.lease();
    const source = createRemoteScreenSource({
      clientId: 'phone-1',
      clientLabel: 'Phone',
      screenId: '7',
      displays: { list: () => [DISPLAY], onChange: () => () => {} },
      authorization: { paired: () => true, lost: () => 'revoked', onChange: () => () => {} },
      createInputHost: () => host,
      secureDesktop: lease,
      indicator: {
        show: (view) => note('indicator', 'show', { controlling: view.controlling }),
        update: (view) => note('indicator', 'update', { controlling: view.controlling }),
        hide: () => note('indicator', 'hide'),
      },
      log: (event) => log.push({ ev: 'log', event: clone(event) }),
    });
    source.onStatus((status) => log.push({ ev: 'status', status: clone(status) }));
    source.onVideoPath((path) => log.push({ ev: 'videoPath', path }));
    // The viewer's side (screen-webrtc-source.ts): a fresh run on the hold, each challenge kept for the grant.
    source.onHelperHold(() => {
      run = source.nextVideoRun();
      log.push({ ev: 'hold', run });
      source.setVideoRun(run);
    });
    source.onHelperChallenge((next) => {
      challenge = next;
      log.push({ ev: 'challenge', challenge: clone(next) });
    });
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'start':
          start(step.as, source.start());
          break;
        case 'query':
          log.push({ ev: 'query', status: clone(source.status()), videoPath: source.videoPath() });
          break;
        case 'hostDesktop':
          local = step.local;
          for (const listener of [...hostDesktop]) listener(local);
          break;
        case 'peer':
          peer.send(step.message);
          break;
        case 'grant':
          source.helperGrant({ epoch: run, challenge: challenge.challenge, signature: 'signed-by-the-phone' });
          break;
        case 'helperVideo':
          source.setHelperVideo(step.value);
          break;
        case 'input':
          start(step.as, source.handleInput(clone(step.input), 1));
          break;
        case 'stop':
          start(step.as, source.stop('user'));
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
    lease.dispose();
    helper.dispose();
    await checkpoint();
  } finally {
    time.restore();
  }
  return { ...scenario, trace: log, final: { elapsedMs: time.elapsed(), pendingTimers: time.pending().length } };
}

await record({
  sub: 'composed',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
