// The phone's terminal and folder-watch adapter against a REAL mixdogd, in its own process (the shim keeps module-level state). The
// script is the one the Node recorder played (benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs); here the page's calls go
// through the adapter and the phone's protocol client, through the world's relay end (a real E2EE handshake), into a freshly started
// core on a loopback WebSocket. The relay end only carries frames both ways: the core answers for itself.
// Prints the trace on a marker line; remote-protocol-terminal.slow.test.mjs compares it with the recording.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEADLINE_MS, bounded, openClockSocket, stopCore } from './remote-protocol-terminal-deadlines.mjs';
import { createPhoneWorld, protocolDialect } from '../../../../benchmarks/rust-core/recorders/lib/phone-world.mjs';
import { play, record, sizeClaimScript, terminalScript } from '../../../../benchmarks/rust-core/recorders/lib/phone-terminal-script.mjs';

// The world replaces the timers with a virtual clock; this scenario's own deadline (a guard that fails a wait that never ends) is real.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/golden.json', import.meta.url), 'utf8'));
const ROOT = golden.root;
// A touched file's content changes with every touch (what the watcher reports is the change, not the time).
let touches = 0;
const CORE_ROOT = `${ROOT}-core`;
const CLOCK_DIR = join(CORE_ROOT, 'clock');
const BIN =process.env.MIXDOGD_BIN || 'D:\\mixdog-build\\pool\\w11-target\\debug\\mixdogd.exe';

async function startCore() {
  rmSync(CORE_ROOT, { recursive: true, force: true });
  for (const dir of ['runtime', 'data', 'home', 'clock']) mkdirSync(join(CORE_ROOT, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, { MIXDOG_RUNTIME_ROOT: join(CORE_ROOT, 'runtime'), MIXDOG_DATA_DIR: join(CORE_ROOT, 'data'), MIXDOG_HOME: join(CORE_ROOT, 'home'), MIXDOG_TERMINAL_LEASE_CLOCK: CLOCK_DIR });
  // The working directory is the recording's root: a path without a drive resolves onto its drive, as it did for Node's recorder.
  const child = spawn(BIN, ['serve'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  // The core publishes its discovery record when it serves (a debug core first migrates its stores): the wait is on that file's change.
  let record;
  try {
    record = await untilFile(join(CORE_ROOT, 'runtime'), child, (dir) => {
      const found = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'));
      return found.core?.state === 'serving' && found.core.rpc?.port ? found : null;
    }, 'the core to publish its serving discovery record (daemon.json)', CORE_START_DEADLINE_MS);
  } catch (error) {
    // The core is running by now: a start that fails ends it before the failure is reported.
    await stopCore({ child }).catch((left) => console.error(left.message));
    throw error;
  }
  return { child, url: `ws://127.0.0.1:${record.core.rpc.port}/rpc`, token: record.endpoints.session.token };
}

// A cold debug core measured about 50 s from spawn to its serving record (store migration), and twice passed 60 s in three runs.
const CORE_START_DEADLINE_MS = 180_000;

/** Resolves with `read(dir)` once it returns a value, trying again on each change in `dir` (a file system notification, no timer). */
function untilFile(dir, child, read, what, deadlineMs = DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      try {
        const value = read(dir);
        if (!value) return;
        done();
        resolve(value);
      } catch {}
    };
    const done = () => {
      realClearTimeout(timer);
      watcher.close();
    };
    const timer = realSetTimeout(() => {
      done();
      reject(new Error(`timed out after ${deadlineMs} ms waiting for ${what} in ${dir}`));
    }, deadlineMs);
    const watcher = watch(dir, attempt);
    child.once('exit', (status) => {
      done();
      reject(new Error(`the core exited (${status}) before ${what}`));
    });
    attempt();
  });
}

/** The manual lease clock's socket: the core writes its port into the clock directory, and answers each command with one line. */
async function openClock(core) {
  const port = await untilFile(CLOCK_DIR, core.child, (dir) => Number(readFileSync(join(dir, 'port'), 'utf8')) || null, "the core to publish the lease clock's port");
  return openClockSocket(port);
}

async function run(core) {
  const repo = new URL('../../../../', import.meta.url);
  const script = terminalScript(ROOT);

  // The relay end: every frame the phone sends goes to the core, every frame the core sends goes to the phone, each direction in order.
  let socket = null;
  let up = Promise.resolve();
  let down = Promise.resolve();
  let opened = null;
  let leg = null;
  // The last app-feed stamp the core sent: a reveal injected below continues that feed.
  let appStamp = null;
  let seqShift = 0;
  let initializeParams = null;
  const dialect = {
    ...protocolDialect({}),
    onFrame(current, frame, log) {
      leg = current;
      if (frame.method === 'initialize') initializeParams ??= frame.params;
      opened ??= bounded(new Promise((resolve, reject) => {
        const ws = new WebSocket(core.url, { headers: { Authorization: `Bearer ${core.token}` }, perMessageDeflate: false });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.on('message', (data) => {
          const value = JSON.parse(data.toString('utf8'));
          // A reveal injected below takes a seq of the app feed: the core's later frames are shifted past it, so the feed stays gap-free.
          if (value.feed?.id === 'app' && Number.isInteger(value.feed.seq)) {
            value.feed.seq += seqShift;
            appStamp = value.feed;
          }
          down = down.then(() => leg.toPhone(value)).then(() => log({ ev: 'core-frame' }));
        });
      }), "the phone's WebSocket to the core to open");
      if (process.env.DEBUG_FRAMES && /feed\/|terminal/.test(frame.method ?? '')) console.error('>>', JSON.stringify(frame).slice(0, 300));
      up = up.then(async () => {
        socket ??= await opened;
        socket.send(JSON.stringify(frame));
      });
    },
  };
  const world = await createPhoneWorld({ tree: decodeURIComponent(repo.pathname.slice(1)), dialect, paired: true, registration: 200 });

  const events = { activity: [], sizeOwner: [], folder: [], run: [], order: [], output: {} };
  const watchers = new Set();
  const changed = () => {
    for (const check of [...watchers]) check();
  };
  let rawCall;
  let rawFire;
  let probeHost;
  const probe = {
    group: 'scenario-probe',
    install: (host) => {
      rawCall = host.ctx.call;
      rawFire = host.ctx.fire;
      probeHost = host;
    },
  };
  const { adapter } = await import('./remote-protocol-terminal.ts');
  const { installPhoneShim } = await import('./remote-shim-boot.ts');
  installPhoneShim([adapter, probe]);
  const api = globalThis.window.mixdogDesktop;
  await world.waitFor((e) => e.ev === 'socket');
  await world.accept();

  const push = (kind) => (event) => {
    record(events, kind, event);
    changed();
  };
  const off = [];
  off.push(api.subscribeTermSizeOwner(push('sizeOwner')));
  off.push(api.onTerminalRunRequested(push('run')));
  const lanes = {
    terminal: () => [
      api.subscribeTermData((event) => {
        events.order.push({ push: 'termData', event: { id: event.id, data: event.data } });
        events.output[event.id] = (events.output[event.id] ?? '') + event.data;
        changed();
      }),
      api.subscribeTermActivity(push('activity')),
    ],
    files: () => [api.subscribeFolderChanges(push('folder'))],
  };
  const held = new Map();

  // The second connection of the size-claim cases: a client of its own on the same core, started with the phone's own initialize.
  let peer = null;
  let clock = null;
  const peerSend = (frame) => {
    peer ??= (async () => {
      const ws = new WebSocket(core.url, { headers: { Authorization: `Bearer ${core.token}` }, perMessageDeflate: false });
      await bounded(
        new Promise((resolve, reject) => {
          ws.once('error', reject);
          ws.on('message', (data) => {
            if (JSON.parse(data.toString('utf8')).id === 1) resolve();
          });
          ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: initializeParams })));
        }),
        "the second connection to open and the core to answer its initialize"
      );
      ws.send(JSON.stringify({ method: 'initialized' }));
      return ws;
    })();
    peer = peer.then((ws) => {
      if (frame) ws.send(JSON.stringify(frame));
      return ws;
    });
  };

  const driver = {
    call: (name, params) => rawCall(name, params),
    fire: (name, params, from) => {
      if (from !== 'other') return rawFire(name, params);
      // Node's termResize(id, cols, rows, phoneOwner) as the protocol frame the adapter sends for it.
      const [tabId, cols, rows] = params;
      peerSend({ method: 'terminal/resize', params: { tabId, cols, rows, claim: true } });
    },
    clock() {},
    // The core's manual lease clock (a debug build whose MIXDOG_TERMINAL_LEASE_CLOCK names this directory): time moves by exactly `ms`,
    // and the core answers on the same socket once every claim due by then has lapsed; that answer is what this waits for.
    async advance(ms) {
      clock ??= await openClock(core);
      const answer = new Promise((resolve) => clock.lines.once('line', resolve));
      clock.socket.write(`advance ${ms}\n`);
      const line = await bounded(answer, `the core did not acknowledge the lease clock step of ${ms} ms`);
      if (!/^lapsed \d+$/.test(line)) throw new Error(`the core refused the clock step: ${line}`);
    },
    close(who) {
      if (who === 'other') void peer?.then((ws) => ws.close());
    },
    lane(lane, on) {
      if (on) held.set(lane, lanes[lane]());
      else for (const stop of held.get(lane) ?? []) stop();
    },
    touch: (file) => writeFileSync(file, `${(touches += 1)}`),
    // The agent's reveal comes from the `terminal` tool of a running turn, which no model-free core run reaches: the frame the core
    // publishes for it (terminal_host.rs `AppFeedOpen::publish_open`, its params as that crate's test pins them) continues the app feed.
    run(request) {
      if (!appStamp) throw new Error('no app-feed frame to continue');
      seqShift += 1;
      appStamp = { ...appStamp, seq: appStamp.seq + 1 };
      const stamp = appStamp;
      down = down.then(() => leg.toPhone({ method: 'ui/openRequested', params: { kind: 'terminal', ...request }, feed: stamp }));
    },
    waitFor: (test, what) =>
      new Promise((resolve, reject) => {
        const timer = realSetTimeout(() => {
          watchers.delete(check);
          reject(new Error(`timed out after ${DEADLINE_MS} ms waiting for ${what}; state: ${JSON.stringify({ ...events, output: Object.fromEntries(Object.entries(events.output).map(([id, text]) => [id, text.slice(-300)])), tabs: probeHost.client().store.section('terminalTabs', null)?.value })}`));
        }, DEADLINE_MS);
        const check = () => {
          if (!test(events)) return;
          realClearTimeout(timer);
          watchers.delete(check);
          resolve();
        };
        watchers.add(check);
        check();
      }),
    events: () => events,
  };
  try {
    const trace = JSON.parse(JSON.stringify(await play(script, driver)));
    for (const list of Object.values(events)) if (Array.isArray(list)) list.length = 0;
    events.output = {};
    const claims = await play(sizeClaimScript(ROOT), driver);
    trace.claims = JSON.parse(JSON.stringify(claims));
    process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
  } finally {
    for (const stop of off) stop();
    void peer?.then((ws) => ws.close());
    clock?.socket.destroy();
  }
}

/** The core is ended whatever happens after it started: a setup that fails, a script that fails, a finished run. */
async function main() {
  // The recording's root is the core's working directory, so it is made before the core starts.
  const script = terminalScript(ROOT);
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [script.cwd, script.watched]) mkdirSync(dir, { recursive: true });
  const core = await startCore();
  let failed = false;
  try {
    await run(core);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A teardown that fails is reported unless the run already failed: its error is the one that explains.
    await stopCore(core).catch((error) => {
      if (!failed) throw error;
      console.error(error.message);
    });
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
