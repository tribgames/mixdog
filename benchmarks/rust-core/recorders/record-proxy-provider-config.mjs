#!/usr/bin/env node
// Golden twin of `loadModelProxyProviderConfig` (providers/model-proxy-provider.mjs) as the
// setup tool calls it (`{ force, waitMs: 1000 }`): the `providerConfig` question put to the PC,
// the readiness rule, the retry schedule, the 15 s cache per client generation, and what an
// unavailable PC and a failing PC read as. Node's real function runs over the real
// `ModelProxyChannel` with a scripted PC behind its publisher and an injected clock.
//
// A scenario is a list of operations: `call` (force, clock advance before it) and `reconnect`
// (the client goes away and returns: a new generation). Each ask the PC receives is answered from
// the scenario's queue. The record holds each call's outcome and the total asks.
//
//   node benchmarks/rust-core/recorders/record-proxy-provider-config.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'proxy-provider-config');
const base = mkdtempSync(join(tmpdir(), 'proxy-provider-config-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_MODEL_PROXY = 'client';
delete process.env.NODE_TEST_CONTEXT;

const provider = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs');
const channelModule = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const info = (enabled, extra = {}) => ({ enabled, ...extra });
const LOADED = { openai: info(true, { type: 'api-key', authState: 'present' }), anthropic: info(false, { authState: 'absent' }), 'custom-a': info(true, { type: 'custom', name: 'Mine', hiddenModels: ['m1'] }) };
const answer = (providers, ready) => ({ ok: true, value: ready === undefined ? { providers } : { providers, ready } });
const failure = (message) => ({ ok: false, error: { name: 'Error', message, props: {} } });

const scenarios = [
  { name: 'a loaded PC answers', replies: [answer(LOADED, true)], ops: [{ op: 'call' }] },
  { name: 'a loaded PC with nothing enabled is authoritative', replies: [answer({ openai: info(false) }, true)], ops: [{ op: 'call' }] },
  { name: 'an unready PC is asked again until it is ready', replies: [answer({}, false), answer(LOADED, true)], ops: [{ op: 'call' }] },
  { name: 'a PC that never becomes ready is unavailable after the budget', replies: Array(8).fill(answer({}, false)), ops: [{ op: 'call' }] },
  { name: 'an older PC without ready counts when it names an enabled provider', replies: [answer(LOADED)], ops: [{ op: 'call' }] },
  { name: 'an older PC without ready and nothing enabled is not ready', replies: Array(8).fill(answer({ openai: info(false) })), ops: [{ op: 'call' }] },
  { name: 'the PC fails the call', replies: [failure('PC broke')], ops: [{ op: 'call' }] },
  { name: 'no client is connected', connected: false, replies: [], ops: [{ op: 'call' }] },
  { name: 'a second call inside 15 s is served from the cache', replies: [answer(LOADED, true), answer({}, true)], ops: [{ op: 'call' }, { op: 'call', advance: 14999 }] },
  { name: 'a call after 15 s asks again', replies: [answer(LOADED, true), answer({ openai: info(false) }, true)], ops: [{ op: 'call' }, { op: 'call', advance: 15000 }] },
  { name: 'force asks again inside the cache window', replies: [answer(LOADED, true), answer({ openai: info(false) }, true)], ops: [{ op: 'call' }, { op: 'call', force: true, advance: 1 }] },
  { name: 'a reconnect is a new generation: the cache is not served', replies: [answer(LOADED, true), answer({ openai: info(false) }, true)], ops: [{ op: 'call' }, { op: 'reconnect' }, { op: 'call', advance: 1 }] },
  { name: 'a failed ask leaves no cache', replies: [failure('PC broke'), answer(LOADED, true)], ops: [{ op: 'call' }, { op: 'call', advance: 1 }] },
  { name: 'a client that connects inside the budget is waited for', connected: false, connectAfter: 300, replies: [answer(LOADED, true)], ops: [{ op: 'call' }] },
  { name: 'a client that connects after the budget is too late', connected: false, connectAfter: 1500, replies: [answer(LOADED, true)], ops: [{ op: 'call' }] },
  { name: 'provider order is the PC order', replies: [answer({ zeta: info(true), 'custom-b': info(true, { type: 'custom' }), alpha: info(true) }, true)], ops: [{ op: 'call' }] },
];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000);
const results = [];
for (const scenario of scenarios) {
  provider._resetModelProxyProviderConfigForTest();
  const channel = new channelModule.ModelProxyChannel();
  let asks = 0;
  const asked = [];
  let clock = 1_000_000;
  const attach = () =>
    channel.attachPublisher((state) => {
      for (const request of state.requests) {
        const reply = scenario.replies[asks] ?? failure('unscripted');
        asks += 1;
        asked.push({ provider: request.provider, method: request.method, model: request.model });
        queueMicrotask(() => {
          channel.claim(request.id);
          channel.resolve(request.id, reply.ok, reply.ok ? JSON.stringify(reply.value) : null, reply.ok ? null : JSON.stringify(reply.error));
        });
      }
    });
  let detach = () => {};
  if (scenario.connectAfter !== undefined) setTimeout(() => { detach = attach(); }, scenario.connectAfter);
  else if (scenario.connected !== false) detach = attach();
  const calls = [];
  for (const op of scenario.ops) {
    if (op.op === 'reconnect') {
      detach();
      await tick();
      detach = attach();
      continue;
    }
    clock += op.advance ?? 0;
    const before = asks;
    let out;
    try {
      out = { value: plain(await provider.loadModelProxyProviderConfig({ channel, now: () => clock, waitMs: 1000, force: op.force === true })) };
    } catch (error) {
      out = { error: { message: String(error?.message ?? error), code: error?.code ?? null } };
    }
    calls.push({ force: op.force === true, advance: op.advance ?? 0, asks: asks - before, ...out });
  }
  if (scenario.connectAfter !== undefined) await tick(scenario.connectAfter + 200);
  detach();
  results.push({ name: scenario.name, connected: scenario.connected !== false, ...(scenario.connectAfter !== undefined ? { connectAfter: scenario.connectAfter } : {}), replies: scenario.replies.slice(0, 8), calls, asked: plain(asked.slice(0, 1)), asks });
}
clearInterval(keepAlive);
delete process.env.MIXDOG_MODEL_PROXY;

writeJson(join(outDir, 'golden.json'), { domain: 'proxy-provider-config', recorder: 'benchmarks/rust-core/recorders/record-proxy-provider-config.mjs', waitMs: 1000, scenarios: results });
writeSetManifest(outDir, {
  set: 'proxy-provider-config',
  recorder: 'benchmarks/rust-core/recorders/record-proxy-provider-config.mjs',
  command: 'node benchmarks/rust-core/recorders/record-proxy-provider-config.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(70), 'asks', r.asks, '|', r.calls.map((c) => (c.error ? `${c.error.code ?? 'ERR'}:${c.error.message.slice(0, 40)}` : `ok(${Object.keys(c.value).join(',')}) +${c.asks}`)).join(' ; '));
