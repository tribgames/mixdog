#!/usr/bin/env node
// The desktop roster of Node's own host after each action of the roster scenario: threads made and named, a fork, a favorite, a
// read cursor, second turns, an archive, an unarchive, a re-archive, a delete, an agent's home spoken in, a room of two bots, and the
// deletion of one of those bots (its home retired, the bot gone from the room). `replay-roster-rows-live.mjs` drives a built mixdogd
// through the same actions and compares each step's `thread/list` and app-feed edges with these rosters.
//
// Node's own product runs unchanged from the exact export of b6f10295a: its daemon (`session-client.mjs` ensureDaemon) in an isolated
// environment with the real-turn harness's fake OpenAI-compatible provider, and its SessionHost (`session-host.ts`) attached to it.
// Each action ends when the host's own listing says it is settled; the listing is then the step's roster (`host.listSessions`, the
// desktop's sidebar catalog). Nothing waits on time: every wait is on a frame or a catalog publication under one deadline.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-tsx.mjs <repo>/benchmarks/rust-core/recorders/record-roster-steps.mjs \
//        --tree <tree> --harness <real-turn-harness dir> [--only <action>]
// --only records the actions up to and including the named one (each action builds on the ones before) into a file beside the
// run's environment folder, never the fixture.
// Output: native/core/fixtures/roster-steps/{steps.json,MANIFEST.json}
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const harness = args.get('harness');
if (!harness) throw new Error('--harness <real-turn-harness dir> is required (its lib files are pinned in the manifest)');
const identity = exactProductIdentity(tree, COMMIT);
const out = join(FIXTURES_ROOT, 'roster-steps');
const only = args.get('only');
const PINNED = ['env.mjs', 'deadline.mjs', 'fake-provider.mjs', 'scenarios.mjs'];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
const load = (path) => import(pathToFileURL(join(tree, path)).href);

export const ACTION_NAMES = ['created', 'turns', 'archive', 'unarchive', 'archive-again', 'delete', 'agent-home', 'room', 'agent-delete'];
if (only && !ACTION_NAMES.includes(only)) throw new Error(`--only ${only}: unknown action; known: ${ACTION_NAMES.join(', ')}`);

const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { createDeadline, latch } = await hload('deadline.mjs');
const { startFakeProvider } = await hload('fake-provider.mjs');
const sessionClient = await load('src/standalone/session-client.mjs');
const { createSessionProtocolClient } = await load('src/standalone/session-protocol.mjs');
const { createDesktopRuntime } = await load('src/standalone/daemon-desktop-runtime.mjs');

// In production the host runs inside the daemon and reaches it through the daemon-local bridge, which the daemon reads as revision 0
// (session-action.mjs:221): a read action such as `agentDefinitionPresence`, which the bot deletion asks, is accepted there. This
// recorder's client registers over TCP as revision 0 too, the one digit of its register body (session-client.mjs:577).
{
  const http = (await import('node:http')).default;
  const request = http.request;
  http.request = function (...rest) {
    const req = request.apply(this, rest);
    if (rest.find((a) => a && typeof a === 'object' && a.path)?.path === '/client/register') {
      const write = req.write;
      req.write = (chunk, ...more) => write.call(req, String(chunk).replace('"revision":6', '"revision":0'), ...more);
    }
    return req;
  };
}
process.execArgv = [];

const envRoot = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:\\mixdog-build\\tmp', 'roster-steps-'));
const paths = isolatedPaths(envRoot);
for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
const projects = { a: join(paths.workspace, 'a'), b: join(paths.workspace, 'b') };
for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
const deadline = createDeadline(300_000, () => 'node roster steps');
let provider = null;
let discovery = null;
let host = null;
let finished = false;
let recorded = null;
try {
  provider = await startFakeProvider({ workspace: paths.workspace });
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  const route = { provider: 'custom-harness', model: 'harness-model' };
  const isolated = daemonEnv(paths);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: paths.workspace, attempts: 2, readyTimeoutMs: 60_000 }), 'the Node daemon');
  const turnsDone = new Map();
  const waiters = new Set();
  const wake = () => waiters.forEach((check) => check());
  const hasTurnDone = (v) => (Array.isArray(v) ? v.some(hasTurnDone) : v && typeof v === 'object' ? v.kind === 'turndone' || Object.values(v).some(hasTurnDone) : false);
  const runtime = {
    ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
    attachSessionClient: async (options) => {
      const attached = await sessionClient.attachSession({
        discovery,
        cwd: paths.workspace,
        onFrame: (frame) => {
          if (frame?.sessionId && hasTurnDone(frame)) turnsDone.set(frame.sessionId, (turnsDone.get(frame.sessionId) || 0) + 1);
          options.onFrame(frame);
          wake();
        },
        onFatal: options.onFatal,
      });
      return createSessionProtocolClient({ call: (name, a, o) => attached.call(name, a, o), close: (reason) => attached.close(reason) });
    },
  };
  const { SessionHost } = await load('apps/desktop/src/main/session-host.ts');
  host = await SessionHost.create({ userDataPath: paths.appData, resourcesPath: paths.workspace, appPath: paths.workspace, packaged: false }, runtime);
  const until = (ready, what) => {
    const done = latch();
    const check = () => {
      if (ready()) {
        waiters.delete(check);
        done.resolve();
      }
    };
    waiters.add(check);
    check();
    return deadline.race(done.promise, what);
  };
  const nextEvent = (what) => {
    const done = latch();
    const check = () => {
      waiters.delete(check);
      done.resolve();
    };
    waiters.add(check);
    return deadline.race(done.promise, what);
  };
  host.subscribeSessions(() => wake());
  const listed = async () => plain(await deadline.race(host.listSessions(), 'the host listing'));
  async function settled(ok, what) {
    let rows = await listed();
    while (!ok(rows)) {
      await nextEvent(what);
      rows = await listed();
    }
  }
  const made = {};
  const turn = async (id, count, send) => {
    await send();
    await until(() => turnsDone.get(id) >= count, `the turn ${count} of ${id}`);
    await settled((rows) => {
      const row = rows.find((r) => r.id === id);
      return row && row.messageCount === count * 2 && row.activityAt === row.updatedAt;
    }, `the row of ${id}`);
  };
  const newTask = async (name, project) => {
    await host.startProject(projects[project]);
    const accepted = await deadline.race(host.submitNewTask(`hello ${name}`, { id: `sub-${name}` }, { projectPath: projects[project], route }), `the new task ${name}`);
    made[name] = accepted.sessionId;
    await turn(made[name], 1, async () => {});
  };
  const turns = {};
  const second = async (name) => {
    turns[name] = (turns[name] || 1) + 1;
    await turn(made[name], turns[name], () => host.submitToSession(made[name], `again ${name}`, { id: `sub-${name}-${turns[name]}` }));
  };
  const saveBot = async (name) => (await deadline.race(host.invokeCapability('saveAgentDefinition', [{ kind: 'bot', name, description: `${name} bot`, body: `You are ${name}.`, route }]), `saving ${name}`)).value.id;
  const ACTIONS = {
    created: async () => {
      for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
        await newTask(name, project);
        await host.renameSession(made[name], `Title ${name.slice(-1)}`);
      }
      made.sess_2 = (await deadline.race(host.inheritSession(made.sess_0, null), 'the fork')).sessionId;
      await host.renameSession(made.sess_2, 'Title 2');
      await host.setSessionFavorite(made.sess_2, true);
      await host.markSessionRead(made.sess_1, 0, true);
    },
    turns: async () => {
      for (const name of ['sess_1', 'sess_0']) await second(name);
    },
    archive: () => host.setSessionArchived(made.sess_3, true),
    unarchive: () => host.setSessionArchived(made.sess_3, false),
    'archive-again': () => host.setSessionArchived(made.sess_3, true),
    delete: async () => {
      await newTask('sess_5', 'a');
      await host.renameSession(made.sess_5, 'Title 5');
      await host.deleteSession(made.sess_5);
    },
    'agent-home': async () => {
      made.botOne = await saveBot('Bot One');
      made.botTwo = await saveBot('Bot Two');
      made.botOneHome = (await deadline.race(host.openAgentHome(made.botOne), 'the home')).sessionId;
      await turn(made.botOneHome, 1, () => host.submitToSession(made.botOneHome, 'hello Bot One', { id: 'sub-home' }));
    },
    room: async () => {
      const created = await deadline.race(host.agentRoomAction('create', [{ name: 'Room One', members: [made.botOne, made.botTwo] }]), 'the room');
      made.room = created.roomId;
      made.roomLog = created.sessionId;
    },
    // The host proves the deletion through `agentDefinitionPresence`, then archives and names the agent's home and drops the bot
    // from its rooms, after the delete's reply (`void retireAgentHomes`, session-host-lifecycle.ts:1171): the action ends when the
    // home row says it was retired and the room no longer names the bot.
    'agent-delete': async () => {
      await deadline.race(host.invokeCapability('deleteAgentDefinition', [made.botOne]), 'the bot deletion');
      await settled(
        (rows) => rows.find((row) => row.id === made.botOneHome)?.agentDeleted === true && !rows.find((row) => row.id === made.roomLog)?.agentRoom?.members.includes(made.botOne),
        "the deleted agent's home to be retired and the bot to leave its room"
      );
    },
  };
  const steps = [];
  for (const name of ACTION_NAMES) {
    await ACTIONS[name]();
    steps.push({ name, roster: await listed() });
    if (name === only) break;
  }
  const taskWorkspace = await deadline.race(host.taskWorkspace(), 'the task workspace');
  recorded = { made, projects, taskWorkspace, steps };
  finished = true;
} finally {
  deadline.clear();
  if (host) await host.dispose().catch(() => {});
  if (discovery) await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
  if (provider) await provider.close();
  if (!finished) console.error(`the recording failed; its environment is kept at ${envRoot}`);
  else {
    try {
      rmSync(envRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`the environment ${envRoot} could not be removed (${error.code}); remove it once its processes have ended`);
    }
  }
}

if (only) {
  writeFileSync(join(envRoot + '.only-' + only + '.json'), `${JSON.stringify(recorded, null, 2)}\n`);
  console.error(`wrote ${envRoot}.only-${only}.json`);
} else {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'steps.json'), `${JSON.stringify(recorded, null, 2)}\n`);
  const rel = 'benchmarks/rust-core/recorders/record-roster-steps.mjs';
  writeSetManifest(out, {
    set: 'roster-steps',
    recorder: rel,
    command: `(cwd <tree>/apps/desktop) node --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree> --harness <real-turn-harness dir>`,
    identity,
    extra: { exact: true, harness: Object.fromEntries(PINNED.map((n) => [`lib/${n}`, sha256(join(harness, 'lib', n))])), actions: ACTION_NAMES },
  });
}
console.error(`recorded ${recorded.steps.length} steps`);
process.exit(0);
