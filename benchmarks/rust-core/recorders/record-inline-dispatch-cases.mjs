#!/usr/bin/env node
// Records Node's inline host agent dispatch for the k1 UNTESTED case of
// src/standalone/session-runtime-inline-host.dispatch.test.mjs (gaps-tools.md row 88, :127): the test's own harness
// through Node's real `createInlineSessionRuntimeHost`. A dispatch without an id, a second dispatch under a running
// id, and the running one once its caller's signal aborts with "caller gave up"; each call's whole outcome (answer or
// error message).
//
//   node benchmarks/rust-core/recorders/record-inline-dispatch-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/inline-dispatch-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-inline-dispatch-cases.mjs';
const TEST = 'src/standalone/session-runtime-inline-host.dispatch.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { createInlineSessionRuntimeHost } = await importFrom(tree, 'src/standalone/session-runtime-inline-host.mjs');

const outcome = (promise) =>
  promise.then(
    (ok) => ({ ok }),
    (error) => ({ error: error instanceof Error ? error.message : String(error) })
  );

// The test's harness host (createHarness), for the call without an id.
const harness = createInlineSessionRuntimeHost({
  cwd: 'C:/work',
  loadLocalModule: async () => ({ async createLocalSessionRuntime() { return { getState: () => ({}), async dispose() {} }; } }),
  loadAgentGraph: async () => ({
    config: { loadConfig: () => ({ providers: { openai: { key: 'a' } } }) },
    registry: { initProviders: async () => {} },
    dispatch: { makeAgentDispatch: () => async (a) => `answer for ${a.prompt}` },
  }),
  warmKeychain: async () => {},
  executeAgentControl: async () => null,
});
const calls = [];
calls.push({ call: 'no id', payload: { agent: 'worker' }, outcome: await outcome(harness.agentDispatch({ agent: 'worker' })) });
await harness.close();

// The test's slow host: its agent graph waits on a gate.
const controller = new AbortController();
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const slow = createInlineSessionRuntimeHost({
  loadAgentGraph: async () => {
    await gate;
    return { config: { loadConfig: () => ({}) }, registry: { initProviders: async () => {} }, dispatch: {} };
  },
  warmKeychain: async () => {},
});
const running = outcome(slow.agentDispatch({ dispatchId: 'dup', agent: 'w', params: {} }, { signal: controller.signal }));
calls.push({ call: 'duplicate while running', payload: { dispatchId: 'dup', agent: 'w', params: {} }, outcome: await outcome(slow.agentDispatch({ dispatchId: 'dup', agent: 'w', params: {} })) });
controller.abort(new Error('caller gave up'));
release();
calls.push({ call: 'running, its caller aborted "caller gave up"', payload: { dispatchId: 'dup', agent: 'w', params: {} }, outcome: await running });
await slow.close();

const cases = [{ case: 'agentDispatch rejects a missing or already-running dispatch id and aborts with the caller signal', recorded: { calls } }];
const excluded = {
  'agentDispatch caches one dispatcher per agent and forwards the call parameters':
    'GONE (gaps-tools.md row 88): the lazily loaded JS agent graph and its per-config provider preparation',
  'agent graph loading retries after a failure and shares the successful graph': 'GONE (row 88): no lazily imported agent graph',
  'notifySessionCompletion routes to the runtime that owns the session, hinted or discovered': 'GONE (row 88): no in-process runtimes',
  'agentControl forwards to the injected executor and the placeholder actions stay inert': 'GONE (row 88): JS inline host placeholders',
};

const finalDir = join(FIXTURES_ROOT, 'inline-dispatch-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's inline host agent dispatch at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'inline-dispatch-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "per call: the whole outcome, the dispatch's answer or its error message",
    gate: "the slow host's wait (Node: loading the agent graph) is the core's provider preparation, the step before the dispatcher",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`inline-dispatch-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
for (const c of calls) console.log(JSON.stringify(c));
process.exit(0);
