// Replay of native/core/fixtures/approval-grant-change-cases (record-approval-grant-change-cases.mjs, Node b6f10295a): an approval answer
// that remembers a grant announces the permissions change, from this PC's window and from a paired phone; one without a remembered
// grant, or one the host did not accept, announces nothing. The same steps the recorder ran, on the product's own modules; the answer
// and the operations issued are compared whole.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approvalGrantScenarios } from '../../../../benchmarks/rust-core/recorders/lib/approval-grant-scenarios.mjs';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-approval-grant-replay-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { DESKTOP_IPC } = await import('../shared/contract.ts');
const { registerSessionIpc } = await import('./ipc-sessions.ts');
const { registerDesktopIpc } = await import('./ipc.ts');
const { createRemoteMethods } = await import('./remote-methods.ts');
const { createDesktopOperations } = await import('./desktop-operations.ts');
const { createRelayPushLanes } = await import('./remote-relay-push-lanes.ts');
const { applyConnectorApproval } = await import('../../../../src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs');
const { setConnectorToolPermissionWriter } = await import('../../../../src/runtime/agent/orchestrator/mcp/agent-connectors.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/approval-grant-change-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = approvalGrantScenarios({ DESKTOP_IPC, registerSessionIpc, registerDesktopIpc, createRemoteMethods, createDesktopOperations, createRelayPushLanes, applyConnectorApproval, setConnectorToolPermissionWriter, dataDir });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
