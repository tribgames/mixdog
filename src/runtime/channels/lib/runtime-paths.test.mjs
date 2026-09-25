import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousRoot = process.env.MIXDOG_RUNTIME_ROOT;
const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-paths-'));
process.env.MIXDOG_RUNTIME_ROOT = root;
const { cleanupStaleRuntimeFiles, readActiveInstance } = await import('./runtime-paths.mjs');
after(() => {
  if (previousRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const DEAD_PID = 999_999;

test('stale runtime cleanup removes records of dead pids and expired status files, keeping live ones', () => {
  mkdirSync(join(root, 'owners'), { recursive: true });
  const files = {
    deadHeartbeat: join(root, `supervisor-heartbeat.${DEAD_PID}.json`),
    liveHeartbeat: join(root, `supervisor-heartbeat.${process.pid}.json`),
    deadServer: join(root, 'server-dead.pid'),
    liveServer: join(root, 'server-live.pid'),
    expiredStatus: join(root, 'status-old.json'),
    freshStatus: join(root, 'status-new.json'),
    deadOwner: join(root, 'owners', 'dead.json'),
    liveOwner: join(root, 'owners', 'live.json'),
  };
  writeFileSync(files.deadHeartbeat, '{}');
  writeFileSync(files.liveHeartbeat, '{}');
  writeFileSync(files.deadServer, String(DEAD_PID));
  writeFileSync(files.liveServer, String(process.pid));
  writeFileSync(files.expiredStatus, '{}');
  writeFileSync(files.freshStatus, '{}');
  writeFileSync(files.deadOwner, JSON.stringify({ pid: DEAD_PID }));
  writeFileSync(files.liveOwner, JSON.stringify({ instanceId: String(process.pid) }));
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(files.expiredStatus, sevenHoursAgo, sevenHoursAgo);

  cleanupStaleRuntimeFiles();

  const present = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, existsSync(path)]));
  assert.deepEqual(present, {
    deadHeartbeat: false,
    liveHeartbeat: true,
    deadServer: false,
    liveServer: true,
    expiredStatus: false,
    freshStatus: true,
    deadOwner: false,
    liveOwner: true,
  });
});

test('active instance read returns the advert or null when absent', () => {
  const advert = join(root, 'active-instance.json');
  rmSync(advert, { force: true });
  assert.equal(readActiveInstance(), null);
  writeFileSync(advert, JSON.stringify({ instanceId: '42' }));
  assert.deepEqual(readActiveInstance(), { instanceId: '42' });
});
