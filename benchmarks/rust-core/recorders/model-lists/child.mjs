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
// directory watch, one read per change, and one deadline timer.
function untilLogged(text, timeoutMs) {
  const file = join(process.env.MIXDOG_DATA_DIR, 'daemon.log');
  return new Promise((resolve, reject) => {
    const logged = () => existsSync(file) && readFileSync(file, 'utf8').includes(text);
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
  for (const call of scenario.calls) {
    let entry;
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
try {
  await attached?.close();
} catch {}
if (discovery) await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
process.stdout.write(`RESULT ${JSON.stringify(failure ? { name: scenario.name, failed: String(failure?.stack || failure) } : out)}\n`);
process.exit(failure ? 1 : 0);
