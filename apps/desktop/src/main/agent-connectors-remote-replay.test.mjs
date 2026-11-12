// Replay of native/core/fixtures/agent-connectors-remote-cases (record-agent-connectors-remote-cases.mjs, Node b6f10295a): the connector
// capability tables, and the call a paired phone and the window's IPC send the host, on the product's own modules, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { agentConnectorScenarios } from '../../../../benchmarks/rust-core/recorders/lib/agent-connectors-scenarios.mjs';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import * as contract from '../shared/contract.ts';
import * as validation from './ipc-validation.ts';
import * as remote from './remote-methods.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/agent-connectors-remote-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = agentConnectorScenarios({ ...contract, ...validation, ...remote, SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
