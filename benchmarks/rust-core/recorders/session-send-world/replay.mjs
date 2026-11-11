// The replay of the session-send cases (cases.mjs) against a built `mixdogd`: the same driver (`runSteps`) and the same model endpoint
// (`createModel`) as Node's recording, over the desktop's own service lane (apps/desktop/src/main/protocol/service-route.ts) on a protocol
// connection to the core. A kill ends the core's process tree; a quit is the core's own stop (`mixdogd ctl stop`).
import { rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../lib/common.mjs';
import { answered, killTree, startCore } from '../lib/phone-files-replay.mjs';
import { holdPorts, stopCore } from '../new-task-dedupe/replay.mjs';
import { caseRoot, createModel, eachAtOnce, prepareData, runSteps } from './cases.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

// A core's database takes the first port nothing answers on (memory/pg/cluster.rs `free_port`): two cores starting at once could both
// take one port, so the cases running at once start their cores one after another.
let starting = Promise.resolve();
const oneStartAtATime = (start) => {
  const started = starting.then(start);
  starting = started.catch(() => {});
  return started;
};

/** The core's side of a case's driver: the desktop's service lane over a protocol client, the thread folds kept as the window keeps them. */
function coreApp(exe, coreRoot, model) {
  let core = null;
  let client = null;
  let lane = null;
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
  };
  const call = (method, args) => lane.call(method, args);
  return {
    side: 'core',
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
    remove: (sessionId) => call('deleteSession', [sessionId]),
    archive: (sessionId, archived) => call('setSessionArchived', [sessionId, archived]),
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
    throw error;
  } finally {
    await app.close();
    server.close();
    server.closeAllConnections();
  }
}

export async function replayAll({ exe, cases, jobs }) {
  const release = await holdPorts();
  try {
    const out = {};
    await eachAtOnce(cases, jobs, async (c) => {
      try {
        out[c.name] = await replayCase(exe, c);
      } catch (error) {
        out[c.name] = { failure: String(error?.stack ?? error), requests: error?.requests ?? null };
      }
    });
    return out;
  } finally {
    release();
  }
}
