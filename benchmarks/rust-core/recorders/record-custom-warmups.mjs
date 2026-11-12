#!/usr/bin/env node
// The connection warm-up of a custom provider that serves several wires (`createCustomProvider`, a Chat, Responses and
// Messages endpoint), through the product's own class: when a `HEAD /` of its origin goes out. The provider's constructor warms
// the origin (`OpenAICompatProvider`, openai-compat.mjs:100); a send on the Chat or Responses wire re-warms it before the
// request (`super.send`, openai-compat.mjs:207), gated per origin by the keep-alive window (`preconnect`, http-agent.mjs:482); a
// send routed to the Messages wire goes straight to the Anthropic client (custom-provider.mjs:204), which warms nothing per send.
//   one scenario per wire, each as a new process (no origin warmed): the provider is built, sends once inside the gate, the clock
//   passes the window, and it sends once more. After each step the recording holds how many warm-ups had arrived, and the last
//   scenario's warm-up requests whole.
// The sends end in a scripted refusal; the requests that reached the endpoint (sent) show which wire each took.
//
//   node benchmarks/rust-core/recorders/record-custom-warmups.mjs --tree <export of b6f10295a with the patch applied> --patch <patch>
//
// Output: native/core/fixtures/custom-warmups/golden.json.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeSetManifest, writeText } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const cli = parseArgs();
const tree = resolveTree(cli);
const identity = nodeTreeIdentity(cli, tree, NODE_COMMIT);
const finalDir = join(FIXTURES_ROOT, 'custom-warmups');
const href = (path) => pathToFileURL(join(tree, path)).href;
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'custom-warmups-'));
process.env.MIXDOG_HOME = join(process.env.MIXDOG_DATA_DIR, 'home');
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/.test(k) && !/^MIXDOG_/.test(k)) delete process.env[k];
delete process.env.MIXDOG_LLM_KEEPALIVE_MS;
const { createCustomProvider } = await import(href('src/runtime/agent/orchestrator/providers/custom-provider.mjs'));
const { getLlmDispatcher, recycleLlmDispatcher } = await import(href('src/runtime/shared/llm/http-agent.mjs'));

const DEADLINE_MS = 60_000;
/** `wait`, or a rejection naming `what` when it has not happened within the deadline. */
const within = (what, wait) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the recorder waited ${DEADLINE_MS}ms for ${what}, which never happened`)), DEADLINE_MS);
  });
  return Promise.race([wait, expired]).finally(() => clearTimeout(timer));
};

// A warm-up is fire-and-forget: `preconnect` sends it on the process's global dispatcher (the proxy-policy router), which counts
// each `HEAD` as it starts, and a step ends once every one has arrived.
let started = 0;
let arrived = [];
let sent = [];
const waiters = [];
getLlmDispatcher();
const router = createRequire(join(tree, 'package.json'))('undici').getGlobalDispatcher();
const dispatch = router.dispatch.bind(router);
router.dispatch = (options, handler) => {
  if (options.method === 'HEAD') started++;
  return dispatch(options, handler);
};
const settled = () =>
  arrived.length >= started
    ? Promise.resolve()
    : within(`the ${started} warm-ups the product started to arrive (${arrived.length} did)`, new Promise((resolve) => waiters.push(resolve)));

const REFUSAL = JSON.stringify({ error: { message: 'scripted refusal', type: 'invalid_request_error' } });
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.method === 'HEAD') {
      arrived.push([req.method, req.url]);
      res.end();
      if (arrived.length >= started) for (const done of waiters.splice(0)) done();
      return;
    }
    sent.push([req.method, req.url]);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(REFUSAL);
  });
});
await within('the endpoint to listen', new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
}));

const T0 = 1_800_000_000_000;
// The window (`MIXDOG_LLM_KEEPALIVE_MS` 60 s less 10 s) has passed.
const LAPSED = T0 + 50_001;
const MODELS = { chat: 'model-chat', responses: 'model-responses', messages: 'model-messages' };
const recorded = {};
mock.timers.enable({ apis: ['Date'], now: T0 });
for (const wire of ['chat', 'responses', 'messages']) {
  mock.timers.setTime(T0);
  // A scenario starts as a new process: no origin has been warmed.
  recycleLlmDispatcher();
  started = 0;
  arrived = [];
  sent = [];
  const base = `http://127.0.0.1:${server.address().port}/${wire}/v1`;
  const steps = [];
  const step = async (name) => {
    await settled();
    steps.push([name, arrived.length]);
  };
  const send = async () => {
    try {
      await provider.send([{ role: 'user', content: 'hi' }], MODELS[wire], [], {});
    } catch {
      // the scripted refusal
    }
  };
  const provider = await createCustomProvider('custom-warm', {
    schemaVersion: 2,
    type: 'custom',
    name: `warm ${wire}`,
    protocol: 'openai-chat',
    baseURL: base,
    apiKey: 'warm-up-key',
    wires: ['chat', 'responses', 'messages'],
    modelWires: Object.fromEntries(Object.entries(MODELS).map(([w, model]) => [model, w])),
  });
  await step('built');
  await send();
  await step('send inside the gate');
  mock.timers.setTime(LAPSED);
  await send();
  await step('send after the gate lapsed');
  recorded[wire] = { steps, warmups: arrived, sent };
  console.log(`${wire}: ${steps.map(([name, n]) => `${name} ${n}`).join(', ')}`);
}
mock.timers.reset();
server.close();
const stage = stageSet(finalDir);
writeText(join(stage, 'golden.json'), `${JSON.stringify({ clock: { start: T0, lapsed: LAPSED }, scenarios: recorded }, null, 1)}\n`);
const provenance = recorderProvenance(import.meta.url);
writeSetManifest(stage, {
  set: 'custom-warmups',
  recorder: provenance.recorder,
  extra: {
    ...provenance,
    clock: 'the process clock is fixed (mock.timers Date) and moved past the warm-up window between the two sends',
    exclusions: [
      'the scripted refusal each send ends in is not recorded: the warm-ups and the paths the sends reached are compared; a warm-up arrives on a connection of its own, so its position among the sends is not recorded either, only how many had arrived when each step ended',
    ],
  },
  command: `node benchmarks/rust-core/recorders/record-custom-warmups.mjs --tree <export of ${NODE_COMMIT} with ${cli.get('patch')} applied> --patch ${cli.get('patch')}`,
  identity,
});
commitStage(stage, finalDir);
process.exit(0);