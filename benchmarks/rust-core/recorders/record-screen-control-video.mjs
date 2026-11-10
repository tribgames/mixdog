#!/usr/bin/env node
// Node's helper video runs (apps/desktop/src/main/remote-screen/screen-webrtc-source.ts, `createScreenWebrtcSource`):
// the WebRTC side of one screen session — every path change, pipeline stall and loss of the viewer's channel starts a
// new run (epoch), announced as `screen-video`; on the helper path a frame is handed over at most once per frame
// interval of the plan, a delivery of the current run arms the stall watchdog (`helperVideoStallMs` over the last 30
// delivery intervals) and announces the run, and the phone's `screen-frame-seen` of the announced run grants control;
// helper challenges go to the phone with the current run, a grant of another run is dropped. Each scenario is a script
// against a fake screen session and a fake sink that only record what they are told, on virtual time (the watchdog's
// `setTimeout`, the frame cap's `Date.now`). The golden holds the script and the whole trace Node gave. Rust's video
// source must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-video.mjs --tree <tree> [--only <scenario>])
import { VirtualTime, checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { createScreenWebrtcSource } = await importTs(tree, 'apps/desktop/src/main/remote-screen/screen-webrtc-source.ts');

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const CHALLENGE = 'BBBBBBBBBBBBBBBBBBBBBA==';
const SIGNATURE = `${'C'.repeat(85)}A==`;
const GEOMETRY = { generation: 3, width: 1280, height: 720 };

const settle = { op: 'settle' };
const started = [{ op: 'start' }, settle];
const toHelper = { op: 'path', path: 'helper' };
const toCapture = { op: 'path', path: 'capture' };
const frame = (id) => ({ op: 'frame', id });
const delivered = (epoch = 'current') => ({ op: 'delivered', epoch });
const seen = (epoch = 'current') => ({ op: 'frameSeen', epoch });
const advance = (ms) => ({ op: 'advance', ms });

const SCENARIOS = [
  {
    name: 'a started capture run declares its epoch and the session geometry; the channel state carries status and video',
    world: {},
    steps: [...started, { op: 'channelState' }, { op: 'page' }, { op: 'capturePlan' }],
  },
  {
    name: 'a start the session refuses reports no geometry and the error',
    world: { startFails: 'remote screen denied: unauthorized' },
    steps: [...started, { op: 'start' }, settle],
  },
  {
    name: 'the helper path: a new unannounced run, the drawn track, frames at the plan’s rate; a delivery announces it and a seen grants control',
    world: { maxFrameRate: 10 },
    steps: [
      ...started,
      toHelper,
      { op: 'channelState' },
      frame(1),
      frame(2),
      advance(99),
      frame(3),
      advance(1),
      frame(4),
      seen(),
      delivered(),
      { op: 'channelState' },
      seen(),
      delivered(),
      seen(),
    ],
  },
  {
    name: 'a delivery or seen of another run, off the helper path, or while not running counts for nothing',
    world: {},
    steps: [
      ...started,
      delivered(),
      seen(),
      toHelper,
      delivered('previous'),
      seen('previous'),
      { op: 'running', value: false },
      delivered(),
      seen(),
      { op: 'running', value: true },
      delivered(),
      seen('previous'),
      seen(),
    ],
  },
  {
    name: 'the stall watchdog: 216 ms before two deliveries, then max(3 × average, average + 150) of the last 30 intervals',
    world: {},
    steps: [
      ...started,
      toHelper,
      delivered(),
      seen(),
      advance(215),
      advance(1),
      delivered(),
      advance(66),
      delivered(),
      advance(100),
      delivered(),
      advance(248),
      advance(1),
      delivered(),
      delivered(),
      { op: 'repeatDelivered', times: 32, every: 50 },
      advance(149),
      advance(1),
    ],
  },
  {
    name: 'leaving the helper path ends the run, withdraws control and switches the track back; the watchdog is cleared',
    world: {},
    steps: [...started, toHelper, delivered(), seen(), toCapture, toCapture, advance(1000), toHelper, delivered(), { op: 'stop' }, advance(1000)],
  },
  {
    name: 'taking the helper hold starts a fresh run on the same path',
    world: {},
    steps: [...started, { op: 'hold' }, toHelper, delivered(), seen(), { op: 'hold' }, { op: 'channelState' }],
  },
  {
    name: 'the viewer’s channel lost on the helper path starts a new run and releases input; on the capture path it only releases',
    world: {},
    steps: [...started, { op: 'release' }, settle, toHelper, delivered(), seen(), { op: 'release' }, settle],
  },
  {
    name: 'a helper challenge goes to the phone with the current run; a malformed one is never forwarded',
    world: {},
    steps: [
      ...started,
      { op: 'challenge', nonce: NONCE, challenge: CHALLENGE },
      toHelper,
      { op: 'challenge', nonce: NONCE, challenge: CHALLENGE },
      { op: 'challenge', nonce: 'short', challenge: CHALLENGE },
      { op: 'challenge', nonce: NONCE, challenge: 'not base64' },
    ],
  },
  {
    name: 'a grant signed for the current run is relayed, one for another run dropped',
    world: {},
    steps: [
      ...started,
      { op: 'grant', epoch: 'current', challenge: CHALLENGE, signature: SIGNATURE },
      { op: 'grant', epoch: 'previous', challenge: CHALLENGE, signature: SIGNATURE },
      toHelper,
      { op: 'grant', epoch: 'previous', challenge: CHALLENGE, signature: SIGNATURE },
      { op: 'grant', epoch: 'current', challenge: CHALLENGE, signature: SIGNATURE },
    ],
  },
  {
    name: 'screen input reaches the session with the geometry’s generation; page input and a rejection are errors',
    world: { inputs: ['applied', 'rejected'] },
    steps: [
      ...started,
      { op: 'dispatch', control: { type: 'screen-pointer', action: 'move', x: 1, y: 2 } },
      settle,
      { op: 'dispatch', control: { type: 'screen-wheel', x: 1, y: 2, dx: 0, dy: 3 } },
      settle,
      { op: 'dispatch', control: { type: 'pointer', action: 'move', x: 1, y: 2 } },
      settle,
      { op: 'noGeometry' },
      { op: 'dispatch', control: { type: 'screen-release' } },
      settle,
    ],
  },
  {
    name: 'the session’s status, cursor, geometry and stop reach the sink and the channel',
    world: {},
    steps: [
      ...started,
      { op: 'status', status: { state: 'secure-desktop', reason: 'uac', helper: 'missing', control: false } },
      { op: 'cursor', cursor: { x: 4, y: 5, generation: 3 } },
      { op: 'channelState' },
      { op: 'geometry', geometry: { generation: 4, width: 640, height: 360 } },
      { op: 'stopped' },
      { op: 'stop' },
      { op: 'page' },
    ],
  },
  {
    name: 'install and password requests reach the session',
    world: {},
    steps: [
      ...started,
      { op: 'install', key: 'key-a' },
      { op: 'credential', key: 'key-a', credential: { user: 'pc-user', password: 'pc-password' } },
    ],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const START = 1_800_000_000_000;

async function play(scenario) {
  const world = { maxFrameRate: 30, startFails: null, inputs: [], ...scenario.world };
  const log = [];
  const listeners = { geometry: [], stop: [], status: [], cursor: [], challenge: [], hold: [], path: [], frame: [] };
  const on = (name) => (listener) => {
    listeners[name].push(listener);
    return () => listeners[name].splice(listeners[name].indexOf(listener), 1);
  };
  const emit = (name, value) => {
    for (const listener of [...listeners[name]]) listener(value);
  };
  let runs = 0;
  let running = false;
  let geometry = GEOMETRY;
  let status = { state: 'live', helper: 'not-needed', control: false };
  let cursor = null;
  let inputs = 0;
  /** The epochs the screen minted, newest last: `current` and `previous` in a script name the last two. */
  const minted = [];
  const screen = {
    onGeometry: on('geometry'),
    onStop: on('stop'),
    onStatus: on('status'),
    onCursor: on('cursor'),
    onHelperChallenge: on('challenge'),
    onHelperHold: on('hold'),
    onVideoPath: on('path'),
    onFrame: on('frame'),
    status: () => status,
    cursor: () => cursor,
    running: () => running,
    geometry: () => geometry,
    capturePlan: () => ({ sourceId: 'screen:0', width: 1280, height: 720, maxFrameRate: world.maxFrameRate }),
    nextVideoRun: () => {
      runs += 1;
      minted.push(runs);
      log.push({ ev: 'screen', call: 'nextVideoRun', epoch: runs });
      return runs;
    },
    setVideoRun: (epoch) => log.push({ ev: 'screen', call: 'setVideoRun', epoch }),
    setHelperVideo: (delivering) => log.push({ ev: 'screen', call: 'setHelperVideo', delivering }),
    helperGrant: (grant) => log.push({ ev: 'screen', call: 'helperGrant', grant: clone(grant) }),
    requestHelperInstall: (key) => log.push({ ev: 'screen', call: 'requestHelperInstall', key }),
    requestHelperCredential: (key, credential) => log.push({ ev: 'screen', call: 'requestHelperCredential', key, credential: clone(credential) }),
    releaseInput: async () => {
      log.push({ ev: 'screen', call: 'releaseInput' });
    },
    handleInput: async (control, generation) => {
      const outcome = world.inputs[inputs];
      inputs += 1;
      log.push({ ev: 'screen', call: 'handleInput', control: clone(control), generation, outcome });
      return outcome;
    },
    start: async () => {
      log.push({ ev: 'screen', call: 'start' });
      if (world.startFails) throw new Error(world.startFails);
      running = true;
      return { geometry, plan: screen.capturePlan(), status };
    },
    stop: async (reason) => {
      log.push({ ev: 'screen', call: 'stop', reason });
    },
  };
  const sink = {
    geometryChanged: (key, value) => log.push({ ev: 'sink', call: 'geometryChanged', key, geometry: clone(value) }),
    captureChanged: (key) => log.push({ ev: 'sink', call: 'captureChanged', key }),
    channelPush: (key, message) => log.push({ ev: 'sink', call: 'channelPush', key, message: clone(message) }),
    drawnTrack: (key, drawn) => log.push({ ev: 'sink', call: 'drawnTrack', key, drawn }),
    frame: (key, value) => log.push({ ev: 'sink', call: 'frame', key, frame: clone(value), at: time.elapsed() }),
  };
  const time = new VirtualTime(START);
  time.install();
  const epochOf = (name) => (name === 'current' ? minted.at(-1) : minted.at(-2));
  try {
    const source = createScreenWebrtcSource(screen, {
      screenId: '7',
      sink,
      onStartError: (error) => log.push({ ev: 'startError', message: error.message }),
    });
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'start':
          source.start();
          break;
        case 'stop':
          source.stop();
          break;
        case 'path':
          log.push({ ev: 'path', path: step.path });
          emit('path', step.path);
          break;
        case 'hold':
          log.push({ ev: 'hold' });
          emit('hold');
          break;
        case 'frame':
          emit('frame', { id: step.id });
          break;
        case 'delivered':
          log.push({ ev: 'delivered', epoch: epochOf(step.epoch) });
          source.delivered(epochOf(step.epoch));
          break;
        case 'repeatDelivered':
          for (let n = 0; n < step.times; n += 1) {
            log.push({ ev: 'delivered', epoch: epochOf('current') });
            source.delivered(epochOf('current'));
            log.push({ ev: 'advance', ms: step.every, ran: await time.advance(step.every) });
          }
          break;
        case 'frameSeen':
          log.push({ ev: 'frameSeen', epoch: epochOf(step.epoch) });
          source.frameSeen(epochOf(step.epoch));
          break;
        case 'grant':
          source.helperGrant({ epoch: epochOf(step.epoch), challenge: step.challenge, signature: step.signature });
          break;
        case 'challenge':
          emit('challenge', { nonce: step.nonce, challenge: step.challenge });
          break;
        case 'release':
          log.push({ ev: 'release' });
          void source.release();
          break;
        case 'dispatch':
          source.dispatch(clone(step.control)).then(
            () => log.push({ ev: 'dispatched', ok: true }),
            (error) => log.push({ ev: 'dispatched', ok: false, error: error.message })
          );
          break;
        case 'channelState':
          log.push({ ev: 'channelState', messages: clone(source.channelState()) });
          break;
        case 'page':
          log.push({ ev: 'page', page: clone(source.page()) });
          break;
        case 'capturePlan':
          log.push({ ev: 'capturePlan', plan: clone(source.capturePlan()) });
          break;
        case 'install':
          source.helperInstall(step.key);
          break;
        case 'credential':
          source.helperCredential(step.key, clone(step.credential));
          break;
        case 'running':
          running = step.value;
          break;
        case 'noGeometry':
          geometry = null;
          break;
        case 'status':
          status = step.status;
          emit('status', status);
          break;
        case 'cursor':
          cursor = step.cursor;
          emit('cursor', cursor);
          break;
        case 'geometry':
          geometry = step.geometry;
          emit('geometry', { geometry, plan: screen.capturePlan() });
          break;
        case 'stopped':
          running = false;
          emit('stop', 'user');
          break;
        case 'advance':
          log.push({ ev: 'advance', ms: step.ms, ran: await time.advance(step.ms) });
          break;
        case 'settle':
          await checkpoint();
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
  sub: 'video',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
