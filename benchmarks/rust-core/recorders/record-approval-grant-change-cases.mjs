#!/usr/bin/env node
// Recording of apps/desktop/src/main/approval-grant-change.test.mjs (b6f10295a): an approval answer that remembers a grant announces the
// permissions change to every device, from this PC's window and from a paired phone; an answer without a remembered grant, or one the
// host did not accept, announces nothing. The real registerSessionIpc and createRemoteMethods with a scripted host; the operations the
// host was asked to run are recorded whole.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-approval-grant-change-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { approvalGrantScenarios } from './lib/approval-grant-scenarios.mjs';

REPLAY_TARGETS['approval-grant-change-cases'] = {
  protocolMethods: ['thread/approval/answer (mixdog-app-protocol/src/methods.rs:359): the core announces `ui/settings/changed` {scope: permissions} to every client once an answer that remembers a grant (agent/always) was taken and its reply queued (mixdog-core-session approval_notification.rs `answer_approval`, replayed by approval_notification_tests.rs, the audience by mixdog-app-server settings_change_feed.rs, the refused save by mixdog-agent tests policy_gate.rs); the desktop modules replay the same recording in apps/desktop/src/main/approval-grant-change-replay.test.mjs'],
  missing: [],
};
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-approval-grant-data-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('approval-grant-change-cases', import.meta.url);
const modules = {
  dataDir,
  ...(await set.load('apps/desktop/src/shared/contract.ts')),
  ...(await set.load('apps/desktop/src/main/ipc-sessions.ts')),
  ...(await set.load('apps/desktop/src/main/ipc.ts')),
  ...(await set.load('apps/desktop/src/main/remote-methods.ts')),
  ...(await set.load('apps/desktop/src/main/desktop-operations.ts')),
  ...(await set.load('apps/desktop/src/main/remote-relay-push-lanes.ts')),
  ...(await set.load('src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs')),
  ...(await set.load('src/runtime/agent/orchestrator/mcp/agent-connectors.mjs')),
};
try {
  for (const [name, scenario] of Object.entries(approvalGrantScenarios(modules))) await set.run(name, scenario);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

await set.finish({
  entry: { runs: 'registerSessionIpc (the window\'s resolveToolApprovalForSession channel) and createRemoteMethods (a paired phone\'s resolveToolApprovalForSession) over a scripted host', notRun: 'no real host or core: the scripted host answers accepted or not; the announced operations are the host\'s invokeDesktopOperation calls', hops: 'No wire in the Node test.' },
  replay: { entry: 'the desktop\'s approval answer (apps/desktop/src/main/approval-grant-change.ts through ipc-sessions.ts and remote-methods.ts): replay each case and compare the answer and the operations issued whole', normalised: {} },
});
process.exit(0);
