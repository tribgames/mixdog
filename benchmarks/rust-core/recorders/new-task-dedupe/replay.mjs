// The replay of the new-task scenarios (scenarios.mjs) against a built `mixdogd` (built with `--features crash-gates`): the client is the
// desktop's own service lane (apps/desktop/src/main/protocol/service-route.ts: `submitNewTask` becomes `thread/start`) over a protocol
// connection, so the request is the one the app sends. Every step's reply, receipt files and the sessions with a prompt are compared
// whole, in order, with what Node gave (golden.json). A crash step ends the core at its gate (MIXDOG_NEW_TASK_CRASH_AT) and starts it
// again over the same data directory.
//
// Compared as the fixture's manifest declares (scenarios.mjs COMPARISON): each recorded step whole, by subtraction; a reply as the caller
// received it, the core's answer translated (`thread.id` is `sessionId`) less the paths declared without a Node counterpart; the receipt
// files byte for byte; the sessions with their prompts. Fresh addresses are numbered `<fresh:N>` by first appearance.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from '../lib/common.mjs';
import { answered, exitWithin, killTree, NoAnswer, startCore } from '../lib/phone-files-replay.mjs';
import { asReceived, COMPARISON, CONTENTS, CORRUPT } from './scenarios.mjs';

// A connection that is dropped on purpose (the core ended at a gate, or was stopped) ends the client's reconnect ladder with this error, which nobody awaits.
process.on('unhandledRejection', (error) => {
  if (error?.message !== 'the replay dropped its connection') throw error;
});

/** The cores' data directories (a database each, about 50 MB, removed when its scenario ends) live in the slot, on the idle SSD: after a core's database is killed the next start fsyncs the whole data directory before it recovers, and on the shared build disk that outlasts the core's 30 s start deadline. */
const WORLDS = join(REPO_ROOT, '.replay-new-task-dedupe');
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const sha = async (text) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex');

/** A synchronous child with one deadline: a child that cannot start or outlives `ms` (and is then ended) is an error naming `what`. The children run here start no
 *  process of their own that outlives them, except `pg_ctl start`, whose server is ended by its caller on failure. */
function runSync(what, command, args, ms, options = {}) {
  const result = spawnSync(command, args, { ...options, timeout: ms, windowsHide: true });
  if (result.error) throw new Error(`${what} did not finish within ${ms} ms: ${result.error.message}`);
  return result;
}


/** Every descendant of `pid` now (the core's database, for one): a crash of the core leaves them running. */
function descendants(pid) {
  const listed = runSync('listing the processes', 'powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], 60_000, { encoding: 'utf8' });
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
  const running = runSync(`looking for the database's process ${pid}`, 'powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`], 60_000).status === 0;
  // pg_ctl's own `-t 600` bounds its wait; the child's deadline is above it.
  const stop = (mode) => runSync(`pg_ctl stop -m ${mode}`, bin, ['stop', '-D', pgdata, '-m', mode, '-w', '-t', '600'], 660_000, { stdio: 'ignore' });
  if (!running) {
    // On Windows `pg_ctl start -w` takes a pid file whose start time is within 2 s of its own start as the new server's, ready: the dead one's file would end its wait at once
    // and the stop below would find no server, leaving the recovering one to hold the data directory against the core. The dead server's file is removed first.
    rmSync(pidFile);
    let started;
    try {
      started = runSync("recovering the killed core's database (pg_ctl start)", bin, ['start', '-D', pgdata, '-w', '-t', '600', '-o', `-p ${port}`], 660_000, { stdio: 'ignore' });
    } finally {
      if (started?.status !== 0) stop('immediate');
    }
    if (started.status !== 0) throw new Error(`recovering the killed core's database failed: pg_ctl start exited ${started.status}`);
  }
  const stopped = stop('fast');
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
  const exited = exitWithin(core.child, 120_000, 'the core asked to stop');
  try {
    runSync('mixdogd ctl stop', exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop'], 60_000, { env: core.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await exited;
  } catch (error) {
    await killTree(core.child).catch((ending) => {
      error.message += `\nand ending it failed: ${ending.message}`;
    });
    throw error;
  }
  databaseEnded(core.dataDir);
  return port ? holdPort(port) : () => {};
}
/** The core quit with work in flight, as the app's quit stops it: the wind-down is asked for (`--when-idle`), which reports the drain and
 *  its confirmation token while the held request keeps it busy, then confirmed (`--abort` with that token); the core ends with its database. */
async function quitCore(exe, core) {
  const port = databasePort(core.dataDir);
  const exited = exitWithin(core.child, 120_000, 'the core asked to quit');
  const ctl = (args) => runSync(`mixdogd ctl stop ${args.join(' ')}`, exe, ['ctl', 'stop', ...args, '--reason', 'quit'], 60_000, { env: core.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const asked = ctl(['--when-idle']);
    if (asked.status !== 0) throw new Error(`mixdogd ctl stop --when-idle failed (exit ${asked.status}): ${asked.stdout}${asked.stderr}`);
    await exited;
  } catch (error) {
    await killTree(core.child).catch((ending) => {
      error.message += `\nand ending it failed: ${ending.message}`;
    });
    throw error;
  }
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
  const client = await answered('the connection (initialize)', connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => core.endpoint),
    clientInfo: { name: 'mixdog-replay', title: 'Mixdog Replay', version: '1.4.5', kind: 'desktop' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    // The client sleeps only on its reconnect ladder, after a dropped transport: a core that ended at its gate fails the call.
    clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
    random: Math.random,
  }));
  const lane = createServiceLane({ protocol: { call: (method, params) => client.call(method, params), notify() {} }, snapshot: () => null });
  return { client, lane };
}

const reply = async (lane, { id, content }) => {
  const { prompt, options, draft } = CONTENTS[content];
  try {
    return asReceived.answer(await answered('submitNewTask (thread/start)', lane.call('submitNewTask', [prompt, { ...options, id }, structuredClone(draft)])));
  } catch (error) {
    if (error instanceof NoAnswer) throw error;
    return asReceived.rejection(error);
  }
};

/** Every session the core holds, with its prompts and whether it is still only reserved: the translation of Node's daemon model
 *  (COMPARISON.translated). The listing leaves out an untitled session with no message (Node's `isLeadVisibleRow`), which is what a
 *  reservation is, so the sessions are the core's stored ones (a folder each under `<data>/sessions`), each read as a client reads it
 *  (`thread/items/list`); one the core answers `threadNotFound` for (deleted, not yet purged) is not there. */
async function sessionsOf(client, dataDir) {
  let stored = [];
  try {
    stored = readdirSync(join(dataDir, 'sessions'));
  } catch {}
  const out = {};
  for (const id of stored) {
    let items;
    try {
      items = await answered(`thread/items/list of ${id}`, client.call('thread/items/list', { threadId: id }));
    } catch (error) {
      if (error.code === 'threadNotFound') continue;
      throw new Error(`thread/items/list of stored session ${id}: ${error.message} (${JSON.stringify({ code: error.code, data: error.data })})`);
    }
    const prompts = items.data.filter((item) => item.type === 'userMessage').length;
    out[id] = { prompts, reserved: prompts === 0 };
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
  // Every core this scenario starts is owned from the moment `startCore` hands it over (until then `startCore` ends it on its own
  // failure), and every connection from the moment it is opened: the cleanup below ends them all, whatever failed.
  const cores = [];
  const connections = [];
  const own = async (env, fresh = false) => {
    // The world lives inside this checkout: git looks no higher than the worlds' folder, so a task's folder is no repository, as Node's is.
    const started = await startCore(exe, coreRoot, null, fresh, { GIT_CEILING_DIRECTORIES: WORLDS, ...env });
    cores.push(started);
    return started;
  };
  const connect = async (target) => {
    const opened = await connectLane(target);
    connections.push(opened);
    return opened;
  };
  const survivors = [];
  const got = [];
  let core = null;
  let failed = null;
  try {
    core = await own({}, true);
    let session = await connect(core);
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
        session.client.close?.();
        (await stopCore(exe, core))();
        await endAtGate({ core: await own({ MIXDOG_NEW_TASK_CRASH_AT: step.at }), connect, step, survivors });
        core = await own({});
        session = await connect(core);
        answer = { crashed: step.at };
      } else if (step.op === 'quit') {
        session.client.close?.();
        (await stopCore(exe, core))();
        core = await own({ MIXDOG_NEW_TASK_QUIT_AT: step.at });
        await quitAtGate({ exe, core, connect, step });
        core = await own({});
        session = await connect(core);
        answer = { quit: step.at };
      } else if (step.op === 'restart') {
        session.client.close?.();
        (await stopCore(exe, core))();
        core = await own({});
        session = await connect(core);
      }
      got.push({ step, reply: answer, receipts: receiptsOf(core.dataDir), sessions: await sessionsOf(session.client, core.dataDir) });
    }
  } catch (error) {
    failed = error;
  }
  // Every owned core, connection and survivor is ended whatever ended before it; each failure is kept and all are reported.
  const cleanup = [];
  const end = async (what, step) => {
    try {
      await step();
    } catch (error) {
      cleanup.push(`${what}: ${error.message}`);
    }
  };
  for (const opened of connections) await end('closing a connection', () => opened.client.close?.());
  // The next scenario's database takes the first free port; this one's must have let go of its own.
  if (core && core.child.exitCode === null) await end('stopping the last core', async () => (await stopCore(exe, core))());
  for (const started of cores) {
    await end(`ending the core pid ${started.child.pid}`, () => killTree(started.child));
  }
  // A pid already gone is no error here.
  for (const pid of survivors) await end(`ending the crashed core's process ${pid}`, () => runSync(`taskkill of the crashed core's process ${pid}`, 'taskkill', ['/F', '/PID', String(pid)], 60_000, { stdio: 'ignore' }));
  if (failed) {
    if (cleanup.length) failed.message += `\nand its cleanup failed:\n  ${cleanup.join('\n  ')}`;
    throw failed;
  }
  if (cleanup.length) throw new Error(`the cleanup of ${scenario.name} failed:\n  ${cleanup.join('\n  ')}`);
  return numberFresh(scenario, got);
}

/** The crash step on a core started with the gate: its descendants are noted, the step's request is sent and the core ends at the gate.
 *  One deadline, armed before the request is sent, covers both the request and the core's exit. Its database is then recovered. */
async function endAtGate({ core, connect, step, survivors }) {
  const at = step.at;
  let lost = null;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the core did not end at its ${at} gate within 60 s; the call ${lost ? `ended with ${JSON.stringify(lost)}` : 'was still open'}`)), 60_000);
  });
  // Bounded by `deadline`, with which it is always raced.
  const exited = core.child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => core.child.once('exit', resolve));
  try {
    const connection = await Promise.race([connect(core), deadline]);
    survivors.push(...descendants(core.child.pid));
    // The call of a core that ends never settles (the client's ladder gives up unawaited): the core's exit is the answer.
    lost = await Promise.race([reply(connection.lane, step), exited.then(() => ({ exited: true })), deadline]);
    if (lost.ok) throw new Error(`the core answered a request that was to end it at ${at}`);
    // The call fails as the connection drops, which can come before the exit is seen.
    await Promise.race([exited, deadline]);
  } finally {
    clearTimeout(timer);
  }
  databaseEnded(core.dataDir);
}

/** The quit step on a core started with its hold (MIXDOG_NEW_TASK_QUIT_AT): the step's request is sent, the core says on stderr that the
 *  attempt is held inside the call `at`, and the core is then quit with the call in flight (`quitCore`).
 *  One deadline, armed before the request is sent, covers the hold. The call must end unanswered: nobody receives a quit's reply. */
async function quitAtGate({ exe, core, connect, step }) {
  const at = step.at;
  const marker = `new-task held at ${at}`;
  let timer;
  let onData;
  let onExit;
  const held = new Promise((resolve, reject) => {
    let seen = '';
    onData = (chunk) => {
      seen += chunk;
      if (seen.includes(marker)) resolve();
    };
    onExit = (code) => reject(new Error(`the core exited ${code} before its attempt was held at ${at}`));
    timer = setTimeout(() => reject(new Error(`the core's attempt was not held at ${at} within 60 s`)), 60_000);
    core.child.stderr.on('data', onData);
    core.child.once('exit', onExit);
  });
  let answer = null;
  let lost;
  let connection;
  try {
    connection = await Promise.race([connect(core), held.then(() => new Promise(() => {}))]);
    lost = reply(connection.lane, step).then(
      (got) => (answer = got),
      (error) => (answer = { failed: error.message }),
    );
    await held;
  } finally {
    clearTimeout(timer);
    core.child.stderr.off('data', onData);
    core.child.off('exit', onExit);
  }
  if (answer?.ok) throw new Error(`the core answered a request held at ${at}: ${JSON.stringify(answer)}`);
  // The quit detaches the callers first (index.ts:1662-1664), then stops the core.
  connection.client.close?.();
  let said = '';
  const hear = (chunk) => (said += chunk);
  core.child.stderr.on('data', hear);
  try {
    (await quitCore(exe, core))();
  } catch (error) {
    let log = '';
    try {
      log = readFileSync(join(core.dataDir, 'daemon.log'), 'utf8');
    } catch {}
    error.message += `\nthe core's stderr since the hold:\n${said.slice(-6000)}\nits daemon.log:\n${log.slice(-8000)}`;
    throw error;
  } finally {
    core.child.stderr.off('data', hear);
  }
  // The connection dropped with the core: the call ends without an answer (a rejection of the dropped transport, never an answer).
  await lost;
  if (answer?.ok) throw new Error(`the core answered the request held at ${at} at its quit: ${JSON.stringify(answer)}`);
}

/** Removes `path` (dot-separated) from `value`, applying to every element of an array on the way (a `together` step's replies). */
const without = (value, [key, ...rest]) => {
  if (Array.isArray(value)) return value.forEach((element) => without(element, [key, ...rest]));
  if (!value || typeof value !== 'object' || !(key in value)) return;
  if (rest.length) without(value[key], rest);
  else delete value[key];
};
const paths = (declared, prefix) => Object.keys(declared).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('.'));

/** A recorded step less the paths the manifest declares not compared (COMPARISON.notCompared), nothing else. */
const nodeSide = (recorded) =>
  recorded.map((step) => {
    const copy = structuredClone(step);
    for (const path of paths(COMPARISON.notCompared, 'recorded[].')) without(copy, path);
    return copy;
  });

/** One answer of the core in the recording's terms (COMPARISON.translated `recorded[].reply`): `thread.id` is `sessionId`, an answer is `accepted`, and the paths of
 *  `coreNotCompared` are left out; whatever else the core answered stays and is compared (a `thread` that keeps a field not declared stays too). The translation only
 *  adds what the phone's adapter derives: a field the core's answer already carries is the core's, as received, and is compared as it came (as `asReceived` lets
 *  every received field stand over the one it would set). */
export const translatedAnswer = (answer) => {
  if (!answer || answer.ok !== true || !('thread' in answer)) return answer;
  const copy = structuredClone(answer);
  for (const path of paths(COMPARISON.coreNotCompared, 'reply.')) without(copy, path);
  const { id, ...rest } = copy.thread ?? {};
  if (Object.keys(rest).length) copy.thread = rest;
  else delete copy.thread;
  return { accepted: true, sessionId: id, ...copy };
};
const coreSide = (got) => got.map((step) => ({ ...step, reply: Array.isArray(step.reply) ? step.reply.map(translatedAnswer) : translatedAnswer(step.reply) }));

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
  // The comparison applied is the one the fixture's manifest declares.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'native', 'core', 'fixtures', 'new-task-dedupe', 'MANIFEST.json'), 'utf8'));
  if (!isDeepStrictEqual(manifest.comparison, COMPARISON)) throw new Error('the manifest declares another comparison than scenarios.mjs COMPARISON: record the fixture again');
  const release = await holdPorts();
  mkdirSync(WORLDS, { recursive: true });
  try {
    for (const scenario of scenarios) {
      const expected = nodeSide(golden[scenario.name].recorded);
      const got = coreSide(await replayScenario({ exe, scenario, numberFresh }));
      const unexpected = [];
      // The recording ran the steps the replay drives.
      if (!isDeepStrictEqual(golden[scenario.name].steps, scenario.steps)) unexpected.push({ index: 'steps', paths: ['steps'], node: golden[scenario.name].steps, core: scenario.steps });
      expected.forEach((node, index) => {
        const paths = differences(node, got[index]);
        if (paths.length) unexpected.push({ index, step: scenario.steps[index], paths, node, core: got[index] });
      });
      if (got.length !== expected.length) unexpected.push({ index: 'count', paths: ['length'], node: expected.length, core: got.length });
      console.log(`${scenario.name}: ${expected.length} steps compared, ${unexpected.length} unexpected`);
      for (const entry of unexpected) {
        failed += 1;
        console.log(`  DIFF step ${entry.index} ${JSON.stringify(entry.step ?? '')} at ${entry.paths.join(', ')}`);
        console.log(`    node: ${JSON.stringify(entry.node).slice(0, 4000)}`);
        console.log(`    core: ${JSON.stringify(entry.core).slice(0, 4000)}`);
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
