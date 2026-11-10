// Child of record.mjs: one Node daemon in the isolated env it was started in; records the model-list reads.
//   node --experimental-transform-types child.mjs <nodeTree> <workspace> <scenario.json>
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeTree, workspace, scenarioFile] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const client = await import(pathToFileURL(join(nodeTree, 'src', 'standalone', 'session-client.mjs')).href);
const out = { name: scenario.name, calls: [] };
// Resolves when the daemon's log (the daemon owns its stderr as <data dir>/daemon.log once it is ready) holds the text: a
// directory watch, one read per change, and one deadline timer. `from` (a logMark) skips what was logged before it.
function untilLogged(text, timeoutMs, from = 0) {
  const file = join(process.env.MIXDOG_DATA_DIR, 'daemon.log');
  return new Promise((resolve, reject) => {
    const logged = () => existsSync(file) && readFileSync(file, 'utf8').slice(from).includes(text);
    const finish = (error) => {
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const watcher = watch(process.env.MIXDOG_DATA_DIR, () => logged() && finish());
    const timer = setTimeout(() => finish(new Error('never logged: ' + text)), timeoutMs);
    if (logged()) finish();
  });
}
// The daemon log's length now, in UTF-16 units of its text, so a later wait can look only at what was logged after it.
function logMark() {
  const file = join(process.env.MIXDOG_DATA_DIR, 'daemon.log');
  return existsSync(file) ? readFileSync(file, 'utf8').length : 0;
}
// Resolves when the daemon's log holds, past `from` (a logMark), `first` and after it `then`: the same watch and deadline
// as untilLogged. Marks the boot logged before `from` (its own refresh-ready and warm-ready) do not count.
function untilLoggedInOrder(from, first, then, timeoutMs) {
  const file = join(process.env.MIXDOG_DATA_DIR, 'daemon.log');
  return new Promise((resolve, reject) => {
    const logged = () => {
      if (!existsSync(file)) return false;
      const text = readFileSync(file, 'utf8').slice(from);
      const at = text.indexOf(first);
      return at >= 0 && text.indexOf(then, at + first.length) >= 0;
    };
    const finish = (error) => {
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const watcher = watch(process.env.MIXDOG_DATA_DIR, () => logged() && finish());
    const timer = setTimeout(() => finish(new Error(`never logged ${then} after ${first} past offset ${from}`)), timeoutMs);
    if (logged()) finish();
  });
}
// Resolves when `dir` holds the file `name`: a directory watch and one deadline timer.
function untilFile(dir, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const there = () => existsSync(join(dir, name));
    const finish = (error) => {
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const watcher = watch(dir, () => there() && finish());
    const timer = setTimeout(() => finish(new Error(`${name} never appeared in ${dir}`)), timeoutMs);
    if (there()) finish();
  });
}
let discovery = null;
let attached = null;
let failure = null;
try {
  discovery = await client.ensureDaemon({ cwd: workspace, attempts: 2, readyTimeoutMs: 60_000 });
  attached = await client.attachSession({ discovery, cwd: workspace, onFrame: () => {} });
  const open = { cwd: workspace, desktopSession: null };
  const created = await attached.call('session.create', open);
  const sessionId = String(created?.sessionId || '');
  if (!sessionId) throw new Error('session.create returned no sessionId');
  // Node registers the route's OAuth provider from its statusline-usage warm-up (800 ms after boot) and reports the end of that
  // preparation as the boot-profile event below: the one read that follows lists the provider.
  if (scenario.waitListed) {
    await untilLogged('statusline-usage:warm-ready', 60_000);
    const rows = (await attached.call('session.read', { sessionId, action: 'listProviderModels', args: [{}], open, baseRevision: null }))?.value ?? [];
    if (!rows.some((row) => row.provider === scenario.waitListed)) throw new Error(`provider ${scenario.waitListed} not listed after the warm-up`);
    out.waited = { rows };
  }
  // The daemon's boot load of the provider models (provider-warmups.mjs `warmProviderModels`, no delay in a daemon) races
  // the first read; `afterBootLoad` reads once Node has marked its end (`provider-models:warm-ready`, provider-models.mjs:202).
  if (scenario.afterBootLoad) await untilLogged('provider-models:warm-ready', 60_000);
  for (const call of scenario.calls) {
    let entry;
    // Not a call to Node: the held statusline-usage warm-up (hold.mjs) is released here. Its preparation enables the route's
    // OAuth provider; the registry applies that config and moves the catalog revision (registry.mjs:312), then the readiness
    // starts the new provider set's catalog refresh (provider-readiness.mjs:149), whose first request the endpoint holds
    // (record.mjs). The reads go on once that request arrived: after the move, before the refresh answered.
    if (call.action === 'statuslineUsageWarmup') {
      writeFileSync(join(scenario.holdDir, 'hold-endpoint'), '');
      writeFileSync(join(scenario.holdDir, 'release'), '');
      await untilFile(scenario.holdDir, 'endpoint-held', 60_000);
      out.calls.push({ action: call.action, ok: true });
      continue;
    }
    // Not a call to Node: after `statuslineUsageWarmup`, the held catalog-refresh request is answered. On the refresh's
    // completion Node invalidates the model caches and starts the authoritative re-warm (provider-readiness.mjs:160-171),
    // marking `provider-catalogs:refresh-ready` right after starting it; the re-warm's load marks `provider-models:warm-ready`
    // when it lands (provider-models.mjs:202). Only marks logged after the release count (the boot's own refresh-ready and
    // warm-ready precede it); every earlier load had settled (the full read awaited it), so the first warm-ready after that
    // refresh-ready is the re-warm's. The reads go on once it is logged.
    // Not a call to Node: as `catalogRefreshCompleted`, but the re-warm's load is held at its start (hold.mjs
    // `__mixdogRecorderLoadHold`, armed by <holdDir>/hold-load). The warm call starts that load synchronously (startSharedLoad
    // calls loadProviderModelsFresh, which writes load-held before its first await) and refresh-ready is marked right after
    // it (provider-readiness.mjs:170-171), so once refresh-ready is logged past the release the load is held, the caches
    // are dropped and `caches.providerModelsPromise` is set. The reads go on in that state.
    if (call.action === 'catalogRefreshCompletedRewarmHeld') {
      if (!existsSync(join(scenario.holdDir, 'endpoint-held'))) throw new Error('catalogRefreshCompletedRewarmHeld: no catalog refresh request is held');
      writeFileSync(join(scenario.holdDir, 'hold-load'), '');
      const from = logMark();
      writeFileSync(join(scenario.holdDir, 'release-endpoint'), '');
      await untilLogged('provider-catalogs:refresh-ready', 60_000, from);
      if (!existsSync(join(scenario.holdDir, 'load-held'))) throw new Error('catalogRefreshCompletedRewarmHeld: refresh-ready was logged but no provider-model load is held');
      if (readFileSync(join(process.env.MIXDOG_DATA_DIR, 'daemon.log'), 'utf8').slice(from).includes('provider-models:warm-ready')) {
        throw new Error('catalogRefreshCompletedRewarmHeld: a provider-model load landed after the release');
      }
      out.calls.push({ action: call.action, ok: true });
      continue;
    }
    // Not a call to Node: the held re-warm goes on; the reads go on once it landed (`provider-models:warm-ready` past now).
    if (call.action === 'rewarmReleased') {
      if (!existsSync(join(scenario.holdDir, 'load-held'))) throw new Error('rewarmReleased: no provider-model load is held');
      const from = logMark();
      writeFileSync(join(scenario.holdDir, 'release-load'), '');
      await untilLogged('provider-models:warm-ready', 60_000, from);
      out.calls.push({ action: call.action, ok: true });
      continue;
    }
    if (call.action === 'catalogRefreshCompleted') {
      if (!existsSync(join(scenario.holdDir, 'endpoint-held'))) throw new Error('catalogRefreshCompleted: no catalog refresh request is held');
      const from = logMark();
      writeFileSync(join(scenario.holdDir, 'release-endpoint'), '');
      await untilLoggedInOrder(from, 'provider-catalogs:refresh-ready', 'provider-models:warm-ready', 60_000);
      out.calls.push({ action: call.action, ok: true });
      continue;
    }
    // Not a call to Node: the endpoint answers `call.stub` from here on (a provider's catalog moving on its own).
    if (call.stub) {
      writeFileSync(scenario.stubFile, JSON.stringify(call.stub));
      out.calls.push({ action: call.action, stub: call.stub, ok: true });
      continue;
    }
    try {
      const reply = await attached.call(call.configure ? 'session.configure' : 'session.read', { sessionId, action: call.action, args: call.args, open, baseRevision: null });
      entry = { action: call.action, args: call.args, ok: true, value: reply?.value };
      // The stored agent section the change left. These calls write the config file before they resolve (cfgMod writes inside the call), so it is read
      // when the call's own promise has resolved, so a replay can apply Node's change as it stored it.
      if (call.configure && scenario.recordConfig) {
        entry.agentAfter = JSON.parse(readFileSync(join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json'), 'utf8')).agent;
      }
    } catch (error) {
      entry = { action: call.action, args: call.args, ok: false, error: String(error?.message || error) };
    }
    out.calls.push(entry);
  }
} catch (error) {
  failure = error;
}
// A warm-up or a request still held after the reads goes on now, so the daemon closes as it would have.
if (scenario.holdDir) {
  for (const name of ['release', 'release-endpoint', 'release-load']) if (!existsSync(join(scenario.holdDir, name))) writeFileSync(join(scenario.holdDir, name), '');
}
try {
  await attached?.close();
} catch {}
if (discovery) await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
process.stdout.write(`RESULT ${JSON.stringify(failure ? { name: scenario.name, failed: String(failure?.stack || failure) } : out)}\n`);
process.exit(failure ? 1 : 0);
