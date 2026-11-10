#!/usr/bin/env node
// Node's secure-desktop helper lease (apps/desktop/src/main/remote-screen/secure-desktop-helper.ts): the one helper
// adapter every screen session reaches through its own lease — who holds it and in what order the hold passes, the
// helper-wide video-run counter, the grants and input only the holder may send (the challenges it was shown, each
// used once, the four the helper keeps), the paired phone's install request with its latched decline, the rebuild of
// the adapter after an install, the shared service start, and dispose. Each scenario is a script of steps against
// a fake adapter (what the real client would be told) and a fake installer port that only records what it is asked:
// nothing is installed, nothing prompts. The golden holds the script and the whole trace Node gave: every adapter
// call in order (across rebuilt adapters), every installer call, every listener notification with the lease that
// heard it, every call's outcome, and the final state. Rust's lease must replay each script to the same trace.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-lease.mjs --tree <tree>)
import { checkpoint, importTs, openTree, writeSub } from './record-screen-control-lib.mjs';

const { tree, identity } = openTree();
const { createSecureDesktopHelper, DECLINED_ON_PC } = await importTs(tree, 'apps/desktop/src/main/remote-screen/secure-desktop-helper.ts');

const KEY = 'key-a';
const KEY_B = 'key-b';
const keyDown = { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true };
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const lease = (as) => ({ op: 'lease', as });
const listen = (name, hold = null) => ({ op: 'listen', lease: name, hold });
const active = (as, name, value) => [{ op: 'setActive', as, lease: name, active: value }, { op: 'await', call: as }];
const call = (op, as, name, extra = {}) => [{ op, as, lease: name, ...extra }, { op: 'await', call: as }];
const challenge = (value, nonce = 'n') => ({ op: 'adapterChallenge', nonce, challenge: value });
const grant = (as, name, value, epoch) => call('sendGrant', as, name, { grant: { challenge: value, epoch, signature: 's' } });
const input = (as, name) => call('sendInput', as, name, { command: keyDown });
const installerResult = (value) => ({ op: 'installerResult', value });
const request = (as, name, key = KEY) => call('requestInstall', as, name, { key });

const SCENARIOS = [
  {
    name: 'the install request goes to the installer with the phone’s key; installed or updated rebuilds the adapter, nothing else does',
    world: { installed: false, state: 'not-installed' },
    steps: [
      lease('A'),
      listen('A'),
      ...active('a-on', 'A', true),
      { op: 'setVideoRun', lease: 'A', epoch: 3 },
      ...['failed', 'in-progress', 'other-user', 'unavailable'].flatMap((outcome) => [
        installerResult({ outcome, state: 'not-installed' }),
        ...request(`request-${outcome}`, 'A'),
      ]),
      installerResult({ outcome: 'installed', state: 'installed' }),
      ...request('request-installed', 'A'),
      { op: 'query', lease: 'A', what: 'installed' },
      challenge('c'),
      ...grant('grant', 'A', 'c', 3),
      ...input('input', 'A'),
      installerResult({ outcome: 'updated', state: 'installed' }),
      ...request('request-updated', 'A'),
      lease('B'),
      installerResult({ outcome: 'installed', state: 'installed' }),
      { op: 'requestInstall', as: 'joint-a', lease: 'A', key: KEY },
      { op: 'requestInstall', as: 'joint-b', lease: 'B', key: KEY },
      { op: 'await', call: 'joint-a' },
      { op: 'await', call: 'joint-b' },
    ],
  },
  {
    name: 'a request that changes nothing keeps the live adapter: installed and current for that key before it',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('A'),
      ...active('a-on', 'A', true),
      installerResult({ outcome: 'installed', state: 'installed' }),
      ...request('current', 'A'),
      { op: 'installerState', value: 'outdated' },
      installerResult({ outcome: 'updated', state: 'installed' }),
      ...request('outdated', 'A'),
    ],
  },
  {
    name: 'a request that ends after an adapter built before the install rebuilds it',
    world: { installed: false, state: 'installed' },
    steps: [lease('A'), installerResult({ outcome: 'installed', state: 'installed' }), ...request('stale', 'A')],
  },
  {
    name: 'one prompt per request and none after a refusal: a decline latches for every session until restart',
    world: { installed: false, state: 'not-installed' },
    steps: [
      lease('A'),
      installerResult({ outcome: 'declined', state: 'not-installed' }),
      ...request('first', 'A'),
      lease('B'),
      lease('C'),
      ...request('second', 'B'),
      ...request('third', 'C'),
      ...request('again', 'A', KEY_B),
    ],
  },
  {
    name: 'one session holds the helper: only its runs, grants, input and helper events; the hold passes on deactivation or when it ends',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('first'),
      lease('second'),
      listen('first', 'mint'),
      listen('second', 'mint'),
      { op: 'mintRun', lease: 'second', declare: true },
      ...active('first-on', 'first', true),
      { op: 'query', lease: 'first', what: 'ownedElsewhere' },
      { op: 'query', lease: 'second', what: 'ownedElsewhere' },
      ...active('second-on', 'second', true),
      { op: 'mintRun', lease: 'second', declare: true },
      challenge('c1', 'n1'),
      { op: 'adapterIssue', code: 'grant_expired' },
      { op: 'adapterFrame', frame: { id: 1 } },
      ...grant('second-grant', 'second', 'c1', 2),
      ...input('second-input', 'second'),
      { op: 'latestFrame', lease: 'second' },
      ...grant('first-grant', 'first', 'c1', 2),
      ...input('first-input', 'first'),
      ...active('first-off', 'first', false),
      { op: 'query', lease: 'second', what: 'ownedElsewhere' },
      { op: 'query', lease: 'first', what: 'ownedElsewhere' },
      ...grant('stale-grant', 'first', 'c1', 2),
      challenge('c2', 'n2'),
      ...grant('second-grant-2', 'second', 'c2', 4),
      ...active('first-wait', 'first', true),
      { op: 'disposeLease', lease: 'second' },
      { op: 'query', lease: 'first', what: 'ownedElsewhere' },
      ...active('second-after-dispose', 'second', true),
      { op: 'query', lease: 'first', what: 'ownedElsewhere' },
      ...active('first-off-last', 'first', false),
      { op: 'query', lease: 'first', what: 'ownedElsewhere' },
    ],
  },
  {
    name: 'the four challenges the helper still keeps (issued at 0, 2, 4 and 6 s) stay answerable; the fifth evicts the oldest',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('A'),
      listen('A', { declare: 1 }),
      ...active('on', 'A', true),
      ...['c0', 'c2', 'c4', 'c6'].map((value) => challenge(value)),
      ...grant('c0', 'A', 'c0', 1),
      challenge('c8'),
      challenge('c10'),
      ...grant('c2', 'A', 'c2', 1),
      ...grant('c4', 'A', 'c4', 1),
    ],
  },
  {
    name: 'a handover at the same epoch still revokes: the successor’s input waits for its own grant for a new challenge',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('first'),
      lease('second'),
      listen('first', { declare: 1 }),
      listen('second', { declare: 1 }),
      ...active('first-on', 'first', true),
      challenge('first-1'),
      ...grant('first-grant', 'first', 'first-1', 1),
      ...input('first-input', 'first'),
      ...active('second-on', 'second', true),
      ...active('first-off', 'first', false),
      ...input('second-input-early', 'second'),
      challenge('second-1'),
      ...grant('wrong-run', 'second', 'second-1', 2),
      ...input('second-input-still-early', 'second'),
      ...grant('second-grant', 'second', 'second-1', 1),
      ...input('second-input', 'second'),
      ...grant('used-again', 'second', 'second-1', 1),
    ],
  },
  {
    name: 'an old challenge of the previous holder is dead after the handover',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('first'),
      lease('second'),
      listen('first', 'mint'),
      listen('second', 'mint'),
      ...active('first-on', 'first', true),
      challenge('open-1'),
      challenge('open-2'),
      ...active('second-on', 'second', true),
      ...active('first-off', 'first', false),
      ...grant('second-1', 'second', 'open-1', 3),
      ...grant('first-1', 'first', 'open-1', 1),
      ...grant('second-2', 'second', 'open-2', 3),
      ...grant('first-2', 'first', 'open-2', 1),
    ],
  },
  {
    name: 'a check that reads installed while the adapter reports not installed rebuilds it',
    world: { installed: false, state: 'not-installed' },
    steps: [
      lease('A'),
      ...call('installState', 'check-1', 'A'),
      { op: 'installerState', value: 'installed' },
      ...call('installState', 'check-2', 'A', { key: KEY }),
      ...call('installState', 'check-3', 'A'),
    ],
  },
  {
    name: 'a check never rebuilds an installed adapter',
    world: { installed: true, state: 'installed' },
    steps: [lease('A'), ...call('installState', 'check', 'A')],
  },
  {
    name: 'ensureRunning starts a stopped service through the installer; callers together share one attempt; a connected helper needs none',
    world: { installed: true, state: 'installed' },
    steps: [
      lease('A'),
      lease('B'),
      { op: 'installerDefer', request: false, ensure: true },
      { op: 'ensureRunning', as: 'first', lease: 'A' },
      { op: 'ensureRunning', as: 'second', lease: 'B' },
      settle(),
      { op: 'finishEnsure', result: { installed: true, running: false } },
      { op: 'await', call: 'first' },
      { op: 'await', call: 'second' },
      { op: 'ensureRunning', as: 'third', lease: 'A' },
      settle(),
      { op: 'finishEnsure', result: { installed: true, running: true } },
      { op: 'await', call: 'third' },
      { op: 'adapterConnected', value: true },
      ...call('ensureRunning', 'connected', 'A'),
    ],
  },
  {
    name: 'dispose: the adapter goes, and a request that ends later rebuilds nothing',
    world: { installed: false, state: 'not-installed' },
    steps: [
      lease('A'),
      { op: 'installerDefer', request: true, ensure: false },
      { op: 'requestInstall', as: 'pending', lease: 'A', key: KEY },
      settle(),
      { op: 'disposeHelper' },
      { op: 'finishRequest', n: 0, result: { outcome: 'installed', state: 'installed' } },
      { op: 'await', call: 'pending' },
      { op: 'installerState', value: 'installed' },
      ...call('installState', 'check', 'A'),
      { op: 'disposeHelper' },
    ],
  },
  {
    name: 'a lease taken after the helper was disposed is inert',
    world: { installed: true, state: 'installed' },
    steps: [{ op: 'disposeHelper' }, lease('A'), ...active('on', 'A', true), { op: 'query', lease: 'A', what: 'ownedElsewhere' }],
  },
];
function settle() {
  return { op: 'settle' };
}

// ---------------------------------------------------------------------------

async function play(scenario) {
  const log = [];
  const built = [];
  const installer = { current: scenario.world.state, result: null, deferRequest: false, deferEnsure: false, requests: [], ensures: [] };
  const fakeAdapter = (index, isInstalled) => {
    const listeners = { change: new Set(), frame: new Set(), challenge: new Set(), issue: new Set() };
    const link = { connected: false, latest: null };
    const note = (...args) => {
      log.push({ ev: 'adapter', adapter: index, call: args });
    };
    const add = (set) => (listener) => {
      set.add(listener);
      return () => set.delete(listener);
    };
    return {
      listeners,
      link,
      attached: () => Object.values(listeners).reduce((sum, set) => sum + set.size, 0),
      adapter: {
        installed: () => isInstalled,
        connected: () => link.connected,
        desktop: () => null,
        session: () => null,
        locked: () => null,
        setActive: async (value) => note('active', value),
        sendInput: async (command) => note('input', command.op),
        sendGrant: async (grantValue) => note('grant', grantValue.epoch),
        setVideoRun: (epoch) => note('run', epoch),
        latestFrame: () => link.latest,
        onFrame: add(listeners.frame),
        onDesktopChanged: add(listeners.change),
        onGrantChallenge: add(listeners.challenge),
        onHelperIssue: add(listeners.issue),
        dispose: () => note('dispose'),
      },
    };
  };
  const port = {
    state: async (key) => {
      log.push({ ev: 'installer', call: 'state', key: key ?? null });
      return installer.current;
    },
    request: (key) => {
      log.push({ ev: 'installer', call: 'request', key });
      if (installer.deferRequest) return new Promise((resolve) => installer.requests.push(resolve));
      return Promise.resolve(installer.result);
    },
    ensureRunning: () => {
      log.push({ ev: 'installer', call: 'ensureRunning' });
      if (installer.deferEnsure) return new Promise((resolve) => installer.ensures.push(resolve));
      return Promise.resolve({ installed: true, running: true });
    },
  };
  const helper = createSecureDesktopHelper({
    adapter: () => {
      const fake = fakeAdapter(built.length, built.length === 0 ? scenario.world.installed : true);
      built.push(fake);
      return fake.adapter;
    },
    installer: port,
  });
  const leases = new Map();
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
  const current = () => built.at(-1);
  for (const step of scenario.steps) {
    const held = step.lease ? leases.get(step.lease) : null;
    switch (step.op) {
      case 'lease':
        leases.set(step.as, helper.lease());
        break;
      case 'listen': {
        const name = step.lease;
        const target = leases.get(name);
        target.onHold(() => {
          if (step.hold === 'mint') {
            const epoch = target.mintVideoRun();
            log.push({ ev: 'hold', lease: name, epoch });
            target.setVideoRun(epoch);
          } else if (step.hold) {
            log.push({ ev: 'hold', lease: name, epoch: step.hold.declare });
            target.setVideoRun(step.hold.declare);
          } else log.push({ ev: 'hold', lease: name, epoch: null });
        });
        target.onDesktopChanged(() => log.push({ ev: 'heard', lease: name, kind: 'change', ownedElsewhere: target.ownedElsewhere(), installed: target.installed() }));
        target.onGrantChallenge((value) => log.push({ ev: 'heard', lease: name, kind: 'challenge', challenge: clone(value) }));
        target.onHelperIssue((code) => log.push({ ev: 'heard', lease: name, kind: 'issue', code }));
        target.onFrame((frame) => log.push({ ev: 'heard', lease: name, kind: 'frame', frame: clone(frame) }));
        break;
      }
      case 'setActive':
        start(step.as, held.setActive(step.active));
        break;
      case 'setVideoRun':
        held.setVideoRun(step.epoch);
        log.push({ ev: 'declared', lease: step.lease, epoch: step.epoch });
        break;
      case 'mintRun': {
        const epoch = held.mintVideoRun();
        log.push({ ev: 'minted', lease: step.lease, epoch });
        if (step.declare) held.setVideoRun(epoch);
        break;
      }
      case 'sendGrant':
        start(step.as, held.sendGrant(step.grant));
        break;
      case 'sendInput':
        start(step.as, held.sendInput(step.command));
        break;
      case 'latestFrame':
        log.push({ ev: 'latestFrame', lease: step.lease, frame: clone(held.latestFrame()) });
        break;
      case 'query':
        log.push({ ev: 'query', lease: step.lease, what: step.what, value: held[step.what]() });
        break;
      case 'requestInstall':
        start(step.as, held.requestInstall(step.key));
        break;
      case 'installState':
        start(step.as, held.installState(step.key));
        break;
      case 'ensureRunning':
        start(step.as, held.ensureRunning());
        break;
      case 'disposeLease':
        held.dispose();
        break;
      case 'disposeHelper':
        helper.dispose();
        break;
      case 'adapterChallenge':
        for (const listener of [...current().listeners.challenge]) listener({ nonce: step.nonce, challenge: step.challenge });
        break;
      case 'adapterIssue':
        for (const listener of [...current().listeners.issue]) listener(step.code);
        break;
      case 'adapterFrame':
        for (const listener of [...current().listeners.frame]) listener(step.frame);
        break;
      case 'adapterConnected':
        current().link.connected = step.value;
        break;
      case 'installerState':
        installer.current = step.value;
        break;
      case 'installerResult':
        installer.result = step.value;
        break;
      case 'installerDefer':
        installer.deferRequest = step.request;
        installer.deferEnsure = step.ensure;
        break;
      case 'finishRequest':
        installer.requests[step.n](step.result);
        break;
      case 'finishEnsure':
        installer.ensures.shift()(step.result);
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
  return {
    ...scenario,
    trace: log,
    final: {
      built: built.length,
      attached: built.map((fake) => fake.attached()),
      ownedElsewhere: Object.fromEntries([...leases].map(([name, held]) => [name, held.ownedElsewhere()])),
    },
  };
}

const scenarios = [];
for (const scenario of SCENARIOS) scenarios.push(await play(scenario));
writeSub('lease', { 'scenarios.json': { declinedOnPc: DECLINED_ON_PC, scenarios } }, identity);
console.log(`lease: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.trace.length, 0)} trace events`);
process.exit(0);
