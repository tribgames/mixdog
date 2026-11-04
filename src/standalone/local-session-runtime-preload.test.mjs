import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// The modules a session open imports lazily once the runtime graph is loaded:
// the runtime boot's batch and the agent loop the reservation prewarms.
const OPEN_PATH = `
import module from 'node:module';
const { warmLocalSessionRuntime } = await import(${JSON.stringify(new URL('./local-session-runtime.mjs', import.meta.url).href)});
if ((await warmLocalSessionRuntime()) !== true) throw new Error('warm-up failed');
const loaded = [];
module.registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:')) loaded.push(url);
    return next(url, context);
  },
});
const { loadRuntimeModules } = await import(${JSON.stringify(new URL('../session-runtime/runtime-bootstrap.mjs', import.meta.url).href)});
const { prewarmAgentLoop } = await import(${JSON.stringify(new URL('../runtime/agent/orchestrator/session/manager/runtime-loaders.mjs', import.meta.url).href)});
await loadRuntimeModules();
await prewarmAgentLoop();
process.stdout.write(JSON.stringify(loaded));
process.exit(0);
`;

// A fresh process, so the module cache holds only what the warm-up loaded.
test('after the daemon warm-up, the session-open path loads no module of the runtime graph', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-preload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', OPEN_PATH], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      MIXDOG_HOME: join(root, 'home'),
      MIXDOG_DATA_DIR: join(root, 'data'),
      MIXDOG_CONFIG_DIR: join(root, 'config'),
      MIXDOG_DISABLE_MCP: '1',
    },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.deepEqual(JSON.parse(stdout), []);
});
