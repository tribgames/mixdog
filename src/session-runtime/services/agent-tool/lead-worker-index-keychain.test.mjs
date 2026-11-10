// A Lead turn upserts its pool row when it starts and again when it settles.
// Neither may load secrets or spawn the macOS keychain on the main thread.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-keychain-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');

const spawned = [];
childProcess.spawnSync = (cmd, args) => {
  spawned.push([cmd, ...args]);
  return { status: 44, stdout: '', stderr: '' };
};
Object.defineProperty(process, 'platform', { value: 'darwin' });

const realCfg = await import('../../../runtime/agent/orchestrator/config.mjs');
const { flushAllIndexWrites } = await import('./index-write-queue.mjs');
const { createLeadWorkerIndex } = await import('./lead-worker-index.mjs');

after(async () => {
  await flushAllIndexWrites();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('a Lead turn start and settle load no secrets and spawn no keychain process', async () => {
  const loads = [];
  // As the runtime wires it: the agent tool's loadConfig is the snapshot.
  const cfgMod = {
    ...realCfg,
    loadConfig: (options) => {
      loads.push(options);
      return realCfg.getConfigSnapshot(options);
    },
  };
  const index = createLeadWorkerIndex({
    dataDir: root,
    cfgMod,
    workerRowFromSession: (session, tag, extra) => ({ sessionId: session.id, tag, ...extra }),
  });
  const session = { id: 'lead_keychain', owner: 'user', agent: 'lead', closed: false, messages: [] };
  try {
    index.upsertLeadSession(session, { status: 'running', stage: 'running' });
    index.upsertLeadSession(session, { status: 'idle', stage: 'idle' });
    await index.flushLeadWorkerIndexWrites();
  } finally {
    index.dispose();
  }
  assert.ok(loads.length > 0, 'the config was read');
  assert.ok(
    loads.every((options) => options?.secrets === false),
    'every read leaves the secrets out'
  );
  assert.deepEqual(spawned, [], 'no synchronous security(1) spawn');
});
