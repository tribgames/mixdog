// A core killed outright (its process tree ended at once, as `taskkill /T /F` ends it: a crash, a forced end) leaves its folders to the
// next core, which comes up on them and serves. Node's reference: the daemon's ownership of its data dir is an OS-held lock the kernel
// drops however the process ends, "so the next daemon acquires it at once" (b6f10295a src/standalone/daemon-owner-lock.mjs:1-4).
//   MIXDOGD_EXE=<built mixdogd.exe> node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//     --test benchmarks/rust-core/recorders/lib/core-restart-after-kill.test.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { endCore } from './core-stop.mjs';
import { answered, killTree, startCore } from './phone-files-replay.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-core-restart-after-kill`);
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

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
    const started = Date.now();
    second = await startCore(exe, root, null, false);
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
