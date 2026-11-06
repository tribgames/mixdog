#!/usr/bin/env node
// What the memory cycle's `cycle1-agent` dispatch hands the session host, recorded from Node's own
// code for the Rust `run_host::cycle1_dispatch` to equal: the real `createCycleLlmAdapters`
// adapter, the real `callAgentDispatch` client (against a loopback server that routes
// `/agent/dispatch` to the real `createAgentDispatchBroker`, as `http-routes.mjs` does) and a
// `dispatchAgent` that records the payload `sessionRuntimeHost.agentDispatch` would receive.
//
//   node benchmarks/rust-core/recorders/record-cycle1-dispatch.mjs [--tree <dir>]
//
// Output: native/core/fixtures/cycle1-dispatch/golden.json.
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'cycle1-dispatch');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-cycle1-dispatch.mjs';
const at = (path) => importFrom(tree, path);

// Nothing Mixdog imports may reach the user's real directories (import-time sweeps delete data).
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = mkdtempSync(join(tmpdir(), `cycle1-dispatch-${name.toLowerCase()}-`));
}

// The client finds the broker through `<runtime root>/daemon.json`, so the loopback server and its
// discovery file live in a scratch root.
const root = mkdtempSync(join(tmpdir(), 'cycle1-dispatch-'));
process.env.MIXDOG_RUNTIME_ROOT = root;
const { createAgentDispatchBroker } = await at('src/standalone/agent-dispatch-broker.mjs');
const { createCycleLlmAdapters } = await at('src/runtime/memory/lib/cycle-llm-adapters.mjs');
const agentIpc = await at('src/runtime/memory/lib/agent-ipc.mjs');

let behaviour = { reply: 'reply text' };
const seen = [];
let runs = [];
const broker = createAgentDispatchBroker({
  dispatchAgent: async (payload, { signal }) => {
    seen.push({ ...payload, dispatchId: typeof payload.dispatchId === 'string' && payload.dispatchId.length > 0 });
    const run = { aborted: false, reason: null };
    runs.push(run);
    if (behaviour.fail) throw new Error(behaviour.fail);
    if (behaviour.hang) {
      // A run that only ends when it is cancelled, as a provider call does.
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      run.aborted = true;
      run.reason = signal.reason?.message ?? null;
      throw signal.reason;
    }
    return behaviour.reply;
  },
});
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.on('end', async () => {
    const body = JSON.parse(data || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agent/cancel') {
      const cancelled = await broker.cancelAndWait(String(body.callId || '').trim(), String(body.reason || 'memory agent dispatch canceled'));
      return res.end(JSON.stringify({ ok: true, cancelled }));
    }
    try {
      const result = await broker.dispatch(body.params || {}, { callId: String(body.callId || '').trim() });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
writeFileSync(
  join(root, 'daemon.json'),
  JSON.stringify({ pid: process.pid, endpoints: { channel: { port: server.address().port, token: 'tok' } } }),
);

// What `cycle1-window.mjs` builds as `request` (cwd is always null; `mode` is added by the chunk
// generator), with `callLlm` = `getCycle1CallLlm()`.
const callLlm = createCycleLlmAdapters({ callAgentDispatch: agentIpc.callAgentDispatch }).getCycle1CallLlm();
const cases = [
  { id: 'preset-object', preset: { provider: 'p', model: 'm' }, timeout: 120000, prompt: 'classify these rows' },
  { id: 'preset-name', preset: 'test', timeout: 60000, prompt: 'p' },
  { id: 'no-preset', preset: undefined, timeout: 60000, prompt: 'p' },
  { id: 'null-preset', preset: null, timeout: 60000, prompt: 'p' },
  { id: 'empty-preset-name', preset: '', timeout: 60000, prompt: 'p' },
  { id: 'timeout-below-floor', preset: 'test', timeout: 500, prompt: 'p' },
  { id: 'timeout-zero', preset: 'test', timeout: 0, prompt: 'p' },
  { id: 'timeout-fractional', preset: 'test', timeout: 1500.5, prompt: 'p' },
  { id: 'empty-prompt', preset: 'test', timeout: 60000, prompt: '' },
  { id: 'dispatch-fails', preset: 'test', timeout: 60000, prompt: 'p', fail: 'provider exploded' },
  { id: 'empty-reply', preset: 'test', timeout: 60000, prompt: 'p', reply: '' },
];
const recorded = [];

for (const c of cases) {
  behaviour = { reply: c.reply ?? 'reply text', fail: c.fail };
  seen.length = 0;
  const request = { agent: 'cycle1-agent', taskType: 'maintenance', preset: c.preset, timeout: c.timeout, cwd: null, mode: 'cycle1' };
  let outcome;
  try {
    outcome = { ok: await callLlm(request, c.prompt) };
  } catch (error) {
    outcome = { error: error.message };
  }
  recorded.push({
    id: c.id,
    request: { preset: c.preset ?? null, timeout: c.timeout },
    prompt: c.prompt,
    dispatched: seen.length === 0 ? null : JSON.parse(JSON.stringify(seen[0])),
    outcome,
  });
}

// A run that never answers: the request fails at `timeout + 5000` ms and cancels the run.
// A caller whose signal is already aborted never reaches the broker; one aborted while the run is
// in flight cancels it. The signal's reason is `null`, so Node's fallback sentence is the failure.
const ended = [];
for (const c of [
  { id: 'deadline', timeout: 1000 },
  { id: 'cancelled-before-the-call', timeout: 60000, before: true },
  { id: 'cancelled-while-running', timeout: 60000 },
]) {
  behaviour = { hang: true };
  seen.length = 0;
  runs = [];
  const controller = new AbortController();
  if (c.before) controller.abort(null);
  const request = { agent: 'cycle1-agent', taskType: 'maintenance', preset: 'test', timeout: c.timeout, cwd: null, mode: 'cycle1', signal: controller.signal };
  const call = callLlm(request, 'p').then(
    (ok) => ({ ok }),
    (error) => ({ error: error.message }),
  );
  if (!c.before && !c.id.startsWith('deadline')) {
    while (runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(null);
  }
  const outcome = await call;
  ended.push({
    id: c.id,
    request: { timeout: c.timeout },
    dispatched: seen.length > 0,
    run: runs.length === 0 ? null : runs[0],
    outcome,
  });
}

server.close();
writeJson(join(stage, 'golden.json'), { cases: recorded, ended });
writeSetManifest(stage, { set: 'cycle1-dispatch', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
