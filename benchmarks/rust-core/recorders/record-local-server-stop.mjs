#!/usr/bin/env node
// How Node's local llama-server owner stops a child that does not exit: the REAL
// `createLocalServerProcess` (src/runtime/local-provider/server-process.mjs, default
// `stopTimeoutMs = 5_000`) with a fake child, under node:test's mock clock (setTimeout, with
// node:timers/promises routed onto it, and Date). The child is made ready on the real clock first.
//   stubborn-term: ignores SIGTERM, dies on SIGKILL.  stubborn-both: ignores both.
// Each kill is stamped (signal, ms after stop() began) and the outcome of stop() is recorded.
// Rust `mixdog_services::local_provider::server_process::stop_state` must do the same.
//   node benchmarks/rust-core/recorders/record-local-server-stop.mjs [--tree <dir>]
// Output: native/core/fixtures/local-server-stop/golden.json.
process.env.TZ = 'UTC';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// node:test's mock clock does not cover node:timers/promises, which `stopState` waits on. Its
// `setTimeout(ms, value, { signal })` is replaced, for the modules loaded below, by the same call
// over the global `setTimeout` (which the mock does cover). Nothing else of the product changes.
const aborted = "Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })";
const FAKE_TIMERS_PROMISES = `
export const setTimeout = (ms, value, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(${aborted});
  const timer = globalThis.setTimeout(() => resolve(value), ms);
  signal?.addEventListener('abort', () => {
    globalThis.clearTimeout(timer);
    reject(${aborted});
  }, { once: true });
});
export const setImmediate = (value) => new Promise((resolve) => globalThis.setImmediate(() => resolve(value)));
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:timers/promises' || specifier === 'timers/promises') {
      return { url: 'data:text/javascript,' + encodeURIComponent(FAKE_TIMERS_PROMISES), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'local-server-stop');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-local-server-stop.mjs';
const { createLocalServerProcess } = await import(pathToFileURL(join(tree, 'src', 'runtime', 'local-provider', 'server-process.mjs')).href);

async function scenario(diesOn) {
  const kills = [];
  let began = 0;
  const manager = createLocalServerProcess({
    portFn: async () => 54321,
    fetchFn: async () => new Response('ok'),
    pollMs: 1,
    spawnFn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal = 'SIGTERM') => {
        kills.push({ signal, atMs: Date.now() - began });
        if (diesOn.includes(signal)) queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      return child;
    },
  });
  await manager.ensure({ key: 'k', modelId: 'm', executable: 'x', cwd: '.', args: (port, key) => ['--port', String(port), '--api-key', key] });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  began = Date.now();
  let outcome = null;
  const stopped = manager.stop().then(
    () => { outcome = { resolved: true, atMs: Date.now() - began }; },
    (error) => { outcome = { resolved: false, atMs: Date.now() - began, message: String(error?.message || error) }; }
  );
  const settle = () => new Promise((done) => setImmediate(done));
  for (let i = 0; i < 30_000 && !outcome; i += 1) {
    for (let j = 0; j < 3; j += 1) await settle();
    mock.timers.tick(1);
  }
  await stopped;
  mock.timers.reset();
  return { kills, outcome };
}

const golden = {
  stopTimeoutMs: 5_000,
  stubbornTerm: await scenario(['SIGKILL']),
  stubbornBoth: await scenario([]),
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'local-server-stop', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);