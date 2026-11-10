#!/usr/bin/env node
// Node's on-demand install request for the secure-desktop helper (apps/desktop/src/main/secure-desktop/
// install-request.ts, `createSecureDesktopInstaller` over its port): the paired phone's request carrying its
// controller key — at most one prompt, joined by the same phone, `in-progress` for another phone or an unanswered
// prompt, a launched elevation latched until it settles, the image check before any prompt, an enroll for a phone whose
// key a current install lacks, every exit code's outcome and detail — and `installOfferFor`. Each scenario is a script
// of requests, state reads, service starts, exits of the launched elevation and virtual-clock advances against a fake
// port that only records what it is asked: `runKeyOp` is the elevation the PC's user would approve, and here it is a
// list entry the script ends. Nothing is launched, nothing is installed, no UAC prompt appears. The golden holds the
// script and the whole trace Node gave. Rust's installer must replay each script to the same trace, and `declined`
// must come out the same when the PC-side approval hook refuses before anything is launched.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-install.mjs --tree <tree>)
import { VirtualTime, checkpoint, importTs, openTree, writeSub } from './record-screen-control-lib.mjs';

const { tree, identity } = openTree();
const { createSecureDesktopInstaller } = await importTs(tree, 'apps/desktop/src/main/secure-desktop/install-request.ts');
const client = await importTs(tree, 'apps/desktop/src/main/secure-desktop/client.ts');

const controllerKey = (fill) => Buffer.from([4, ...new Array(64).fill(fill)]).toString('base64url');
const KEY = controllerKey(7);
const OTHER = controllerKey(9);
const THIRD = controllerKey(11);
const EXITS = {
  declined: client.ELEVATION_DECLINED_EXIT,
  busy: client.SECURE_DESKTOP_BUSY_EXIT,
  otherUser: client.SECURE_DESKTOP_OTHER_USER_EXIT,
  untrusted: client.SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT,
  revocation: client.SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT,
};

const request = (as, key = KEY) => ({ op: 'request', as, key });
const done = (as) => ({ op: 'await', call: as });
const run = (as, key = KEY) => [request(as, key), done(as)];
const settle = { op: 'settle' };

const SCENARIOS = [
  { name: 'the phone key reaches check and the elevated install', world: { states: ['not-installed', 'installed'], elevations: [0] }, steps: run('request') },
  {
    name: 'a missing or invalid phone key fails without a prompt',
    world: { states: ['not-installed'] },
    steps: [
      ...run('undefined', null),
      ...run('empty', ''),
      ...run('not-a-key', 'not-a-key'),
      ...run('compressed', Buffer.from([2, ...new Array(32).fill(7)]).toString('base64url')),
      ...run('padded', `${KEY}=`),
    ],
  },
  {
    name: 'a phone asking after the helper binary changed gets an approved update that enrolls its key',
    world: { states: ['outdated', 'outdated', 'installed'], elevations: [0] },
    steps: [{ op: 'state', as: 'offer', key: OTHER }, done('offer'), ...run('request', OTHER)],
  },
  {
    name: 'a second phone does not join or take over another phone’s running request',
    world: { states: ['not-installed', 'not-installed', 'installed'], elevations: ['defer'] },
    steps: [request('first'), settle, ...run('second', OTHER), { op: 'exit', n: 0, code: 0 }, done('first')],
  },
  { name: 'a request installs a missing helper with one prompt', world: { states: ['not-installed', 'installed'], elevations: [0] }, steps: run('request') },
  { name: 'a request updates an outdated helper and reports it as an update', world: { states: ['outdated', 'installed'], elevations: [0] }, steps: run('request') },
  {
    name: 'a current, unavailable, or other-user helper never prompts',
    world: { states: ['installed', 'unavailable', 'other-user'], elevations: [] },
    steps: [...run('installed'), ...run('unavailable'), ...run('other-user')],
  },
  {
    name: 'a declined prompt reports declined and is not retried',
    world: { states: ['not-installed'], elevations: [EXITS.declined, 0] },
    steps: [...run('request'), { op: 'query', what: 'pending' }, { op: 'state', as: 'read' }, done('read')],
  },
  {
    name: 'an elevation still running at the report deadline latches: repeated requests launch once',
    world: { states: ['not-installed'], elevations: ['defer', 0], reportAfterMs: 5 },
    steps: [
      request('first'),
      settle,
      { op: 'advance', ms: 5 },
      done('first'),
      ...run('second'),
      ...run('third'),
      { op: 'query', what: 'pending' },
      { op: 'exit', n: 0, code: EXITS.declined },
      settle,
      { op: 'query', what: 'pending' },
      ...run('after'),
    ],
  },
  {
    name: 'a latched request answers installed on its own installed check, but the latch holds until the child settles',
    world: { states: ['not-installed', 'not-installed', 'installed'], elevations: ['defer'], reportAfterMs: 5 },
    steps: [
      request('first'),
      settle,
      { op: 'advance', ms: 5 },
      done('first'),
      ...run('second'),
      { op: 'query', what: 'pending' },
      { op: 'exit', n: 0, code: 0 },
      settle,
      { op: 'query', what: 'pending' },
    ],
  },
  {
    name: 'an enrolled phone’s installed check never releases another phone’s latch: B pending, A installed, C requests → one launch',
    world: { statesByKey: { [KEY]: 'installed' }, states: ['outdated'], elevations: ['defer'], reportAfterMs: 5 },
    steps: [
      request('b', OTHER),
      settle,
      ...run('a', KEY),
      { op: 'advance', ms: 5 },
      done('b'),
      ...run('c', THIRD),
      { op: 'query', what: 'pending' },
      { op: 'exit', n: 0, code: 0 },
      settle,
      { op: 'query', what: 'pending' },
    ],
  },
  {
    name: 'a phone whose key a current install lacks is enrolled, never reinstalled, and no image is checked',
    world: { states: ['not-enrolled', 'installed'], elevations: [0] },
    steps: run('request'),
  },
  {
    name: 'a build the elevated install would refuse fails with the reason before any prompt',
    world: { states: ['not-installed'], image: { ok: false, detail: 'the helper image was refused' }, elevations: [] },
    steps: run('request'),
  },
  {
    name: 'every exit code of the elevated install has its outcome',
    world: { states: ['not-installed'], elevations: [EXITS.busy, EXITS.otherUser, EXITS.untrusted, EXITS.revocation, 9, 0, { throw: 'spawn failed' }] },
    steps: ['busy', 'other-user', 'untrusted', 'revocation', 'other', 'exit-0-not-installed', 'spawn-error'].flatMap((name) => run(name)),
  },
  {
    name: 'an outdated helper replaced by an exit 0 is an update, an installed one an install',
    world: { states: ['outdated', 'installed', 'not-installed', 'installed'], elevations: [0, 0] },
    steps: [...run('update'), ...run('install')],
  },
  {
    name: 'a request after the elevation settled launches again',
    world: { states: ['not-installed'], elevations: ['defer', 0], reportAfterMs: 5 },
    steps: [
      request('first'),
      settle,
      { op: 'advance', ms: 5 },
      done('first'),
      { op: 'exit', n: 0, code: 0 },
      settle,
      ...run('second'),
    ],
  },
  {
    name: 'the same phone joins its own running request',
    world: { states: ['not-installed', 'not-installed', 'installed'], elevations: ['defer'] },
    steps: [request('first'), request('joined'), settle, { op: 'exit', n: 0, code: 0 }, done('first'), done('joined')],
  },
  {
    name: 'ensureRunning starts the registered service only when installed',
    world: { states: ['not-installed', 'installed'], starts: [{ installed: true, running: true }] },
    steps: [{ op: 'ensure', as: 'missing' }, done('missing'), { op: 'ensure', as: 'installed' }, done('installed')],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const START = 1_800_000_000_000;

async function play(scenario) {
  const world = { states: ['installed'], statesByKey: {}, elevations: [], starts: [], image: { ok: true }, reportAfterMs: undefined, ...scenario.world };
  const log = [];
  const children = [];
  let checks = 0;
  let starts = 0;
  let elevations = 0;
  const port = {
    async check(key) {
      log.push({ ev: 'port', call: 'check', key: key ?? null });
      const byKey = key !== undefined && Object.hasOwn(world.statesByKey, key) ? world.statesByKey[key] : null;
      const state = byKey ?? world.states[Math.min(checks, world.states.length - 1)];
      checks += 1;
      return state;
    },
    async verifyImage() {
      log.push({ ev: 'port', call: 'verifyImage' });
      return world.image;
    },
    async startService() {
      log.push({ ev: 'port', call: 'startService' });
      const next = world.starts[Math.min(starts, world.starts.length - 1)];
      starts += 1;
      return next ?? { installed: false, running: false };
    },
    runKeyOp(op) {
      log.push({ ev: 'port', call: 'runKeyOp', verb: op.verb, keys: op.keys, revoke: op.revoke });
      const next = world.elevations[elevations];
      elevations += 1;
      if (next === 'defer') return new Promise((resolve) => children.push(resolve));
      if (next?.throw) return Promise.reject(new Error(next.throw));
      return Promise.resolve(next);
    },
  };
  const time = new VirtualTime(START);
  time.install();
  const calls = new Map();
  try {
    const installer = createSecureDesktopInstaller(port, world.reportAfterMs === undefined ? {} : { reportAfterMs: world.reportAfterMs });
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
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'request':
          start(step.as, installer.request(step.key === null ? undefined : step.key));
          break;
        case 'state':
          start(step.as, installer.state(step.key));
          break;
        case 'ensure':
          start(step.as, installer.ensureRunning());
          break;
        case 'exit':
          children[step.n](step.code);
          break;
        case 'advance':
          log.push({ ev: 'advance', ms: step.ms, ran: await time.advance(step.ms) });
          break;
        case 'query':
          log.push({ ev: 'query', what: step.what, value: installer[step.what] });
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
    log.push({ ev: 'query', what: 'pending', value: installer.pending });
  } finally {
    time.restore();
  }
  return { ...scenario, trace: log, final: { elapsedMs: time.elapsed(), checks, elevations } };
}

const scenarios = [];
for (const scenario of SCENARIOS) scenarios.push(await play(scenario));
writeSub('install', { 'scenarios.json': { keys: { KEY, OTHER, THIRD }, exits: EXITS, scenarios } }, identity);
console.log(`install: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.trace.length, 0)} trace events`);
process.exit(0);
