#!/usr/bin/env node
// Node's screen session for one viewer (apps/desktop/src/main/remote-screen/screen-source.ts,
// `createRemoteScreenSource`): admission and the locked geometry, the decision of what the session streams and
// injects through as the input desktop and the secure-desktop helper change (refreshDecision), the helper's
// activation inside the input queue, the service start after a reboot (ensureService), the helper facts of the status
// (offer, install outcome, issue), helper frames located on the geometry, challenges, holds and grants, the phone's
// install and password requests, gated and serialized input, cursor sampling, display, authorization and host changes,
// and the stop with its deadline. Each scenario is a script against fakes of every dependency — displays, the
// viewer's authorization, the input host, the helper lease, PC access, the on-PC indicator and the log — that only
// record what they are told, on virtual time (the stop deadline, the cursor interval). Nothing reaches a desktop. The
// golden holds the script and the whole trace Node gave; Rust's session must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-session.mjs --tree <tree> [--only <scenario>])
import { VirtualTime, checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { createRemoteScreenSource } = await importTs(tree, 'apps/desktop/src/main/remote-screen/screen-source.ts');

const DISPLAY = {
  screenId: '7',
  label: 'Display 1',
  primary: true,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:0:0',
};
const MOVED = { ...DISPLAY, physical: { x: -1920, y: 0, width: 1920, height: 1080 } };
const DEFAULT_DESKTOP = { inputDesktop: 'Default', consent: false, logonUi: false };
const SECURE = { inputDesktop: null, consent: true, logonUi: false };
const LOCK = { inputDesktop: 'Winlogon', consent: false, logonUi: true };
const CONSENT_IN_PLACE = { inputDesktop: 'Default', consent: true, logonUi: false };
const HELPER_UP = { installed: true, connected: true, desktop: 'Winlogon', session: 1, locked: false };
const KEY = 'controller-key';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

const settle = { op: 'settle' };
const started = [{ op: 'start', as: 'start' }, { op: 'await', call: 'start' }];
const desktop = (local) => [{ op: 'hostDesktop', local }, settle];
const helper = (fields, changed = true) => [{ op: 'helper', fields, changed }, settle];
const input = (as, value, generation = 1) => [{ op: 'input', as, input: value, generation }, { op: 'await', call: as }];
const advance = (ms) => ({ op: 'advance', ms });

const SCENARIOS = [
  {
    name: 'a start admits a paired viewer, locks the geometry, shows the indicator and decides live',
    world: {},
    steps: [...started, { op: 'query' }, { op: 'listDisplays' }],
  },
  {
    name: 'a second start while running is refused',
    world: {},
    steps: [...started, { op: 'start', as: 'again' }, { op: 'await', call: 'again' }],
  },
  {
    name: 'a start is refused while the viewer is unpaired',
    world: { paired: false },
    steps: [{ op: 'start', as: 'unpaired' }, { op: 'await', call: 'unpaired' }, { op: 'start', as: 'again' }, { op: 'await', call: 'again' }],
  },
  {
    name: 'a start whose display is gone is refused',
    world: { displays: [] },
    steps: [{ op: 'start', as: 'start' }, { op: 'await', call: 'start' }],
  },
  {
    name: 'a host that cannot start stops the session with error',
    world: { hostStartFails: 'host_unavailable' },
    steps: [{ op: 'start', as: 'start' }, { op: 'await', call: 'start' }, { op: 'query' }],
  },
  {
    name: 'the secure desktop without a helper blocks: input rejected, status secure-desktop, an install offered',
    world: { installState: 'not-installed', helper: { installed: false } },
    steps: [...started, ...desktop(SECURE), ...input('move', { type: 'screen-pointer', action: 'move', x: 10, y: 10 }), { op: 'query' }],
  },
  {
    name: 'the helper takes over the secure desktop: activated before the switch, frames located, control after video',
    world: { installState: 'installed', helper: HELPER_UP },
    steps: [
      ...started,
      ...input('key-down', { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }),
      ...desktop(SECURE),
      { op: 'helperFrame', frame: { width: 2000, height: 1200, stride: 8000, originX: -40, originY: -60 } },
      ...input('denied', { type: 'screen-key', action: 'down', vk: 0x42, scan: 0x30, extended: false }),
      { op: 'setHelperVideo', value: true },
      ...input('allowed', { type: 'screen-key', action: 'down', vk: 0x42, scan: 0x30, extended: false }),
      { op: 'setHelperVideo', value: false },
      settle,
      ...desktop(DEFAULT_DESKTOP),
      { op: 'query' },
    ],
  },
  {
    name: 'the lock screen and an in-place elevation prompt: reasons, the warm helper and control',
    world: { installState: 'installed', helper: { ...HELPER_UP, locked: true } },
    steps: [...started, ...desktop(LOCK), ...desktop(CONSENT_IN_PLACE), ...helper({ connected: false }), ...desktop(DEFAULT_DESKTOP), { op: 'query' }],
  },
  {
    name: 'a stopped service is started at start and when the helper is activated unconnected; a failed start shows failed',
    world: { installState: 'installed', helper: { installed: true, connected: false }, ensure: [{ installed: true, running: false }, 'reject', { installed: true, running: true }] },
    steps: [...started, ...desktop(SECURE), ...desktop(DEFAULT_DESKTOP), ...desktop(SECURE), ...helper({ connected: true, desktop: 'Winlogon', session: 1 }), { op: 'query' }],
  },
  {
    name: 'a helper issue shows while the helper is active, ends at a change, and grant_expired ends with the next relayed grant',
    world: { installState: 'installed', helper: HELPER_UP },
    steps: [
      ...started,
      { op: 'helperIssue', code: 'grant_expired' },
      settle,
      ...desktop(SECURE),
      { op: 'helperIssue', code: 'not_a_reported_code' },
      { op: 'helperIssue', code: 'grant_expired' },
      settle,
      { op: 'grant', grant: { epoch: 1, challenge: NONCE, signature: 's' } },
      settle,
      { op: 'helperIssue', code: 'grant_key_missing' },
      ...helper({}, true),
      ...helper({ connected: false }, true),
      { op: 'query' },
    ],
  },
  {
    name: 'the phone’s install request: the outcome, detail and new offer land in the status; a later request wins',
    world: { installState: 'not-installed', helper: { installed: false }, deferInstall: true },
    steps: [
      ...started,
      ...desktop(SECURE),
      { op: 'install', key: KEY },
      { op: 'install', key: KEY },
      settle,
      { op: 'finishInstall', n: 0, result: { outcome: 'declined', state: 'not-installed' } },
      settle,
      { op: 'finishInstall', n: 1, result: { outcome: 'failed', state: 'not-installed', detail: 'x'.repeat(300) } },
      settle,
      { op: 'install', key: KEY },
      settle,
      { op: 'finishInstall', n: 2, reject: 'launch failed' },
      settle,
      { op: 'query' },
    ],
  },
  {
    name: 'the phone’s password request goes through PC access once at a time; the answer is forced into the status',
    world: { installState: 'not-installed', helper: { installed: false }, accountIsAdmin: false, deferCredential: true },
    steps: [
      ...started,
      { op: 'credential', key: KEY, credential: { user: 'pc-user', password: 'pc-password' } },
      { op: 'credential', key: KEY, credential: { password: 'second' } },
      settle,
      { op: 'finishCredential', n: 0, result: { outcome: 'bad-credentials', state: 'not-installed', detail: 'wrong pc-password' } },
      settle,
      { op: 'credential', key: KEY, credential: { password: 'third' } },
      settle,
      { op: 'finishCredential', n: 1, result: { outcome: 'delegation-denied', state: 'installed' } },
      settle,
      { op: 'credential', key: KEY, credential: { password: 'fourth' } },
      settle,
      { op: 'finishCredential', n: 2, reject: 'echo fourth' },
      settle,
      { op: 'query' },
    ],
  },
  {
    name: 'a password request without PC access is unavailable',
    world: { noPcAccess: true },
    steps: [...started, { op: 'credential', key: KEY, credential: { password: 'p' } }, settle, { op: 'query' }],
  },
  {
    name: 'a password request outstanding when the session stops is aborted and its answer dropped',
    world: { deferCredential: true },
    steps: [
      ...started,
      { op: 'credential', key: KEY, credential: { password: 'p' } },
      settle,
      { op: 'stop', as: 'stop', reason: 'user' },
      { op: 'await', call: 'stop' },
      { op: 'finishCredential', n: 0, result: { outcome: 'enrolled', state: 'installed' } },
      settle,
    ],
  },
  {
    name: 'challenges, holds, runs and grants pass while running and paired',
    world: { installState: 'installed', helper: HELPER_UP },
    steps: [
      { op: 'helperChallenge', challenge: { nonce: NONCE, challenge: NONCE } },
      ...started,
      { op: 'helperChallenge', challenge: { nonce: NONCE, challenge: NONCE } },
      { op: 'helperHold' },
      { op: 'setVideoRun', epoch: 4 },
      { op: 'nextVideoRun' },
      { op: 'grant', grant: { epoch: 4, challenge: NONCE, signature: 's' } },
      { op: 'unpair', reason: 'revoked' },
      settle,
      { op: 'helperChallenge', challenge: { nonce: NONCE, challenge: NONCE } },
      { op: 'grant', grant: { epoch: 4, challenge: NONCE, signature: 's' } },
      { op: 'setVideoRun', epoch: 5 },
    ],
  },
  {
    name: 'input: pointer mapping, the geometry generation, keys, a combo, text, release and an out-of-bounds point',
    world: {},
    steps: [
      ...started,
      ...input('move', { type: 'screen-pointer', action: 'move', x: 640, y: 360 }),
      ...input('stale', { type: 'screen-pointer', action: 'move', x: 1, y: 1 }, 2),
      ...input('down', { type: 'screen-pointer', action: 'down', button: 'left', x: 1920, y: 1080 }),
      ...input('up-stale', { type: 'screen-pointer', action: 'up', button: 'left', x: 1, y: 1 }, 9),
      ...input('outside', { type: 'screen-pointer', action: 'move', x: 1921, y: 0 }),
      ...input('wheel', { type: 'screen-wheel', x: 5, y: 5, deltaX: 0, deltaY: -120 }),
      ...input('wheel-zero', { type: 'screen-wheel', x: 5, y: 5, deltaX: 0, deltaY: 0 }),
      ...input('combo', { type: 'screen-keys', keys: [{ vk: 0x11, scan: 0x1d, extended: false }, { vk: 0x43, scan: 0x2e, extended: false }] }),
      ...input('text', { type: 'screen-text', text: 'hé' }),
      ...input('key', { type: 'screen-key', action: 'down', vk: 0x10, scan: 0x2a, extended: false }),
      ...input('release', { type: 'screen-release' }),
      { op: 'hostFails', value: 'host_unavailable' },
      ...input('failed', { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }),
    ],
  },
  {
    name: 'cursor sampling: once per frame interval, mapped to video pixels, published on change; none on the helper',
    world: { sampleCursor: true, maxFrameRate: 30, cursor: [['960', '540'], ['960', '540'], ['0', '0'], ['5000', '5000'], ['bad']], installState: 'installed', helper: HELPER_UP },
    steps: [...started, advance(34), advance(34), advance(34), advance(34), advance(34), { op: 'query' }, ...desktop(SECURE), advance(34), { op: 'query' }],
  },
  {
    name: 'a display change renews the geometry; an unchanged one does nothing; a removed display stops the session',
    world: {},
    steps: [
      ...started,
      { op: 'displays', list: [DISPLAY] },
      { op: 'displays', list: [MOVED] },
      ...input('stale', { type: 'screen-pointer', action: 'move', x: 1, y: 1 }, 1),
      ...input('fresh', { type: 'screen-pointer', action: 'move', x: 1, y: 1 }, 2),
      { op: 'displays', list: [] },
      settle,
      { op: 'query' },
    ],
  },
  {
    name: 'a lost authorization stops the session with its reason',
    world: {},
    steps: [...started, { op: 'unpair', reason: 'viewer-left' }, settle, { op: 'query' }],
  },
  {
    name: 'the indicator’s stop button stops the session as user',
    world: {},
    steps: [...started, { op: 'indicatorStop' }, settle, { op: 'query' }],
  },
  {
    name: 'a host that exits on its own stops the session with error',
    world: {},
    steps: [...started, { op: 'hostExit' }, settle, { op: 'query' }],
  },
  {
    name: 'stop: input cancelled, released through the queue, the backends closed; idempotent',
    world: { installState: 'installed', helper: HELPER_UP },
    steps: [
      ...started,
      ...input('key', { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }),
      { op: 'stop', as: 'stop', reason: 'user' },
      { op: 'stop', as: 'again', reason: 'revoked' },
      { op: 'await', call: 'stop' },
      { op: 'await', call: 'again' },
      { op: 'released', as: 'released' },
      { op: 'await', call: 'released' },
      ...input('after', { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }),
      { op: 'query' },
    ],
  },
  {
    name: 'a hung host: the stop deadline kills it, abandons the queue and counts the dropped releases',
    world: { shutdownDeadlineMs: 1000 },
    steps: [
      ...started,
      ...input('key', { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }),
      { op: 'hostHangs' },
      { op: 'stop', as: 'stop', reason: 'user' },
      settle,
      advance(999),
      { op: 'stop', as: 'shorter', reason: 'user', deadlineMs: 500 },
      settle,
      advance(499),
      advance(1),
      { op: 'await', call: 'stop' },
      { op: 'await', call: 'shorter' },
      { op: 'query' },
    ],
  },
  {
    name: 'a host whose graceful stop never ends is killed at the deadline',
    world: { shutdownDeadlineMs: 1000, hostStopHangs: true },
    steps: [...started, { op: 'stop', as: 'stop', reason: 'user' }, settle, advance(999), advance(1), { op: 'await', call: 'stop' }],
  },
  {
    name: 'another session holds the helper: in-use, and a hold passes when it lets go',
    world: { installState: 'installed', helper: { ...HELPER_UP, ownedElsewhere: true } },
    steps: [...started, ...desktop(SECURE), ...helper({ ownedElsewhere: false }), { op: 'query' }],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const START = 1_800_000_000_000;

async function play(scenario) {
  const world = {
    paired: true,
    lost: 'revoked',
    displays: [DISPLAY],
    installState: 'not-installed',
    helper: { installed: false, connected: false, desktop: null, session: null, locked: null, ownedElsewhere: false },
    ensure: [],
    cursor: [],
    accountIsAdmin: null,
    ...scenario.world,
  };
  world.helper = { installed: false, connected: false, desktop: null, session: null, locked: null, ownedElsewhere: false, ...world.helper };
  const log = [];
  const note = (who, call, fields = {}) => log.push({ ev: who, call, ...fields });
  const sets = () => new Set();
  const listen = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const fire = (set, value) => {
    for (const listener of [...set]) listener(value);
  };
  const displayChange = sets();
  const authChange = sets();
  const hostDesktop = sets();
  const hostExit = sets();
  const helperSets = { change: sets(), frame: sets(), challenge: sets(), issue: sets(), hold: sets() };
  const deferred = { install: [], credential: [] };
  let runs = 0;
  let ensures = 0;
  let cursors = 0;
  let local = DEFAULT_DESKTOP;
  let hostFails = null;
  let hostHangs = false;
  let indicatorStop = null;

  const host = {
    start: async () => {
      note('host', 'start');
      if (world.hostStartFails) throw new Error(world.hostStartFails);
    },
    command: (command) => {
      note('host', 'command', { command: clone(command) });
      if (hostHangs) return new Promise(() => {});
      if (hostFails) return Promise.reject(new Error(hostFails));
      if (command.op === 'cursor') {
        const fields = world.cursor[Math.min(cursors, world.cursor.length - 1)] ?? [];
        cursors += 1;
        return Promise.resolve(fields);
      }
      return Promise.resolve([]);
    },
    alive: () => true,
    desktop: () => local,
    session: () => 1,
    onDesktop: listen(hostDesktop),
    onExit: listen(hostExit),
    stop: () => {
      note('host', 'stop');
      return world.hostStopHangs ? new Promise(() => {}) : Promise.resolve();
    },
    kill: () => note('host', 'kill'),
  };
  const lease = {
    installed: () => world.helper.installed,
    connected: () => world.helper.connected,
    desktop: () => world.helper.desktop,
    session: () => world.helper.session,
    locked: () => world.helper.locked,
    ownedElsewhere: () => world.helper.ownedElsewhere,
    mintVideoRun: () => {
      runs += 1;
      note('helper', 'mintVideoRun', { epoch: runs });
      return runs;
    },
    onHold: listen(helperSets.hold),
    setActive: async (active) => note('helper', 'setActive', { active }),
    sendInput: async (command) => note('helper', 'sendInput', { command: clone(command) }),
    sendGrant: async (grant) => note('helper', 'sendGrant', { grant: clone(grant) }),
    setVideoRun: (epoch) => note('helper', 'setVideoRun', { epoch }),
    latestFrame: () => null,
    onFrame: listen(helperSets.frame),
    onDesktopChanged: listen(helperSets.change),
    onGrantChallenge: listen(helperSets.challenge),
    onHelperIssue: listen(helperSets.issue),
    installState: async (key) => {
      note('helper', 'installState', { key: key ?? null });
      return world.installState;
    },
    requestInstall: (key) => {
      note('helper', 'requestInstall', { key });
      return new Promise((resolve, reject) => deferred.install.push({ resolve, reject }));
    },
    ensureRunning: () => {
      note('helper', 'ensureRunning');
      const next = world.ensure[Math.min(ensures, world.ensure.length - 1)] ?? { installed: true, running: true };
      ensures += 1;
      return next === 'reject' ? Promise.reject(new Error('start failed')) : Promise.resolve(next);
    },
    dispose: () => note('helper', 'dispose'),
  };
  const pcAccess = world.noPcAccess
    ? undefined
    : {
        accountIsAdmin: async () => {
          note('pcAccess', 'accountIsAdmin');
          return world.accountIsAdmin;
        },
        approveWithCredential: (request) => {
          note('pcAccess', 'approveWithCredential', { clientId: request.clientId, publicKey: request.publicKey, credential: clone(request.credential) });
          request.signal?.addEventListener('abort', () => note('pcAccess', 'aborted'));
          return new Promise((resolve, reject) => deferred.credential.push({ resolve, reject, credential: request.credential }));
        },
      };
  const time = new VirtualTime(START);
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
  try {
    const source = createRemoteScreenSource({
      clientId: 'phone-1',
      clientLabel: 'Phone',
      screenId: '7',
      displays: { list: () => world.displays, onChange: listen(displayChange) },
      authorization: { paired: () => world.paired, lost: () => world.lost, onChange: listen(authChange) },
      createInputHost: () => {
        note('deps', 'createInputHost');
        return host;
      },
      secureDesktop: lease,
      pcAccess,
      indicator: {
        show: (view) => {
          indicatorStop = view.onStop;
          note('indicator', 'show', { clientLabel: view.clientLabel, controlling: view.controlling, screenId: view.screenId });
        },
        update: (view) => note('indicator', 'update', { controlling: view.controlling }),
        hide: () => note('indicator', 'hide'),
      },
      log: (event) => log.push({ ev: 'log', event: clone(event) }),
      maxFrameRate: world.maxFrameRate,
      sampleCursor: world.sampleCursor,
      shutdownDeadlineMs: world.shutdownDeadlineMs,
    });
    source.onStatus((status) => log.push({ ev: 'status', status: clone(status) }));
    source.onVideoPath((path) => log.push({ ev: 'videoPath', path }));
    source.onCursor((cursor) => log.push({ ev: 'cursor', cursor: clone(cursor) }));
    source.onGeometry((renewal) => log.push({ ev: 'geometry', renewal: clone(renewal) }));
    source.onStop((reason) => log.push({ ev: 'stopped', reason }));
    source.onHelperHold(() => log.push({ ev: 'hold' }));
    source.onHelperChallenge((challenge) => log.push({ ev: 'challenge', challenge: clone(challenge) }));
    source.onFrame((picture) =>
      log.push({ ev: 'frame', picture: { bytes: picture.pixels.length, width: picture.width, height: picture.height, stride: picture.stride, source: picture.source, target: picture.target } })
    );
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'start':
          start(step.as, source.start());
          break;
        case 'query':
          log.push({
            ev: 'query',
            running: source.running(),
            geometry: clone(source.geometry()),
            plan: clone(source.capturePlan()),
            status: clone(source.status()),
            videoPath: source.videoPath(),
            cursor: clone(source.cursor()),
          });
          break;
        case 'listDisplays':
          log.push({ ev: 'displays', list: clone(source.listDisplays()) });
          break;
        case 'hostDesktop':
          local = step.local;
          fire(hostDesktop, local);
          break;
        case 'helper':
          Object.assign(world.helper, step.fields);
          if (step.changed) fire(helperSets.change);
          break;
        case 'helperFrame': {
          const { width, height, stride, originX, originY } = step.frame;
          fire(helperSets.frame, { width, height, stride, originX, originY, pixels: new Uint8Array(stride * height) });
          break;
        }
        case 'helperIssue':
          fire(helperSets.issue, step.code);
          break;
        case 'helperChallenge':
          fire(helperSets.challenge, step.challenge);
          break;
        case 'helperHold':
          fire(helperSets.hold);
          break;
        case 'setHelperVideo':
          source.setHelperVideo(step.value);
          break;
        case 'setVideoRun':
          source.setVideoRun(step.epoch);
          break;
        case 'nextVideoRun':
          log.push({ ev: 'nextVideoRun', epoch: source.nextVideoRun() });
          break;
        case 'input':
          start(step.as, source.handleInput(clone(step.input), step.generation));
          break;
        case 'grant':
          source.helperGrant(clone(step.grant));
          break;
        case 'install':
          source.requestHelperInstall(step.key);
          break;
        case 'finishInstall': {
          const pending = deferred.install[step.n];
          if (step.reject) pending.reject(new Error(step.reject));
          else pending.resolve(step.result);
          break;
        }
        case 'credential': {
          const credential = clone(step.credential);
          source.requestHelperCredential(step.key, credential);
          log.push({ ev: 'credentialAfter', credential: clone(credential) });
          break;
        }
        case 'finishCredential': {
          const pending = deferred.credential[step.n];
          if (step.reject) pending.reject(new Error(step.reject));
          else pending.resolve(step.result);
          break;
        }
        case 'displays':
          world.displays = step.list;
          fire(displayChange);
          break;
        case 'unpair':
          world.paired = false;
          world.lost = step.reason;
          fire(authChange);
          break;
        case 'indicatorStop':
          indicatorStop();
          break;
        case 'hostExit':
          fire(hostExit);
          break;
        case 'hostFails':
          hostFails = step.value;
          break;
        case 'hostHangs':
          hostHangs = true;
          break;
        case 'stop':
          start(step.as, source.stop(step.reason, step.deadlineMs === undefined ? {} : { deadlineMs: step.deadlineMs }));
          break;
        case 'released':
          start(step.as, source.released());
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
    log.push({ ev: 'credentials', wiped: deferred.credential.map((entry) => clone(entry.credential)) });
  } finally {
    time.restore();
  }
  return { ...scenario, trace: log, final: { elapsedMs: time.elapsed(), pendingTimers: time.pending().length } };
}

await record({
  sub: 'session',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
