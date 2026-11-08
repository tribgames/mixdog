#!/usr/bin/env node
// Node's reconnect schedule of the desktop's relay leg (`createRelayDeviceConnection`,
// remote-relay-connection.ts): the delay of every redial after a close, recorded from the committed
// product against a local `ws` server that plays the relay and closes the leg the way each step says.
//
// The product schedules with `setTimeout`. This recorder reads the delay the product asked for and fires the
// timer itself (a leg that "holds 30 s" is the product's own stable-leg timer fired on demand), so nothing
// waits and the product code is unmodified. Timers are recognized by the product file in their call stack.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-remote-relay-redial.mjs --tree <git checkout with node_modules>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);
const work = mkdtempSync(join(tmpdir(), 'mixdog-relay-redial-'));
const userData = join(work, 'userData');
mkdirSync(userData, { recursive: true });
// Nothing the product reads or writes may resolve outside `work`: the real desktop profile and Mixdog data are never touched.
for (const [name, dir] of Object.entries({
  APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', HOME: 'home-dir', USERPROFILE: 'home-dir', MIXDOG_DESKTOP_USER_DATA: 'userData',
  MIXDOG_DATA_DIR: 'data', MIXDOG_HOME: 'home', MIXDOG_CONFIG_DIR: 'config', MIXDOG_RUNTIME_ROOT: 'runtime',
})) {
  process.env[name] = join(work, dir);
  mkdirSync(process.env[name], { recursive: true });
}
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { createRelayDeviceConnection } = await main('remote-relay-connection');
const { loadOrCreateDevice } = await main('remote-relay-device');
const { DESKTOP_HANDSHAKE_STALLED_CLOSE } = await importFrom(tree, 'apps/relay/lib/relay-close-codes.mjs');

// ---- the product's timers, seen and fired by hand ------------------------------------------------
const timers = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (!new Error().stack.includes('remote-relay-connection')) return realSetTimeout(fn, ms, ...rest);
  const timer = { fn, ms, cleared: false, fired: false, unref: () => timer };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timer && typeof timer === 'object' && 'fired' in timer) timer.cleared = true;
  else realClearTimeout(timer);
};
const pending = () => timers.filter((t) => !t.cleared && !t.fired);
const fire = (timer) => {
  timer.fired = true;
  timer.fn();
};

// ---- the relay stand-in --------------------------------------------------------------------------
let serverSocket = null;
let refuse = false;
let wake = () => {};
const counters = { opens: 0, lost: 0 };
const wss = new WebSocketServer({
  port: 0,
  host: '127.0.0.1',
  // A refused upgrade is a dial that fails: the product closes that attempt and schedules the next one.
  verifyClient: (_info, done) => (refuse ? done(false, 503, 'refused') : done(true)),
});
wss.on('connection', (ws) => {
  serverSocket = ws;
});
await new Promise((r) => wss.once('listening', r));
const until = (what, ready, ms = 8000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const check = () => {
      if (ready()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      realSetTimeout(check, 10);
    };
    check();
  });

const identity = await loadOrCreateDevice(userData);
const connection = createRelayDeviceConnection({
  relayUrl: `ws://127.0.0.1:${wss.address().port}`,
  identity,
  maxPayload: 1 << 20,
  onOpen: () => {
    counters.opens += 1;
    wake();
  },
  onEnvelope: () => {},
  onLegEnded: () => {},
  onLegLost: () => {
    counters.lost += 1;
    wake();
  },
});

// The redial the product scheduled last; a firing timer is the delay having passed.
const scheduled = () => pending().at(-1);

// `drop`: the relay ends the established leg (`code` null = the connection just dies).
// `fail`: the redial attempt that follows is refused by the relay, so the product backs off again.
// `recover`: the redial attempt that follows is accepted, so the leg opens.
// `stable`: the leg has held for the product's stable-leg time.
// A step that schedules a redial records the delay the product asked for.
async function run(script) {
  const steps = [];
  for (const step of script) {
    if (step.op === 'stable') {
      const stable = pending().filter((t) => t.ms === 30_000).at(-1);
      if (!stable) throw new Error('no stable-leg timer is pending');
      fire(stable);
      steps.push({ op: 'stable' });
    } else if (step.op === 'recover') {
      const opens = counters.opens;
      refuse = false;
      fire(scheduled());
      await until('the redial to open', () => counters.opens > opens);
      steps.push({ op: 'recover' });
    } else {
      const lost = counters.lost;
      if (step.op === 'fail') {
        refuse = true;
        fire(scheduled());
      } else if (step.code === null) serverSocket.terminate();
      else serverSocket.close(step.code, '');
      await until('the leg loss', () => counters.lost > lost);
      steps.push(step.op === 'fail' ? { op: 'fail', delayMs: scheduled().ms } : { op: 'drop', code: step.code, delayMs: scheduled().ms });
    }
  }
  return steps;
}

connection.connect();
await until('the first open', () => counters.opens > 0);

const drop = (code) => ({ op: 'drop', code });
const STALLED = DESKTOP_HANDSHAKE_STALLED_CLOSE;
const fail = { op: 'fail' };
const recover = { op: 'recover' };
const stable = { op: 'stable' };
// Backoff doubling while redials keep failing.
const ladder = await run([drop(null), fail, fail, recover]);
// Closes the relay made because a joining phone waited on a dead leg: the first two redial at once, the third
// waits the backoff.
const stalled = await run([drop(STALLED), recover, drop(STALLED), recover, drop(STALLED), recover]);
// The whole rule: the cap, the reset an open brings after ordinary drops, the stalled record that an open does not
// clear, and the stable leg that clears it.
const full = await run([
  stable,
  drop(null), fail, fail, fail, fail, fail, fail, recover,
  drop(1001), recover,
  drop(STALLED), recover, drop(STALLED), recover, drop(STALLED), fail, recover,
  drop(null), recover,
  stable,
  drop(null), recover,
  drop(STALLED), recover,
]);

connection.beginClose();
connection.cancelTimers();
connection.terminate();
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
for (const c of wss.clients) c.terminate();
await new Promise((r) => wss.close(r));
const finalOut = join(FIXTURES_ROOT, 'remote-relay-redial');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'Node createRelayDeviceConnection: the delay (ms) of the redial scheduled after each close of the relay leg. `code: null` is a dropped connection with no close frame.',
  stalledCloseCode: DESKTOP_HANDSHAKE_STALLED_CLOSE,
  ladder,
  stalled,
  full,
});
writeSetManifest(out, {
  set: 'remote-relay-redial',
  recorder: 'benchmarks/rust-core/recorders/record-remote-relay-redial.mjs',
  command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-remote-relay-redial.mjs --tree <git checkout of b6f10295a2f698afc85332467192de28500bd146 with node_modules>',
  identityTree: tree,
  identityRef: REF,
  extra: { ladder: ladder.length, stalled: stalled.length, full: full.length },
});
commitStage(out, finalOut);
rmSync(work, { recursive: true, force: true });
console.log(`remote-relay-redial: ${ladder.length} ladder, ${stalled.length} stalled, ${full.length} full steps`);
process.exit(0);
