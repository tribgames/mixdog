// Regression: a full disk while the daemon makes the session store folder must not end the daemon at migration start.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-migration-start-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
// This process is the live daemon owner, so the migration really starts.
writeFileSync(join(root, 'daemon-owner.json'), JSON.stringify({ kind: 'mixdog-daemon', pid: process.pid }));

const { startSessionLogMigration } = await import('./session-log-startup.mjs');

test('a migration start that hits a full disk making the store folder is logged and resolves, never throws', async (t) => {
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = (path, ...rest) => {
    if (String(path).endsWith('sessions')) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${path}'`), { code: 'ENOSPC' });
    }
    return realMkdir(path, ...rest);
  };
  syncBuiltinESMExports();
  const lines = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    fs.mkdirSync = realMkdir;
    syncBuiltinESMExports();
    process.stderr.write = realWrite;
  });
  let started;
  assert.doesNotThrow(() => {
    started = startSessionLogMigration();
  });
  assert.equal(await started, null);
  assert.ok(lines.some((line) => /\[session-log-migration\] failed: ENOSPC/.test(line)), lines.join(''));
});
