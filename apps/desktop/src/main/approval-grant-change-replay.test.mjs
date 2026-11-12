// Replay of native/core/fixtures/approval-grant-change-cases (record-approval-grant-change-cases.mjs, Node b6f10295a): an approval answer
// that remembers a grant announces the permissions change, from this PC's window and from a paired phone; one without a remembered
// grant, or one the host did not accept, announces nothing. The same steps the recorder ran, on the product's own modules; the answer
// and the operations issued are compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { approvalGrantScenarios } from '../../../../benchmarks/rust-core/recorders/lib/approval-grant-scenarios.mjs';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/approval-grant-change-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = approvalGrantScenarios({ DESKTOP_IPC, registerSessionIpc, createRemoteMethods });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
