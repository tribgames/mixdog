#!/usr/bin/env node
// The phone's connection lifecycle at the Node baseline: the relay web app's shim (`remote-shim.ts` and the modules it installs) driven
// over a fake relay socket with a real E2EE handshake and a virtual timer queue, through the scenarios in lib/phone-scenarios.mjs.
// The trace of each scenario is what the user and the core can tell apart (see that file), and is what apps/mobile's replay test
// requires of the protocol client.
//
//   node benchmarks/rust-core/recorders/record-phone-lifecycle.mjs --tree <git archive of b6f10295a with node_modules>
//
// Each scenario runs in its own process: the shim keeps module-level state (boot reads, the connection timeline) that a second boot
// in the same process would inherit.
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { createPhoneWorld, nodeDialect } from './lib/phone-world.mjs';
import { SCENARIOS, play } from './lib/phone-scenarios.mjs';
import { ORACLE_SCENARIOS, oracleDialect, playOracle } from './lib/transport-oracle.mjs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);

if (args.has('oracle')) {
  // The MXT transport oracle at Node: the shim's socket and liveness modules alone on a context (credentials, the socket attempt, the transport
  // peer, the page lifecycle), with the collaborators the rest of the shim would supply stubbed -- see lib/transport-oracle.mjs.
  const world = await createPhoneWorld({ tree, dialect: oracleDialect, mxt: true, installed: false });
  const State = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-state.ts');
  const { installRemotePairing } = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-pairing.ts');
  const { installRemoteLiveness } = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-liveness.ts');
  const { installRemoteSocket } = await importFrom(tree, 'apps/desktop/src/renderer/remote-shim-socket.ts');
  const driver = {
    ctx: null,
    boot: async () => {
      const ctx = State.createRemoteShimContext();
      driver.ctx = ctx;
      installRemotePairing(ctx);
      installRemoteLiveness(ctx);
      installRemoteSocket(ctx);
      Object.assign(ctx, {
        ensureClientRegistration: async () => {},
        // What the page receives (the app's dispatch), and the app-level reports the oracle's script does not drive.
        handleMessage: (message) => world.log({ ev: 'deliver', frame: message }),
        fire: () => {},
        createTransportMedia: () => ({ receive: () => false, close() {} }),
      });
      globalThis.window.addEventListener(State.REMOTE_SECURE_CHANNEL_READY_EVENT, () => world.log({ ev: 'ready' }));
      void ctx.connect();
    },
    send: (payload) => void driver.ctx.transport.send(payload),
  };
  const trace = await playOracle(world, driver, ORACLE_SCENARIOS[args.get('oracle')]);
  process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
  process.exit(0);
}

if (args.has('scenario')) {
  const name = args.get('scenario');
  const ops = SCENARIOS[name];
  const boot = ops[0];
  const world = await createPhoneWorld({
    tree,
    dialect: nodeDialect,
    paired: boot.paired ?? true,
    registration: boot.registration ?? 200,
    mxt: boot.mxt ?? false,
  });
  const { VISUALIZE_PANELS_EVENT } = await importFrom(tree, 'apps/desktop/src/shared/visualize.ts');
  const driver = {
    visualizePanelsEvent: VISUALIZE_PANELS_EVENT,
    boot: async () => {
      await importFrom(tree, 'apps/desktop/src/renderer/remote-shim.ts');
    },
    api: () => globalThis.window.mixdogDesktop,
  };
  const trace = await play(world, driver, ops);
  process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
  process.exit(0);
}

const runChild = (flag, name) => {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'test-env.mjs')).href,
      '--import',
      pathToFileURL(join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'test-tsx.mjs')).href,
      fileURLToPath(import.meta.url),
      '--tree',
      tree,
      `--${flag}`,
      name,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  if (child.status !== 0 || at < 0) throw new Error(`${flag} ${name} failed (${child.status}):\n${child.stdout.slice(-2000)}\n${child.stderr.slice(-4000)}`);
  return JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
};
const recorded = {};
for (const name of Object.keys(SCENARIOS)) {
  recorded[name] = runChild('scenario', name);
  console.log(`${name}: ${recorded[name].length} checkpoints`);
}
const transport = {};
for (const name of Object.keys(ORACLE_SCENARIOS)) {
  transport[name] = runChild('oracle', name);
  console.log(`${name}: ${transport[name].length} events`);
}

// Next to the replay test that consumes it (apps/mobile), not under native/.
const finalOut = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-lifecycle');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'Node relay web app (remote-shim*) lifecycle traces: per scenario, per checkpoint, the connection indicator states, outage transitions, sockets closed or pinged (virtual ms since the previous checkpoint), what the core knows of the phone, and how pending calls ended.',
  scenarios: recorded,
});
writeJson(join(out, 'transport.json'), {
  note: 'Node MXT transport oracle: per scenario, the whole ordered trace of what the connector put on the wire and handed to the page (decoded controls, records, cleartext pings, sockets) under a scripted stimulus, with virtual times. See benchmarks/rust-core/recorders/lib/transport-oracle.mjs.',
  scenarios: transport,
});
writeSetManifest(out, {
  set: 'phone-lifecycle',
  recorder: 'benchmarks/rust-core/recorders/record-phone-lifecycle.mjs',
  command: `node benchmarks/rust-core/recorders/record-phone-lifecycle.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { scenarios: Object.keys(recorded).length },
});
commitStage(out, finalOut);
console.log(`phone-lifecycle: ${Object.keys(recorded).length} scenarios`);
