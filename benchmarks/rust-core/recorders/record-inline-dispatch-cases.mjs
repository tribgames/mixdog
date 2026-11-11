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

// The test's harness host for the forwarding case: each call's answer and what its dispatcher was handed.
{
  const handed = [];
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:/work',
    loadLocalModule: async () => ({ async createLocalSessionRuntime() { return { getState: () => ({}), async dispose() {} }; } }),
    loadAgentGraph: async () => ({
      config: { loadConfig: () => ({ providers: { openai: { key: 'a' } } }) },
      registry: { initProviders: async () => {} },
      dispatch: {
        makeAgentDispatch: () => async (a) => {
          handed.push({
            prompt: a.prompt,
            preset: a.preset ?? null,
            cwd: a.cwd ?? null,
            idleTimeoutMs: 'idleTimeoutMs' in a ? a.idleTimeoutMs : null,
            parentSignal: a.parentSignal instanceof AbortSignal,
          });
          return `answer for ${a.prompt}`;
        },
      },
    }),
    warmKeychain: async () => {},
    executeAgentControl: async () => null,
  });
  const payloads = [
    { dispatchId: 'd1', agent: 'worker', params: { prompt: 'hello', preset: 'p1', cwd: 'D:/proj', idleTimeoutMs: 5000 } },
    { dispatchId: 'd2', agent: 'worker', params: { prompt: 'again', idleTimeoutMs: -1 } },
  ];
  const forwarded = [];
  for (const payload of payloads) forwarded.push({ payload, outcome: await outcome(host.agentDispatch(payload)) });
  await host.close();
  cases.push({ case: 'agentDispatch caches one dispatcher per agent and forwards the call parameters', recorded: { calls: forwarded, handed } });
}

// The test's failing-then-working graph: each dispatch's whole outcome.
{
  let loads = 0;
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {},
    loadAgentGraph: async () => {
      loads += 1;
      if (loads === 1) throw new Error('graph import failed');
      return {
        config: { loadConfig: () => ({}) },
        registry: { initProviders: async () => {} },
        dispatch: { makeAgentDispatch: () => async ({ prompt }) => `answer for ${prompt}` },
      };
    },
  });
  const retried = [];
  for (const payload of [
    { dispatchId: 'failed', agent: 'worker' },
    { dispatchId: 'retried', agent: 'worker', params: { prompt: 'retried' } },
    { dispatchId: 'cached', agent: 'worker', params: { prompt: 'cached' } },
  ]) {
    retried.push({ payload, outcome: await outcome(host.agentDispatch(payload)) });
  }
  await host.close();
  cases.push({ case: 'agent graph loading retries after a failure and shares the successful graph', recorded: { calls: retried } });
}

// The test's harness for completion routing: runtimes that record each completion delivered to them. Each call's
// answer, in the test's order (hinted, discovered and missing owners, a disposed runtime's owner, and every owner once
// the host is closed), and the completions the runtimes received.
{
  const delivered = [];
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:/work',
    loadLocalModule: async () => ({
      async createLocalSessionRuntime(options = {}) {
        const state = { sessionId: options.sessionId || null };
        return {
          getState: () => state,
          setSessionId: (id) => {
            state.sessionId = id;
          },
          deliverToolCompletion(sessionId, text, meta) {
            delivered.push([sessionId, text, meta]);
            return true;
          },
          async dispose() {},
        };
      },
    }),
    loadAgentGraph: async () => ({ config: { loadConfig: () => ({}) }, registry: { initProviders: async () => {} }, dispatch: {} }),
    warmKeychain: async () => {},
  });
  const hinted = await host.create({ sessionId: 'sess_hint' });
  const discovered = await host.create({});
  discovered.setSessionId('sess_found');
  const notify = (call, owner, text, meta) => ({ call, owner, text, meta, answer: host.notifySessionCompletion(owner, text, meta) });
  const answers = [
    notify('hinted owner', 'sess_hint', 'done', { kind: 'task' }),
    notify('discovered owner', 'sess_found', 'done 2', {}),
    notify('missing owner', 'sess_missing', 'x', {}),
  ];
  await hinted.dispose('bye');
  answers.push(notify('owner whose runtime was disposed', 'sess_hint', 'late', {}));
  await host.close('test over');
  answers.push(notify('after the host closed', 'sess_found', 'after close', {}));
  cases.push({ case: 'notifySessionCompletion routes to the runtime that owns the session, hinted or discovered', recorded: { answers, delivered } });
}

const excluded = {
  'agentDispatch caches one dispatcher per agent and forwards the call parameters: the factory options and the dispatcher cache':
    "not reachable by a client: the one caller of the host's agentDispatch is the memory-cycle broker " +
    '(src/standalone/daemon.mjs:1059), whose payload never names factory options beyond taskType/sourceType/brief ' +
    '(src/standalone/agent-dispatch-broker.mjs:105), so `options.preset` never reaches makeAgentDispatch; the per-agent ' +
    'dispatcher cache and the once-per-config provider preparation have no effect beyond the answers and forwarded ' +
    'parameters replayed here',
  'agent graph loading retries after a failure and shares the successful graph: the load count':
    "not observable: the graph is a lazy `import()` inside the host (session-runtime-inline-host/agent-dispatch.mjs); a " +
    'client sees each dispatch\'s outcome, replayed here, and the core has no module to import',
  'notifySessionCompletion routes to the runtime that owns the session, hinted or discovered: the runtime counts':
    "`status.worker.runtimes` and `workloads.worker.runtimes` (session-runtime-inline-host.dispatch.test.mjs:159-165) count the " +
    "host's in-process JS runtimes (session-runtime-inline-host.mjs:108-118), which the core, one daemon for every session, has no counterpart of",
  'notifySessionCompletion routes to the runtime that owns the session, hinted or discovered: the disposed runtime':
    "Node answers false once the owner's runtime is disposed (session-runtime-inline-host.mjs:91-94, `records.ownerRuntime`); the core has no " +
    "disposal of a loaded thread's runtime, and its `OwnerNotify` answers `live` for any loaded handle (core-session agent_registry/flow.rs, `notify`), so the " +
    'same call answers true there: open, not replayed',
  'notifySessionCompletion routes to the runtime that owns the session, hinted or discovered: the host closed':
    "the answer after `host.close()` (session-runtime-inline-host.mjs:91-93, `if (closed) return false`) is the host's own lifetime; the core's " +
    'directory closes only with the daemon, whose shutdown is not a call a client makes',
  'agentControl forwards to the injected executor and the placeholder actions stay inert':
    "not reachable by a client: agentControl only forwards to the daemon's canonical agent control (src/standalone/daemon.mjs:1122 " +
    '`executeAgentControl: agentControl.execute`), whose answers the agent tool replays cover; agentSessionAction, ' +
    'agentSessionState, subscribeAgentSessionStates and refreshRuntimeWorkload have no caller outside the host ' +
    '(session-runtime-inline-host.mjs:96-100; no other reference in src/), and the unavailable/closed refusals need a host ' +
    'built without the executor or used after close, which daemon.mjs never does',
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
