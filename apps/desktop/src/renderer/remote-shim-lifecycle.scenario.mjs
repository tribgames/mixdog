// One lifecycle scenario against the phone's protocol-client shim, in its own process (the shim keeps module-level state): the
// same script and world the Node recorder used (benchmarks/rust-core/recorders), the core's end speaking the protocol.
// Prints the trace on a marker line; remote-shim-lifecycle.test.mjs compares it with the recording.
import { readFileSync } from 'node:fs';
import { createPhoneWorld, protocolDialect } from '../../../../benchmarks/rust-core/recorders/lib/phone-world.mjs';
import { SCENARIOS, play } from '../../../../benchmarks/rust-core/recorders/lib/phone-scenarios.mjs';

async function main() {
const name = process.argv[2];
const ops = SCENARIOS[name];
const repo = new URL('../../../../', import.meta.url);
const options = JSON.parse(readFileSync(new URL('packages/protocol-client/conformance/options.json', repo), 'utf8'));
const version = JSON.parse(readFileSync(new URL('apps/desktop/package.json', repo), 'utf8')).version;
const initializeResult = { ...options.initializeResult, serverVersion: version };

const world = await createPhoneWorld({
  tree: decodeURIComponent(repo.pathname.slice(1)),
  dialect: protocolDialect(initializeResult),
  paired: ops[0].paired ?? true,
  registration: ops[0].registration ?? 200,
  mxt: ops[0].mxt ?? false,
});
const { VISUALIZE_PANELS_EVENT } = await import('../shared/visualize.ts');
// What PH-2's group adapters will do, minimally: one call that stays pending (the script's in-flight call) and the terminal lane.
const adapter = {
  group: 'lifecycle-test',
  calls: { deleteSession: (_params, host) => host.client().call('feed/subscribe', { feedId: 'pending-call' }) },
  install: (host) => void host.declareLane('terminal', ['terminal']),
};
const driver = {
  visualizePanelsEvent: VISUALIZE_PANELS_EVENT,
  boot: async () => {
    const { installPhoneShim } = await import('./remote-shim-boot.ts');
    installPhoneShim([adapter]);
  },
  api: () => globalThis.window.mixdogDesktop,
};
const trace = await play(world, driver, ops);
process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
}
// Not awaited at the top level: the test runner's hook treats a force-exit during top-level evaluation as a failure.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);