#!/usr/bin/env node
// Node's shared provider catalog (`sharedProviderCatalog`, session-runtime/provider-catalog-cache.mjs over
// catalog-deadline.mjs) when a provider's listing ends exactly at the 4 s deadline: its listModels answers on a
// 4000 ms timer, armed a microtask after the deadline's own 4000 ms timer (catalog-deadline.mjs arms the deadline
// synchronously and invokes the provider on a later microtask), so the deadline's callback runs first. Under a
// recorder-local virtual clock each scenario records three unforced reads: the first, answered between the deadline's
// callback and the listing's; one at once while that listing is still pending; and one after the listing's callback
// ran at the same virtual time and its settlement drained. Each read holds its entries (models, error, retryAt from
// the virtual start), the provider calls so far and catalog-deadline's pending operations. Rust's `ProviderCatalog`
// must publish the same models and state at each point and ask the same providers.
//
//   node benchmarks/rust-core/recorders/record-catalog-deadline-tie.mjs --tree <export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/catalog-deadline-tie/golden.json (+ MANIFEST.json, identity exact at the commit).
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, productIdentity, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-catalog-deadline-tie.mjs';
const NOW = 1_800_000_000_000;
const SCENARIOS = [
  { name: 'tie-alone', providers: [{ name: 'tie', answersAfterMs: 4_000 }] },
  { name: 'tie-beside-a-fast-provider', providers: [{ name: 'fast', answersAfterMs: 10 }, { name: 'tie', answersAfterMs: 4_000 }] },
];

const tree = resolveTree(parseArgs());
const cache = await importFrom(tree, 'src/session-runtime/provider-catalog-cache.mjs');
const deadlines = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/catalog-deadline.mjs');
const TIMEOUT_MS = deadlines.PROVIDER_CATALOG_TIMEOUT_MS;

// Virtual time, local to this recorder: timers wait in one queue ordered by absolute due time, then registration
// sequence (Node's own order for timers of one duration), and run one callback at a time; between callbacks an
// unmocked `setImmediate` lets every microtask drain, as Node's `listOnTimeout` runs `runNextTicks` between callbacks.
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
const realSetImmediate = globalThis.setImmediate;
let now = NOW;
let seq = 0;
let queue = [];
// The provider whose listModels is running: a timer it arms is its listing timer.
let listingOf = null;
const checkpoint = () => new Promise((resolve) => realSetImmediate(resolve));
const pendingTimers = () => queue.filter((t) => !t.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq);
const timersView = () => pendingTimers().map((t) => ({ kind: t.kind, dueAt: t.due - NOW }));

function virtualSetTimeout(fn, ms, ...args) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!listingOf && delay !== TIMEOUT_MS) throw new Error(`unexpected ${delay} ms timer outside a listing`);
  const timer = { kind: listingOf ? `listing:${listingOf}` : 'deadline', due: now + delay, seq: ++seq, fn, args, cleared: false };
  Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true });
  queue.push(timer);
  return timer;
}
function virtualClearTimeout(timer) {
  if (timer) timer.cleared = true;
}

/** Runs the next timer's callback at its due time, then lets the microtasks it caused drain. */
async function dispatchOne(log) {
  const [timer] = pendingTimers();
  if (!timer) throw new Error('no timer is armed');
  queue = queue.filter((t) => t !== timer);
  now = Math.max(now, timer.due);
  log.push({ fired: timer.kind, at: now - NOW });
  timer.fn(...timer.args);
  await checkpoint();
  return timer.kind;
}

const entryOf = (entry) => ({
  name: entry.name,
  models: entry.models.map((m) => m.id),
  ...(Object.hasOwn(entry, 'error') ? { error: { code: entry.error.code, message: entry.error.message }, retryAt: entry.retryAt - NOW } : {}),
});

const results = [];
globalThis.setTimeout = virtualSetTimeout;
globalThis.clearTimeout = virtualClearTimeout;
Date.now = () => now;
try {
  for (const scenario of SCENARIOS) {
    // A new registry revision per scenario: nothing of the previous one is reused.
    const revision = results.length + 1;
    const calls = Object.fromEntries(scenario.providers.map((p) => [p.name, 0]));
    const providers = scenario.providers.map(({ name, answersAfterMs }) => [
      name,
      {
        listModels() {
          calls[name] += 1;
          listingOf = name;
          try {
            return new Promise((resolve) => setTimeout(() => resolve([{ id: 'm' }]), answersAfterMs));
          } finally {
            listingOf = null;
          }
        },
      },
    ]);
    const registry = { providerCatalogRevision: () => revision, getAllProviders: () => providers };
    const log = [];

    // One unforced read: virtual time holds still until every listing it asked has armed its timer, then runs timer
    // callbacks one at a time until the read answers.
    const read = async () => {
      const asked = { ...calls };
      let answer = null;
      const reading = cache.sharedProviderCatalog(registry).then((entries) => {
        answer = entries;
      });
      await checkpoint();
      const armed = timersView();
      if (calls.tie > asked.tie) {
        const timers = pendingTimers();
        const listing = timers.find((t) => t.kind === 'listing:tie');
        if (!listing || !timers.some((t) => t.kind === 'deadline' && t.due === listing.due && t.seq < listing.seq)) {
          throw new Error(`the tied listing's timer is not due with a deadline armed before it: ${JSON.stringify(armed)}`);
        }
      }
      while (answer === null) await dispatchOne(log);
      await reading;
      return {
        entries: answer.map(entryOf),
        calls: { ...calls },
        at: now - NOW,
        armed,
        pendingOps: deadlines.pendingProviderCatalogOps(),
        stalled: deadlines.stalledProviderCatalogOps(),
        timersLeft: timersView(),
      };
    };

    // 1. Answers after the deadline's callback, before the tied listing's.
    const first = await read();
    if (pendingTimers()[0]?.kind !== 'listing:tie') throw new Error(`the tied listing already ran: ${JSON.stringify(first)}`);
    // 2. Again at once, while that listing is still pending.
    const whilePending = await read();
    // 3. The tied listing's callback runs at the same virtual time and its settlement drains; then again.
    const fired = await dispatchOne(log);
    if (fired !== 'listing:tie') throw new Error(`expected the tied listing's callback, ran ${fired}`);
    const settledOps = deadlines.pendingProviderCatalogOps();
    const afterSettle = await read();
    // A fresh listing the last read started is driven to its end too, so nothing pends into the next scenario.
    while (pendingTimers().length > 0) await dispatchOne(log);
    if (deadlines.pendingProviderCatalogOps().length > 0) throw new Error('a listing is still pending at the end');
    results.push({ name: scenario.name, providers: scenario.providers, first, whilePending, settledOps, afterSettle, dispatched: log });
  }
} finally {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  Date.now = real.now;
}

const identity = productIdentity(tree, NODE_COMMIT);
if (!identity.refComparison.exact) throw new Error(`the tree is not an exact export of ${NODE_COMMIT}: ${JSON.stringify(identity.refComparison)}`);
const finalDir = join(FIXTURES_ROOT, 'catalog-deadline-tie');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { now: NOW, nodeVersion: process.version, scenarios: results });
writeSetManifest(stage, { set: 'catalog-deadline-tie', recorder, command: `node ${recorder} --tree <tree>`, identity });
commitStage(stage, finalDir);
