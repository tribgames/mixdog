// The replay of the session-send cases (cases.mjs) against a built `mixdogd`: the same driver (`runSteps`) and the same model endpoint
// (`createModel`) as Node's recording, over the desktop's own service lane (apps/desktop/src/main/protocol/service-route.ts) on a protocol
// connection to the core. A kill ends the core's process tree; a quit is the core's own stop (`mixdogd ctl stop`).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../lib/common.mjs';
import { answered, killTree, startCore } from '../lib/phone-files-replay.mjs';
import { withJob } from '../lib/process-job.mjs';
import { holdPorts, stopCore } from '../new-task-dedupe/replay.mjs';
import { CASES, caseRoot, createModel, eachAtOnce, prepareData, runSteps, within } from './cases.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

// A core's database takes the first port nothing answers on (memory/pg/cluster.rs `free_port`): two cores starting at once could both
// take one port, so the cases running at once start their cores one after another. Each case runs in a process of its own (the core
// helpers wait synchronously, which would hold every other case's model endpoint), so the turn to start is handed out by the parent's
// start gate (`MIXDOG_REPLAY_START_GATE`, a port): a connection is answered `go` when its turn comes, and its close ends the turn.
const oneStartAtATime = async (start) => {
  const socket = net.connect(Number(process.env.MIXDOG_REPLAY_START_GATE), '127.0.0.1');
  try {
    await answered(
      'the turn to start a core',
      new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('the start gate closed before this case had its turn')));
      }),
    );
    return await start();
  } finally {
    socket.destroy();
  }
};

/** The parent's start gate: one connection holds the turn until it closes, the next waits in arrival order. */
async function startGate() {
  const waiting = [];
  let holder = null;
  const next = () => {
    if (holder || !waiting.length) return;
    holder = waiting.shift();
    holder.write('go\n');
  };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('close', () => {
      const at = waiting.indexOf(socket);
      if (at >= 0) waiting.splice(at, 1);
      if (holder === socket) holder = null;
      next();
    });
    waiting.push(socket);
    next();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The core's side of a case's driver: the desktop's service lane over a protocol client, the thread folds kept as the window keeps them. */
function coreApp(exe, coreRoot, model) {
  let core = null;
  let client = null;
  let lane = null;
  let capabilities = null;
  let releasePort = () => {};
  const folds = new Map();
  const shown = [];
  const cores = [];
  let desktopState = null;
  let reducer = null;
  const connectApp = async () => {
    const { connect, sessionReducer, desktopSessionState } = await here('packages/protocol-client/src/index.ts');
    desktopState = (fold) => desktopSessionState(fold, [], undefined);
    reducer = sessionReducer;
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const { createCapabilityLane } = await here('apps/desktop/src/main/protocol/capability-route.ts');
    const { createServiceLane } = await here('apps/desktop/src/main/protocol/service-route.ts');
    const keep = (state) => {
      if (state?.sessionId) {
        folds.set(state.sessionId, state);
        shown.push({ sessionId: state.sessionId, snapshot: state });
        model.stir();
      }
      return state;
    };
    client = await answered('the connection (initialize)', connect({
      target: { id: 'core' },
      connector: createWsConnector(async () => core.endpoint),
      clientInfo: { name: 'mixdog-replay', title: 'Mixdog Replay', version: '1.4.5', kind: 'desktop' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: { initial: (snapshot) => keep(sessionReducer.initial(snapshot)), apply: (state, notification) => keep(sessionReducer.apply(state, notification)) },
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    }));
    lane = createServiceLane({ protocol: { call: (method, params) => client.call(method, params), notify() {} }, snapshot: () => null });
    // DesktopServiceClient on a core connection sends `deleteSession`, `setSessionArchived` and the approval answers to its capability lane.
    capabilities = createCapabilityLane({
      protocol: {
        call: (method, params) => client.call(method, params),
        snapshot: () => null,
        noteUserInput() {},
        respond: (id, answer) => client.respond(id, answer),
        pendingServerRequests: () => client.pendingServerRequests(),
      },
    });
  };
  const call = (method, args) => lane.call(method, args);
  return {
    side: 'core',
    // Node's `app.getPath('userData')` is the core's `<data>/userdata` (the unclassified workspace lies under it).
    userData: join(coreRoot, 'data', 'userdata'),
    async open() {
      releasePort();
      core = await oneStartAtATime(() => startCore(exe, coreRoot, null, false, {}));
      cores.push(core);
      folds.clear();
      await connectApp();
    },
    async quit() {
      client.close?.();
      releasePort = await stopCore(exe, core);
    },
    async kill() {
      client.close?.();
      await killTree(core.child);
    },
    openHome: async (agentId) => (await call('openAgentHome', [agentId])).sessionId,
    newTask: async (prompt, id) => {
      const answer = await call('submitNewTask', [prompt, { displayText: prompt, id }, { route: { provider: 'custom-harness', model: 'harness-model' } }]);
      return answer.sessionId ?? answer.thread?.id;
    },
    say: (sessionId, prompt, options = {}) => call('submitToSession', [sessionId, prompt, { displayText: prompt, ...options }]),
    // Node's `setVisibleSessions`: the sessions a window shows; one that is gone is left out.
    async watch(ids) {
      for (const id of ids) {
        try {
          await answered(`thread/resume of ${id}`, client.resumeThread(id, { lastItems: 50 }));
        } catch (error) {
          if (error?.code !== 'threadNotFound') throw error;
        }
      }
      return true;
    },
    busy: (sessionId) => (folds.has(sessionId) ? desktopState(folds.get(sessionId)).busy === true : false),
    snapshot: (sessionId) => (folds.has(sessionId) ? desktopState(folds.get(sessionId)) : null),
    read: async (sessionId) => desktopState(reducer.initial(await call('readSessionTranscript', [sessionId]))),
    abort: (sessionId) => call('abortSession', [sessionId, {}]),
    remove: (sessionId) => capabilities.deleteSession(sessionId),
    archive: (sessionId, archived) => capabilities.setSessionArchived(sessionId, archived),
    approve: (sessionId, id, decision) => capabilities.resolveToolApproval(sessionId, id, decision),
    room: (action, args) => call('agentRoomAction', [action, args]),
    shown,
    async close() {
      client?.close?.();
      for (const each of cores) await killTree(each.child).catch(() => {});
      releasePort();
    },
  };
}

export async function replayCase(exe, c) {
  const model = createModel(c);
  const server = http.createServer((req, res) => model.serve(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const coreRoot = join(caseRoot(c), 'core');
  rmSync(coreRoot, { recursive: true, force: true });
  prepareData(join(coreRoot, 'data'), `http://127.0.0.1:${server.address().port}/v1`, c);
  const app = coreApp(exe, coreRoot, model);
  try {
    return { recorded: await runSteps(c, app, model), trace: model.trace };
  } catch (error) {
    error.requests = model.requests;
    // Written before the cleanup below, which a failed core can hold up: the case's stderr names the failure either way.
    process.stderr.write(`${c.name} failed: ${error?.stack ?? error}\nshown: ${JSON.stringify(error?.shown ?? null)}\n`);
    throw error;
  } finally {
    await within(180_000, app.close(), `${c.name}: ending its cores`);
    server.close();
    server.closeAllConnections();
  }
}

const CASE_DEADLINE_MS = 600_000;

/** Every case, `jobs` at once, each in its own process (this file run as a script), every process it starts ended with its job. */
export async function replayAll({ exe, cases, jobs }) {
  const release = await holdPorts();
  const gate = await startGate();
  try {
    const out = {};
    await eachAtOnce(cases, jobs, async (c) => {
      const file = join(caseRoot(c), 'core-run.json');
      rmSync(file, { force: true });
      const env = { ...process.env, MIXDOG_REPLAY_START_GATE: String(gate.port) };
      const done = await withJob(c.name, (job) => job.run(c.name, process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), exe, c.name, file], { cwd: process.cwd(), env, ms: CASE_DEADLINE_MS }));
      writeFileSync(join(caseRoot(c), 'core-run.stderr.txt'), done.stderr);
      let result = null;
      try {
        result = JSON.parse(readFileSync(file, 'utf8'));
      } catch {}
      if (done.timedOut) result = { failure: `not done within ${CASE_DEADLINE_MS} ms (ended with the ${done.left} process(es) of its job)`, requests: null };
      else if (!result) result = { failure: `exit ${done.code} without a result:\n${done.stderr.slice(-4000)}`, requests: null };
      else if (done.left && !result.failure) result = { failure: `${done.left} process(es) outlived the case (ended with its job)`, requests: null };
      out[c.name] = result;
    });
    return out;
  } finally {
    await gate.close();
    release();
  }
}

// One case: `node --import tsx replay.mjs <mixdogd.exe> <case name> <out file>`.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [exe, name, file] = process.argv.slice(2);
  const c = CASES.find((each) => each.name === name);
  let result;
  try {
    result = await replayCase(exe, c);
  } catch (error) {
    result = { failure: String(error?.stack ?? error), requests: error?.requests ?? null };
  }
  writeFileSync(file, JSON.stringify(result));
  process.exit(0);
}
