#!/usr/bin/env node
// Node's channels config reload watch tests (src/runtime/channels/lib/config-reload-watch.test.mjs, 3 cases) from the real
// `createConfigReloadWatch` (config-reload-watch.mjs) over the real shared config change feed (shared/config.mjs
// `updateSection`, `subscribeConfigChange`, a real fs watcher on a private data directory):
//   55 every config write by another process reloads (a real child process performs each write, as the test does);
//   75 a change outside the channels/voice sections reloads nothing, a voice change reloads;
//   92 a slower load of an older config never overwrites a newer one (the real `createConfigReloader`, owned-runtime/config-reload.mjs;
//      its config loader is a scripted endpoint the recorder settles on purpose).
// Recorded per step: the reload callbacks seen (count, in order), and every file under the data directory (path, bytes) and under
// the backup root (backup directory names normalised, bytes whole), so what each write put on disk and what the final removal took away
// is in the golden. Absence ("an agent setting leaves the webhook server running", "a stopped watch reloads nothing") is proven by
// ORDER, not by waiting: the next observable event arrives and the reload count at that moment is what is recorded.
// Waits are explicit promises that resolve when the product reaches the step (deadline 30 s, message naming it); no sleep, no poll.
//
//   node benchmarks/rust-core/recorders/record-channels-config-reload-order.mjs --tree <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { begin, finish, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const root = mkdtempSync(join(tmpdir(), 'mixdog-channels-reload-'));
const dataDir = join(root, 'data');
const backupRoot = join(root, 'backups');
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
mkdirSync(dataDir);
const sharedConfigPath = join(ctx.tree, 'src/runtime/shared/config.mjs');
const { updateSection } = await importFrom(ctx.tree, 'src/runtime/shared/config.mjs');
const { createConfigReloadWatch } = await importFrom(ctx.tree, 'src/runtime/channels/lib/config-reload-watch.mjs');
const { createConfigReloader } = await importFrom(ctx.tree, 'src/runtime/channels/lib/owned-runtime/config-reload.mjs');

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
// Run-dependent text in the files (declared in `normalised`): the private data dir path, the instance id, ISO timestamps.
const normaliseText = (text) => text
  .split(JSON.stringify(dataDir).slice(1, -1)).join('<data-dir>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<instance-id>')
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>');
const walk = (base) => {
  const out = [];
  if (!existsSync(base)) return out;
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push({ path: relative(base, full).split(sep).join('/'), text: normaliseText(readFileSync(full, 'utf8')) });
    }
  };
  visit(base);
  return out;
};
// Backup directory names carry a hashed scope and a timestamp; they are labelled by order (declared in `normalised`).
const backups = () => walk(backupRoot)
  .map((file) => ({ ...file, path: file.path.replace(/^scope-[0-9a-f]+\//, '<scope>/').replace(/^<scope>\/\d{4}-[^/]*?Z-(\d+-[a-z-]+)\//, '<scope>/<time>-$1/') }))
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.text < b.text ? -1 : 1));
const disk = () => ({ dataDir: walk(dataDir), backups: backups() });

// Waits for the n-th reload callback.
function reloadCounter() {
  const seen = [];
  const waiters = new Map();
  return {
    seen,
    call: async () => { seen.push(seen.length + 1); waiters.get(seen.length)?.resolve(); },
    reached: (n, label) => (seen.length >= n ? Promise.resolve() : within(label, (waiters.set(n, deferred()), waiters.get(n).promise), 30_000)),
  };
}

const cases = [];
{
  const counter = reloadCounter();
  const watch = createConfigReloadWatch(counter.call);
  const steps = [];
  watch.start();
  steps.push({ step: 'watch.start()', reloads: counter.seen.length, disk: disk() });
  try {
    for (let write = 1; write <= 3; write += 1) {
      const script = `const { updateSection } = await import(${JSON.stringify(pathToFileURL(sharedConfigPath).href)}); updateSection('channels', (section) => ({ ...section, revision: ${write} }));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env }, encoding: 'utf8', timeout: 30_000 });
      if (child.status !== 0) throw new Error(`the child process write ${write} failed: ${child.stderr || child.stdout}`);
      await counter.reached(write, `reload ${write} after the write by another process`);
      steps.push({ step: `another process writes channels.revision = ${write}`, reloads: counter.seen.length, disk: disk() });
    }
  } finally {
    watch.stop();
  }
  const settled = counter.seen.length;
  // After stop(): an in-process write is delivered synchronously to subscribers; the count read right after it is the proof.
  updateSection('channels', (section) => ({ ...section, revision: 4 }));
  steps.push({ step: 'watch.stop(), then an in-process write of channels.revision = 4', reloadsBeforeStop: settled, reloadsAfterTheWrite: counter.seen.length, disk: disk() });
  cases.push({ name: 'every config write by another process reloads the channels runtime, not only the first atomic rename (test line 55)', steps });
}
{
  const counter = reloadCounter();
  const watch = createConfigReloadWatch(counter.call);
  const steps = [];
  watch.start();
  try {
    updateSection('agent', (section) => ({ ...section, promptCacheWarming: false }));
    steps.push({ step: 'write agent.promptCacheWarming = false', reloads: counter.seen.length, disk: disk() });
    updateSection('voice', (section) => ({ ...section, language: 'ko' }));
    await counter.reached(1, 'the reload after the voice change');
    steps.push({ step: 'write voice.language = "ko" (a reload arrives; the agent write produced none before it)', reloads: counter.seen.length, disk: disk() });
  } finally {
    watch.stop();
  }
  cases.push({ name: 'changes outside the channels and voice sections never restart the listeners (test line 75)', steps });
}
{
  const events = [];
  const loads = new Map();
  const started = new Map();
  let calls = 0;
  let config = null;
  const reloadResults = [];
  const reloader = createConfigReloader({
    state: { automationRunning: true },
    getConfig: () => config,
    setConfig: (value) => { config = value; events.push({ event: 'setConfig', value: exact(value) }); },
    getBridgeRuntimeConnected: () => false,
    scheduler: { reloadConfig: (schedules, options) => events.push({ event: 'scheduler.reloadConfig', schedules: exact(schedules), options: exact(options) }) },
    services: { syncWebhookAndEventRuntime: (options) => events.push({ event: 'syncWebhookAndEventRuntime', options: exact(options) }), stopWebhookAndEventRuntime: async () => { events.push({ event: 'stopWebhookAndEventRuntime' }); } },
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
  const loadStarted = (id) => { if (loads.has(id)) return Promise.resolve(); started.set(id, deferred()); return within(`load #${id} to start after the config write`, started.get(id).promise, 30_000); };
  const steps = [];
  watch.start();
  try {
    updateSection('channels', (section) => ({ ...section, revision: 101 }));
    await loadStarted(1);
    steps.push({ step: 'write channels revision 101 -> the watch calls reload; load #1 started', events: events.splice(0), disk: disk() });
    updateSection('channels', (section) => ({ ...section, revision: 102 }));
    await loadStarted(2);
    steps.push({ step: 'write channels revision 102 -> load #2 started while #1 is pending', events: events.splice(0), disk: disk() });
    loads.get(2).resolve({ revision: 2 });
    await within('reload #2 to apply', reloadResults[1], 30_000);
    steps.push({ step: 'load #2 resolves with {revision: 2} -> applied', events: events.splice(0), config: exact(config) });
    loads.get(1).resolve({ revision: 1 });
    await within('reload #1 to settle', reloadResults[0], 30_000);
    steps.push({ step: 'load #1 (older) resolves with {revision: 1} last -> discarded', events: events.splice(0), config: exact(config) });
  } finally {
    watch.stop();
  }
  cases.push({ name: 'a slower load of an older config never overwrites a newer one (test line 92)', steps, loadCalls: calls });
}
const finalDisk = disk();
rmSync(root, { recursive: true, force: true });
const afterRemoval = { dataDirExists: existsSync(dataDir), backupRootExists: existsSync(backupRoot) };

finish(ctx, {
  url: import.meta.url,
  set: 'channels-config-reload-order',
  golden: { domain: 'channels-config-reload-order', source: 'src/runtime/channels/lib/config-reload-watch.test.mjs', cases, finalDisk, afterRemoval },
  extra: {
    entry: { runs: 'createConfigReloadWatch (config-reload-watch.mjs) subscribed to the real shared config change feed (shared/config.mjs subscribeConfigChange, a real directory watcher) in a private data dir; writes by updateSection in-process and, for case 55, by a real child process; the real createConfigReloader (owned-runtime/config-reload.mjs) for case 92', notRun: 'the config loader of case 92 (scripted, settled by the recorder), the scheduler and the webhook/event services (call recorders)' },
    replay: 'mixdog-services daemon: domain_seams/channel_stack.rs, the config.changes() subscription that calls ChannelRuntime::reload_runtime (reload_turn serialized by reload_gate); drive it with the real ConfigWatcher over a temp data dir: compares per step the reload count and, for case 92, the ordered effects (setConfig, scheduler.reloadConfig restart flag, sync/stop services) and the final config; the files on disk are Node\'s config.json bytes for the Rust writer to equal',
    exclusions: 'none. NOTE for the Rust side: cases 55 and 75 are not recorded by branch gaps-memory-channels (its channels fixtures are channel-remote-intent and webhook-late-reload), so this set holds them',
    normalised: { 'private root': 'temp, not recorded; paths are relative to the data dir / backup root', 'file texts': 'the private data dir path, UUIDs (the instance id) and ISO timestamps inside the files are written <data-dir>, <instance-id>, <time>', 'backup directory names': 'scope-<hash> written <scope>, the ISO time in <time>-<sequence>-<kind> written <time>; the backup list is sorted by path then text (the order the files are listed in is not an order of the product)' },
  },
});
process.exit(0);
