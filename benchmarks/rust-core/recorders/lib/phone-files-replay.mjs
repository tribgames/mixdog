// The replay of lib/phone-files-script.mjs: the phone's adapter (apps/desktop/src/renderer/remote-protocol-files.ts) against a freshly
// started, built mixdogd, every answer compared whole with what Node gave (apps/mobile/fixtures/phone-files/golden.json). A stand-in
// window (a second connection that claims the host role) answers the OS trash, the snapshot and the local page as the script scripts it.
//
// The main scenario runs here, on the loopback connection every client of this core has. The relay scenario (what only a paired phone
// meets: the registered-projects rule and one-file permissions) needs a relay-origin connection, which only the relay leg opens: the
// workspace crate replays it (mixdog-workspace/tests/it/phone_files.rs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { FIXED_NOW_MS, filesRelayScript, filesScript, play, treeOf, windowAnswers } from './phone-files-script.mjs';
import { startRelay } from './phone-relay-core.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

/** What the relay declares to the core's desktop leg (the settings replay's relay declares the same, less native push). */
const RELAY_CAPABILITIES = { textFrames: 1, maxFrameBytes: 1048576 };

function differences(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => differences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path];
}

async function startCore(exe, coreRoot, relay) {
  rmSync(coreRoot, { recursive: true, force: true });
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(coreRoot, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(coreRoot, 'runtime'),
    MIXDOG_DATA_DIR: join(coreRoot, 'data'),
    MIXDOG_HOME: join(coreRoot, 'home'),
    MIXDOG_CONFIG_DIR: join(coreRoot, 'config'),
    MIXDOG_FIXED_NOW_MS: String(FIXED_NOW_MS),
    ...(relay ? { MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}` } : {}),
  });
  // An install that has used remote access before: the core dials its relay at start.
  if (relay) writeFileSync(join(coreRoot, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  // The install layout: the manifest beside the binary names the JS runtime (a build output has none of its own).
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const file = join(coreRoot, 'runtime', 'daemon.json');
  for (let waited = 0; waited < 400_000; waited += 100) {
    if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
    try {
      return { child, endpoint: parseDiscovery(readFileSync(file, 'utf8')), dataDir: join(coreRoot, 'data') };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error(`mixdogd did not serve in 400 s:\n${stderr}`);
}

/** The PC's window: a second connection that claims the host role and answers what the core asks of it. */
async function openWindow(connect, base) {
  const asked = [];
  const client = await connect({
    ...base,
    clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
    capabilities: {
      optOutNotificationMethods: [],
      experimentalApi: false,
      host: { browser: false, visualize: false, notifications: false, systemProxy: false, power: false, media: false, updater: false, files: true },
    },
  });
  const served = {
    'host/capture/fileSnapshot': (p) => ['captureFileSnapshot', [p.root, p.rel, p.grant === true]],
    'host/localPage/url': (p) => ['localPageUrl', [p.root, p.rel, p.scope === 'file' ? 'file' : 'project']],
    'host/files/trashItem': (p) => ['trashItem', [p.path]],
  };
  client.on((event) => {
    if (event.type !== 'serverRequest') return;
    const { id, method, params } = event.request;
    const entry = served[method]?.(params ?? {});
    if (!entry) return client.respond(id, { error: { code: -32601, message: `${method} is not served` } });
    const [name, args] = entry;
    asked.push({ method: name, args: clone(args) });
    try {
      // The real window answers the trash with `{}` (apps/desktop/src/main/host/files.ts), never with nothing.
      client.respond(id, { result: windowAnswers[name](...args) ?? {} });
    } catch (error) {
      client.respond(id, { error: { code: -32000, message: error.message } });
    }
  });
  await client.call('host/claim', { hostId: 'replay-window' });
  return { client, asked };
}

const PHONE_ID = '0123456789abcdef0123456789abcdef';

/** One scenario on a freshly started core; `relay` makes the phone a paired device behind a relay the core dials (what a relay-origin
 *  connection is), otherwise the phone is the loopback connection every client of this core has. */
async function replayScenario({ exe, world, name, make, expected, relay }) {
  const coreRoot = `${world.root}-core-${name}`;
  const core = await startCore(exe, coreRoot, relay);
  const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const base = {
    target: { id: 'core' },
    connector: createWsConnector(async () => core.endpoint),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    clock: { sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
    random: Math.random,
  };
  let phoneConnector = base.connector;
  if (relay) {
    await relay.leg();
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    phoneConnector = await relay.openPhone('client-files', PHONE_ID, relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8'))));
  }
  const client = await connect({ ...base, connector: phoneConnector });
  const host = { ctx: relay ? { browserId: PHONE_ID } : {}, client: () => client, declareLane() {} };
  let window = null;
  let compared = 0;

  world.build();
  const scenario = make(world);
  const driver = {
    async call(name, params) {
      window?.asked.splice(0);
      let frame;
      try {
        const value = await adapter.calls[name](params, host);
        frame = { ok: true, value: value === undefined ? null : clone(value) };
      } catch (error) {
        frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
      }
      return { frame, hostCalls: window ? window.asked.splice(0) : [] };
    },
    // The one-file permission a paired phone holds for a path outside every project (`transfer/grant/mint`, relay origin).
    grant: async (path) => (await client.call('transfer/grant/mint', { path })).accessToken,
    host: async (on) => {
      if (on && !window) window = await openWindow(connect, base);
      if (!on && window) {
        window.client.close?.();
        window = null;
      }
    },
    pin: (path, ms) => utimesSync(path, ms / 1000, ms / 1000),
    write: (path, text) => writeFileSync(path, text),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  };
  const trace = await play(scenario, driver);
  const unexpected = [];
  if (trace.steps.length !== expected.steps.length) unexpected.push({ step: 'count', node: expected.steps.length, core: trace.steps.length });
  expected.steps.forEach((node, index) => {
    const core = trace.steps[index];
    compared += 1;
    if (differences(node, core).length) unexpected.push({ index, call: node.call, params: node.params, node, core });
  });
  const tree = treeOf(world.root);
  if (!isDeepStrictEqual(tree, expected.finalTree)) unexpected.push({ step: 'finalTree', paths: differences(expected.finalTree, tree), node: expected.finalTree, core: tree });

  client.close?.();
  window?.client.close?.();
  const { execFileSync } = await import('node:child_process');
  execFileSync('taskkill', ['/T', '/F', '/PID', String(core.child.pid)], { stdio: 'ignore' });
  relay?.close();
  console.log(`phone-files ${name} replay over ${exe}: ${compared} compared, ${unexpected.length} unexpected`);
  const show = (value) => JSON.stringify(value?.frame ?? value).slice(0, 360);
  for (const entry of unexpected) {
    console.log(`DIFF #${entry.index ?? entry.step} ${entry.call ?? ''} ${JSON.stringify(entry.params ?? entry.paths ?? '').slice(0, 160)}`);
    console.log(`   node: ${show(entry.node)}`);
    console.log(`   core: ${show(entry.core)}`);
  }
  return unexpected.length ? 1 : 0;
}

export async function replayFiles({ exe, world, golden }) {
  const main = await replayScenario({ exe, world, name: 'main', make: filesScript, expected: golden.scenarios.main });
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: RELAY_CAPABILITIES });
  const paired = await replayScenario({ exe, world, name: 'relay', make: filesRelayScript, expected: golden.scenarios.relay, relay });
  return main || paired;
}