#!/usr/bin/env node
// The order in which Node's host (b6f10295a) started and finished the calls of different feature groups that one phone connection
// sent, recorded from an exact export: the relay's own call dispatch (`createRelayClientCallDispatch`, remote-relay-client-calls.ts)
// on the connection's own call queue (`createRemoteCallQueue`, remote-call-queue.ts), over a method table whose handlers only note
// their start and end and wait for the script. The script is lib/phone-order-script.mjs; per scenario the recording holds the events
// in order and each call's answer frame.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-order.mjs --tree <git archive of b6f10295a with node_modules>
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { orderCalls, orderScenarios, play } from './lib/phone-order-script.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-order');
const tree = resolveTree(parseArgs());

const { createRelayClientCallDispatch } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-client-calls.ts');
const { createRemoteCallQueue } = await importFrom(tree, 'apps/desktop/src/main/remote-call-queue.ts');
const nameOf = Object.fromEntries(Object.entries(orderCalls).map(([name, call]) => [call.method, name]));

async function record(steps) {
  const queue = createRemoteCallQueue();
  let hooks;
  let nextId = 1;
  const frames = new Map();
  const methods = Object.fromEntries(
    Object.keys(nameOf).map((method) => [
      method,
      async () => {
        hooks.started(nameOf[method]);
        await hooks.gate(nameOf[method]);
      },
    ])
  );
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods,
    attached: () => true,
    live: () => true,
    sendEncryptedFrame: async (_client, frame) => {
      frames.get(frame.id)?.(frame);
    },
    acknowledgePaintProbe: () => null,
    resyncClient() {},
    recordCall() {},
    browserStreams: {},
    browserTabs: {},
  });
  const client = { callQueue: queue, pendingFrames: 0 };
  const executions = [];
  // The call's answer is the frame Node's dispatch sent for it. Node's relay gets a fired call as the same frame as any other.
  const send = async (name) => {
    const id = nextId++;
    const answered = new Promise((resolve) => frames.set(id, resolve));
    const { execution } = await dispatch('phone', client, { id, ...orderCalls[name] }, 0);
    executions.push(execution);
    const frame = await answered;
    if (!frame.ok) throw new Error(frame.error);
    return frame.value;
  };
  const trace = await play(steps, { begin: (given) => (hooks = given), send, fire: send });
  await Promise.all(executions);
  queue.close();
  return trace;
}

const scenarios = {};
for (const [name, steps] of Object.entries(orderScenarios)) scenarios[name] = { steps, ...(await record(steps)) };
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "The order in which Node's relay dispatch and call queue started and ended the calls of different groups one phone connection sent: per scenario its script, the events in order and each call's answer.",
  calls: orderCalls,
  scenarios,
});
writeSetManifest(out, {
  set: 'phone-order',
  recorder: 'benchmarks/rust-core/recorders/record-phone-order.mjs',
  command: `node benchmarks/rust-core/recorders/record-phone-order.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { scenarios: Object.keys(scenarios).length },
});
commitStage(out, FIXTURES);
console.log(`phone-order: ${Object.keys(scenarios).length} scenarios`);
process.exit(0);
