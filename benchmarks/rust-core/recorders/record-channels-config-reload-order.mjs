#!/usr/bin/env node
// Case 92 of Node's channels config reload watch tests (src/runtime/channels/lib/config-reload-watch.test.mjs, "a slower
// load of an older config never overwrites a newer one") from the real `createConfigReloadWatch` (config-reload-watch.mjs)
// feeding the real `createConfigReloader` (owned-runtime/config-reload.mjs), with real in-process config writes
// (`updateSection`, shared/config.mjs) in a private data directory. The config loader (`load`) is a scripted endpoint:
// every call returns a promise the recorder settles on purpose, and the scheduler / services are recorders of calls.
// Cases 55 and 75 (every external write reloads; only channels/voice changes reload) are recorded by branch
// gaps-memory-channels and not recorded again. Waits are explicit promises that resolve when the product reaches the
// step (deadline 30 s, message naming it), never sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-channels-config-reload-order.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, finish, importFrom, plain, within } from './lib/mc-record.mjs';

const ctx = begin();
const root = mkdtempSync(join(tmpdir(), 'mixdog-channels-reload-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
mkdirSync(process.env.MIXDOG_DATA_DIR);
const { updateSection } = await importFrom(ctx.tree, 'src/runtime/shared/config.mjs');
const { createConfigReloadWatch } = await importFrom(ctx.tree, 'src/runtime/channels/lib/config-reload-watch.mjs');
const { createConfigReloader } = await importFrom(ctx.tree, 'src/runtime/channels/lib/owned-runtime/config-reload.mjs');

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const events = [];
const loads = new Map();
const started = new Map();
let calls = 0;
let config = null;
const reloadResults = [];

const reloader = createConfigReloader({
  state: { automationRunning: true },
  getConfig: () => config,
  setConfig: (value) => { config = value; events.push({ event: 'setConfig', value: plain(value) }); },
  getBridgeRuntimeConnected: () => false,
  scheduler: { reloadConfig: (schedules, options) => events.push({ event: 'scheduler.reloadConfig', schedules: plain(schedules), options: plain(options) }) },
  services: { syncWebhookAndEventRuntime: (options) => events.push({ event: 'syncWebhookAndEventRuntime', options: plain(options) }), stopWebhookAndEventRuntime: async () => { events.push({ event: 'stopWebhookAndEventRuntime' }); } },
  load: () => {
    calls += 1;
    const id = calls;
    events.push({ event: 'load started', id });
    const gate = deferred();
    loads.set(id, gate);
    started.get(id)?.resolve();
    return gate.promise;
  },
});
const reload = () => { const run = reloader(); reloadResults.push(run); return run; };
const watch = createConfigReloadWatch(reload);
const loadStarted = (id) => { if (!started.has(id)) started.set(id, deferred()); return loads.has(id) ? Promise.resolve() : within(`load #${id} to start after the config write`, started.get(id).promise, 30_000); };

const steps = [];
watch.start();
try {
  updateSection('channels', (section) => ({ ...section, revision: 101 }));
  await loadStarted(1);
  steps.push({ step: 'write channels revision 101 -> the watch calls reload; load #1 started', events: events.splice(0) });
  updateSection('channels', (section) => ({ ...section, revision: 102 }));
  await loadStarted(2);
  steps.push({ step: 'write channels revision 102 -> load #2 started while #1 is pending', events: events.splice(0) });
  loads.get(2).resolve({ revision: 2 });
  await within('reload #2 to apply', reloadResults[1], 30_000);
  steps.push({ step: 'load #2 resolves with {revision: 2} -> applied', events: events.splice(0), config: plain(config) });
  loads.get(1).resolve({ revision: 1 });
  await within('reload #1 to settle', reloadResults[0], 30_000);
  steps.push({ step: 'load #1 (older) resolves with {revision: 1} last -> discarded; its caller got the newer reload', events: events.splice(0), config: plain(config), reload1SettledAfterReload2: true });
} finally {
  watch.stop();
  rmSync(root, { recursive: true, force: true });
}

finish(ctx, {
  url: import.meta.url,
  set: 'channels-config-reload-order',
  golden: { domain: 'channels-config-reload-order', source: 'src/runtime/channels/lib/config-reload-watch.test.mjs', cases: [{ name: 'a slower load of an older config never overwrites a newer one (test line 92)', steps, loadCalls: calls }] },
  extra: {
    entry: { runs: 'createConfigReloadWatch (config-reload-watch.mjs) subscribed to the real shared config change feed (shared/config.mjs subscribeConfigChange) in a private data dir, calling the real createConfigReloader (owned-runtime/config-reload.mjs); updateSection writes the channels section in-process', notRun: 'the config file loader (load is scripted and settled by the recorder), the scheduler and the webhook/event services (call recorders)' },
    replay: 'mixdog-services channels: ch/runtime.rs reload_runtime / reload_turn serialized by reload_gate: two overlapping reloads whose loads resolve in reverse order; compares the ordered effects (setConfig, scheduler.reloadConfig restart flag, sync/stop services) and the final config: only the newest started reload applies',
    exclusions: 'test cases 55 and 75 (external writes / section filter) belong to the gaps-memory-channels recording',
    normalised: { 'private data dir': 'temp, not recorded' },
  },
});
process.exit(0);
