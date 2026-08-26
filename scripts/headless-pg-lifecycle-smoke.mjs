import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPristineExecutionBoundary } from '../src/runtime/shared/pristine-execution.mjs';
import { isPidAlive } from '../src/runtime/shared/pid-liveness.mjs';
import {
  getStandaloneMemoryRuntime,
  stopStandaloneMemoryRuntimesForProcess,
} from '../src/standalone/memory-runtime-proxy.mjs';

const memoryEntry = fileURLToPath(new URL('../src/runtime/memory/index.mjs', import.meta.url));
const boundary = createPristineExecutionBoundary({
  provider: 'openai',
  model: 'gpt-test',
  apiKeyResolver: () => 'lifecycle-smoke-key',
});
let stopped = false;

try {
  assert.equal(boundary.runtimeRoot.startsWith(boundary.rootDir), true);
  assert.equal(process.env.MIXDOG_DAEMON_SKIP_MEMORY, '1');
  assert.equal(process.env.MIXDOG_DISABLE_MEMORY_INGEST, '1');

  const runtime = getStandaloneMemoryRuntime({
    entry: memoryEntry,
    dataDir: boundary.dataDir,
    cwd: process.cwd(),
  });
  await runtime.init();

  const postmasterPidPath = `${boundary.dataDir}/pgdata/postmaster.pid`;
  const postmasterPid = Number(readFileSync(postmasterPidPath, 'utf8').split(/\r?\n/, 1)[0]);
  assert.equal(isPidAlive(postmasterPid), true);

  await stopStandaloneMemoryRuntimesForProcess({ waitForExit: true, timeoutMs: 20_000 });
  stopped = true;
  assert.equal(isPidAlive(postmasterPid), false);

  boundary.cleanup();
  assert.equal(existsSync(boundary.rootDir), false);
  process.stdout.write(`headless PG lifecycle smoke OK pid=${postmasterPid}\n`);
} finally {
  if (!stopped) {
    try {
      await stopStandaloneMemoryRuntimesForProcess({ waitForExit: true, timeoutMs: 20_000 });
    } catch {}
  }
  if (existsSync(boundary.rootDir)) {
    try { boundary.cleanup({ tolerateRootRemovalFailure: true }); } catch {}
  }
}
