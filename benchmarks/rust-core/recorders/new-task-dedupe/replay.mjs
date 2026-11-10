// The replay of the new-task scenarios (scenarios.mjs) against a built `mixdogd` (built with `--features crash-gates`): the client is the
// desktop's own service lane (apps/desktop/src/main/protocol/service-route.ts: `submitNewTask` becomes `thread/start`) over a protocol
// connection, so the request is the one the app sends. Every step's reply, receipt files and the sessions with a prompt are compared
// whole, in order, with what Node gave (golden.json). A crash step ends the core at its gate (MIXDOG_NEW_TASK_CRASH_AT) and starts it
// again over the same data directory.
//
// Compared as Node's recording states them: a reply is `{ok, accepted, sessionId}` or `{ok:false, error}` (the core answers the new
// session in `thread.id`; the snapshot Node returns travels on the thread's feed); the receipt files are compared byte for byte; the
// sessions are those holding a prompt, with the number of prompts. Fresh addresses are numbered `<fresh:N>` by first appearance.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from '../lib/common.mjs';
import { killTree, startCore } from '../lib/phone-files-replay.mjs';
import { CONTENTS, CORRUPT } from './scenarios.mjs';

// A connection that is dropped on purpose (the core ended at a gate, or was stopped) ends the client's reconnect ladder with this error, which nobody awaits.
process.on('unhandledRejection', (error) => {
  if (error?.message !== 'the replay dropped its connection') throw error;
});

/** The cores' data directories (a database each, about 50 MB, removed when its scenario ends) live in the slot, on the idle SSD: after a core's database is killed the next start fsyncs the whole data directory before it recovers, and on the shared build disk that outlasts the core's 30 s start deadline. */
const WORLDS = join(REPO_ROOT, '.replay-new-task-dedupe');
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const sha = async (text) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex');

/** Every descendant of `pid` now (the core's database, for one): a crash of the core leaves them running. */
function descendants(pid) {
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  const rows = JSON.parse(listed.stdout);
  const found = [];
  const walk = (parent) => {
    for (const row of rows) if (row.ParentProcessId === parent && !found.includes(row.ProcessId)) {
      found.push(row.ProcessId);
      walk(row.ProcessId);
    }
  };
  walk(pid);
  return found;
}

/** The core's database after the core: still running, or killed with a core that was ended at a gate (the core's own quit stops it). A killed postmaster leaves its pid file
 *  and is recovered by the next start only after a fsync of the whole data directory, which does not end within the core's 30 s start deadline here: the recovery is done
 *  here (a start with a long wait, then a stop), as a machine's reboot would do it before the core starts. */
function databaseEnded(dataDir) {
  const pidFile = join(dataDir, 'pgdata', 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  const bin = join(dataDir, 'runtime', readdirSync(join(dataDir, 'runtime')).find((name) => name.startsWith('runtime-pg')), 'bin', 'pg_ctl.exe');
  const pgdata = join(dataDir, 'pgdata');
  const [pid, , , port] = readFileSync(pidFile, 'utf8').split('\n').map((line) => line.trim());
  const running = spawnSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`]).status === 0;
  if (!running) {
    // On Windows `pg_ctl start -w` takes a pid file whose start time is within 2 s of its own start as the new server's, ready: the dead one's file would end its wait at once
    // and the stop below would find no server, leaving the recovering one to hold the data directory against the core. The dead server's file is removed first.
    rmSync(pidFile);
    const started = spawnSync(bin, ['start', '-D', pgdata, '-w', '-t', '600', '-o', `-p ${port}`], { stdio: 'ignore' });
    if (started.status !== 0) throw new Error(`recovering the killed core's database failed: pg_ctl start exited ${started.status}`);
  }
  const stopped = spawnSync(bin, ['stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '600'], { stdio: 'ignore' });
  if (stopped.status !== 0) throw new Error(`stopping the core's database failed: pg_ctl stop exited ${stopped.status}`);
}
/** The port of the core's database, which the core keeps in its data directory and takes again at its next start. */
const databasePort = (dataDir) => {
  try {
    return Number(readFileSync(join(dataDir, 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[3]);
  } catch {
    return null;
  }
};

/** Other runs on this PC start databases on the ports above the ones held for the replay; while a core is down its database port is held here, so the next start finds it free. */
async function holdPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`the stopped core's database port ${port} is not free: ${error.message}`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => server.close();
}

/** The core is stopped as its own quit stops it, and ended with its database; the returned function frees the database's port for the next start. */
async function stopCore(exe, core) {
  const port = databasePort(core.dataDir);
  const exited = new Promise((resolve) => core.child.once('exit', resolve));
  spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop'], { env: core.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await exited;
  databaseEnded(core.dataDir);
  return port ? holdPort(port) : () => {};
}
const differences = (a, b, path = '') => {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path];
};

/** One scenario's connection: the service lane over a client of the core. */
async function connectLane(core) {
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const { createServiceLane } = await here('apps/desktop/src/main/protocol/service-route.ts');
  const client = await connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => core.endpoint),
    clientInfo: { name: 'mixdog-replay', title: 'Mixdog Replay', version: '1.4.5', kind: 'desktop' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    // The client sleeps only on its reconnect ladder, after a dropped transport: a core that ended at its gate fails the call.
    clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
    random: Math.random,
  });
  const lane = createServiceLane({ protocol: { call: (method, params) => client.call(method, params), notify() {} }, snapshot: () => null });
  return { client, lane };
}

const reply = async (lane, { id, content }) => {
  const { prompt, options, draft } = CONTENTS[content];
  try {
    const result = await lane.call('submitNewTask', [prompt, { ...options, id }, structuredClone(draft)]);
    return { ok: true, accepted: true, sessionId: result.thread.id };
  } catch (error) {
    return { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { code: error.code } : {}) };
  }
};

/** The sessions the core lists that carry a prompt, with how many prompts, read as a client reads them (`thread/list`, `thread/items/list`). */
async function prompted(client) {
  const listed = await client.call('thread/list', {});
  const out = {};
  for (const { id } of listed.data) {
    const items = await client.call('thread/items/list', { threadId: id });
    const users = items.data.filter((item) => item.type === 'userMessage').length;
    if (users > 0) out[id] = users;
  }
  return out;
}

/** Resolves once `file` exists: a watch on the receipts' user-data folder, registered before the first look, wakes the look; the wait fails with a message after `ms`. */
async function untilExists(root, file, ms) {
  mkdirSync(root, { recursive: true });
  let stirred = false;
  let failure = null;
  let wake = null;
  const stir = (error) => {
    failure ??= error ?? null;
    stirred = true;
    wake?.();
  };
  const watcher = watch(root, { recursive: true }, () => stir());
  const deadline = setTimeout(() => stir(new Error(`${file} was not written within ${ms} ms: the first request of the step never held its id`)), ms);
  try {
    for (;;) {
      stirred = false;
      if (existsSync(file)) return;
      if (failure) throw failure;
      if (!stirred) await new Promise((resolve) => (wake = resolve));
    }
  } finally {
    clearTimeout(deadline);
    watcher.close();
  }
}
const receiptsOf = (dataDir) => {
  const dir = join(dataDir, 'userdata', 'new-task-receipts');
  try {
    return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString('latin1')]));
  } catch {
    return null;
  }
};

async function replayScenario({ exe, scenario, numberFresh }) {
  const coreRoot = join(WORLDS, scenario.name);
  rmSync(coreRoot, { recursive: true, force: true });
  let core = await startCore(exe, coreRoot, null, true);
  let session = await connectLane(core);
  const survivors = [];
  const got = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      let answer = null;
      if (step.op === 'submit') answer = await reply(session.lane, step);
      else if (step.op === 'together') {
        // Node's two calls start in order within one process. Over a connection their arrival at the core is not ordered, so a request that differs in content is sent once the first one holds its id (its receipt is on disk).
        const calls = [];
        for (const call of step.calls) {
          if (calls.length && call.content !== step.calls[0].content) {
            await untilExists(join(core.dataDir, 'userdata'), join(core.dataDir, 'userdata', 'new-task-receipts', `${await sha(call.id)}.json`), 30_000);
          }
          calls.push(reply(session.lane, call));
        }
        answer = await Promise.all(calls);
      }
      else if (step.op === 'seed' || step.op === 'obstruct') {
        const dir = join(core.dataDir, 'userdata', 'new-task-receipts');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${await sha(step.id)}.json`);
        if (step.op === 'seed') writeFileSync(file, CORRUPT[step.shape]);
        else mkdirSync(file, { recursive: true });
      } else if (step.op === 'crash') {
        // The core ends itself at the gate; whatever it started stays up, and is ended here with the core's recorded tree.
        await endAndRestart({ exe, coreRoot, session, core, at: step.at }, step, async (next) => {
          core = next.core;
          session = next.session;
        }, survivors, scenario);
        answer = { crashed: step.at };
      } else if (step.op === 'restart') {
        session.client.close?.();
        (await stopCore(exe, core))();
        core = await startCore(exe, coreRoot, null, false);
        session = await connectLane(core);
      }
      got.push({ reply: answer, receipts: receiptsOf(core.dataDir), prompted: await prompted(session.client) });
    }
  } finally {
    session.client.close?.();
    // The next scenario's database takes the first free port; this one's must have let go of its own.
    if (core.child.exitCode === null) await stopCore(exe, core).then((free) => free(), () => {});
    killTree(core.child);
    if (core.child.exitCode === null) await new Promise((resolve) => core.child.once('exit', resolve));
    for (const pid of survivors) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  }
  return numberFresh(scenario, got);
}

/** The crash step: the core's descendants are noted, a core is started with the gate, the step's request is sent and the core ends. */
async function endAndRestart({ exe, coreRoot, session, core, at }, step, adopt, survivors) {
  session.client.close?.();
  (await stopCore(exe, core))();
  const gated = await startCore(exe, coreRoot, null, false, { MIXDOG_NEW_TASK_CRASH_AT: at });
  const connection = await connectLane(gated);
  const tree = descendants(gated.child.pid);
  survivors.push(...tree);
  const exited = new Promise((resolve) => gated.child.once('exit', resolve));
  try {
    // The call of a core that ends never settles (the client's ladder gives up unawaited): the core's exit is the answer.
    const lost = await Promise.race([reply(connection.lane, step), exited.then(() => ({ exited: true }))]);
    if (lost.ok) throw new Error(`the core answered a request that was to end it at ${at}`);
    // The call fails as the connection drops, which can come before the exit is seen.
    let timer;
    await Promise.race([
      exited,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the core did not end at its ${at} gate within 60 s; the call ended with ${JSON.stringify(lost)}`)), 60_000))),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    killTree(gated.child);
    throw error;
  }
  databaseEnded(core.dataDir);
  const core2 = await startCore(exe, coreRoot, null, false);
  adopt({ core: core2, session: await connectLane(core2) });
}

const nodeSide = (recorded) => recorded.map((step) => ({
  reply: step.reply,
  receipts: step.receipts,
  prompted: Object.fromEntries(Object.entries(step.sessions).filter(([, entry]) => entry.prompts > 0).map(([id, entry]) => [id, entry.prompts])),
}));

/** The core's memory database takes the first free port from 55432 and keeps it in its data directory; other runs on this PC start and end their own databases on those ports, so a
 *  restart over the same data directory could find its port taken or another one free. The ports the product scans first are held here for the whole replay, so the core's port is above them and stays. */
async function holdPorts() {
  const held = [];
  for (let port = 55432; port <= 55600; port += 1) {
    const server = net.createServer();
    const bound = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) held.push(server);
  }
  return () => held.forEach((server) => server.close());
}

export async function replayNewTaskDedupe({ exe, scenarios, golden, numberFresh }) {
  let failed = 0;
  const release = await holdPorts();
  mkdirSync(WORLDS, { recursive: true });
  try {
    for (const scenario of scenarios) {
      const expected = nodeSide(golden[scenario.name].recorded);
      const got = await replayScenario({ exe, scenario, numberFresh });
      const unexpected = [];
      expected.forEach((node, index) => {
        const paths = differences(node, got[index]);
        if (paths.length) unexpected.push({ index, step: scenario.steps[index], paths, node, core: got[index] });
      });
      if (got.length !== expected.length) unexpected.push({ index: 'count', paths: ['length'], node: expected.length, core: got.length });
      console.log(`${scenario.name}: ${expected.length} steps compared, ${unexpected.length} unexpected`);
      for (const entry of unexpected) {
        failed += 1;
        console.log(`  DIFF step ${entry.index} ${JSON.stringify(entry.step ?? '')} at ${entry.paths.join(', ')}`);
        console.log(`    node: ${JSON.stringify(entry.node).slice(0, 700)}`);
        console.log(`    core: ${JSON.stringify(entry.core).slice(0, 700)}`);
      }
    }
  } catch (error) {
    console.log(error.stack);
    failed += 1;
  } finally {
    release();
    if (existsSync(WORLDS)) rmSync(WORLDS, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}
