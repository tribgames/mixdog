// A core killed outright (its process tree ended at once, as `taskkill /T /F` ends it: a crash, a forced end) leaves its folders to the
// next core, which comes up on them and serves. Node's reference: the daemon's ownership of its data dir is an OS-held lock the kernel
// drops however the process ends, "so the next daemon acquires it at once" (b6f10295a src/standalone/daemon-owner-lock.mjs:1-4).
//   MIXDOGD_EXE=<built mixdogd.exe> node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//     --test benchmarks/rust-core/recorders/lib/core-restart-after-kill.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { endCore, spawnCore } from './core-stop.mjs';
import { answered, killTree, startCore } from './phone-files-replay.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-core-restart-after-kill`);
const START_DEADLINE_MS = 120_000;
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

/** Starts `exe serve` with `env` on folders left exactly as they are (startCore removes the discovery file first; this removes
 *  nothing): up once `runtime/daemon.json` holds anything but what the killed core left there. */
async function restartUntouched(exe, root, env) {
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const dir = join(root, 'runtime');
  const file = join(dir, 'daemon.json');
  const stale = readFileSync(file, 'utf8');
  const { child, job } = await spawnCore(exe, ['serve'], { env });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const core = { exe, child, job, env };
  let watcher = null;
  let timer = null;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const look = () => {
        if (child.exitCode !== null) return reject(new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`));
        try {
          const text = readFileSync(file, 'utf8');
          if (text !== stale) resolve(parseDiscovery(text));
        } catch {
          // Being rewritten: the next change looks again.
        }
      };
      watcher = watch(dir, look);
      child.once('exit', look);
      timer = setTimeout(() => reject(new Error(`mixdogd did not rewrite ${file} within ${START_DEADLINE_MS / 1000} s:\n${stderr}`)), START_DEADLINE_MS);
      look();
    });
    return { ...core, endpoint };
  } catch (error) {
    await endCore(core).catch((ending) => (error.message += `\nand ending it: ${ending.message}`));
    throw error;
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}

/** Connects to `core` as the desktop does and asks it for its MCP servers: the answer, or the failure. */
async function serves(core) {
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const client = await answered('the connection (initialize)', connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => core.endpoint),
    clientInfo: { name: 'mixdog-restart-test', title: 'Mixdog', version: '1.4.5', kind: 'desktop' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.reject(new Error('the test dropped its connection')) },
    random: Math.random,
  }));
  try {
    return await answered('mcp/mcpStatus', client.call('mcp/mcpStatus', {}));
  } finally {
    client.close?.();
  }
}

test('a core started on the folders of a killed core comes up and serves', { timeout: 600_000 }, async () => {
  const exe = process.env.MIXDOGD_EXE;
  assert.ok(exe, 'MIXDOGD_EXE names the built mixdogd');
  const root = join(WORLDS, 'core');
  const first = await startCore(exe, root, null);
  let second = null;
  try {
    assert.ok(await serves(first), 'the first core serves');
    // Killed the way a crash ends it: no stop request, its tree ended at once.
    await killTree(first.child);
    assert.ok(existsSync(join(root, 'runtime', 'daemon.json')), 'the killed core left its discovery file');
    const started = Date.now();
    // Nothing of the folders is removed: the killed core's discovery file, locks and database stay as the crash left them.
    second = await restartUntouched(exe, root, first.env);
    const status = await serves(second);
    console.log(`the second core served ${Date.now() - started} ms after its start on the killed core's folders`);
    assert.ok(status?.servers, `the second core's answer: ${JSON.stringify(status)}`);
  } finally {
    const ending = [];
    if (second) await endCore(second).catch((error) => ending.push(`the second core: ${error.message}`));
    // What the killed core left in its job (a database it started outside its tree) ends with that job.
    await first.job.end(0, Date.now() + 10_000).catch((error) => ending.push(`the first core's job: ${error.message}`));
    await first.job.close(Date.now() + 10_000).catch((error) => ending.push(`the first core's job: ${error.message}`));
    rmSync(WORLDS, { recursive: true, force: true });
    assert.deepEqual(ending, [], 'the cores and what they started ended cleanly');
  }
});
