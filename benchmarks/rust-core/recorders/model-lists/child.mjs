// Child of record.mjs: one Node daemon in the isolated env it was started in; records the model-list reads.
//   node --experimental-transform-types child.mjs <nodeTree> <workspace> <scenario.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeTree, workspace, scenarioFile] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const client = await import(pathToFileURL(join(nodeTree, 'src', 'standalone', 'session-client.mjs')).href);
const out = { name: scenario.name, calls: [] };
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
  for (const call of scenario.calls) {
    let entry;
    try {
      const reply = await attached.call('session.read', { sessionId, action: call.action, args: call.args, open, baseRevision: null });
      entry = { action: call.action, args: call.args, ok: true, value: reply?.value };
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
