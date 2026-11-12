#!/usr/bin/env node
// Recording of apps/desktop/src/main/agent-connectors-remote.test.mjs (b6f10295a): every per-agent connector method is a desktop
// capability, a remote capability and a session action, and a paired phone sends the host the same validated call the desktop's IPC
// does (the phone's plus the host's no-widen mark on an authority setter); a wrong argument count is refused before the host.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-agent-connectors-remote-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { agentConnectorScenarios } from './lib/agent-connectors-scenarios.mjs';

REPLAY_TARGETS['agent-connectors-remote-cases'] = {
  protocolMethods: ['agent/getAgentConnectors', 'agent/getAgentConnectorTools', 'agent/setAgentConnectors', 'agent/setAgentConnectorEnabled', 'agent/setAgentConnectorToolPermission', 'project/getProjectConnectors', 'project/setProjectConnectorEnabled', 'connector/listConnectorTools'],
  missing: ['`listConnectors`: the inventory (mixdog-app-protocol/src/inventory.rs) lists it as Deleted (caller-less action, DS 17.1), so it has no method in protocol 2'],
};
const set = openSet('agent-connectors-remote-cases', import.meta.url);
const modules = {
  ...(await set.load('apps/desktop/src/shared/contract.ts')),
  ...(await set.load('apps/desktop/src/main/ipc-validation.ts')),
  ...(await set.load('apps/desktop/src/main/remote-methods.ts')),
  ...(await set.load('src/standalone/session-protocol.mjs')),
};
for (const [name, scenario] of Object.entries(agentConnectorScenarios(modules))) await set.run(name, scenario);

await set.finish({
  entry: { runs: 'DESKTOP_CAPABILITIES / DESKTOP_READ_CAPABILITIES (shared/contract.ts), requiredDesktopCapabilityRequest / requiredDesktopCapabilityReadRequests (ipc-validation.ts), assertRemoteCapability and createRemoteMethods (remote-methods.ts), SESSION_READ_ACTIONS / SESSION_CONFIGURE_ACTIONS (src/standalone/session-protocol.mjs)', notRun: 'a scripted host records the calls it is handed; no real session or connector', hops: 'No wire in the Node test.' },
  replay: { entry: 'the desktop connector capability tables and the phone and window routes to the host: replay each case on the product modules and compare whole; the protocol-2 methods carrying them are listed in protocolMethods', normalised: {} },
});
process.exit(0);
