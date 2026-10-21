import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  explicitSessionCwd,
  pwd,
  readLastSessionCwd,
  runWithCwdOverride,
  updateCurrentCwdOverride,
  writeLastSessionCwd,
} from './user-cwd.mjs';

test('a NUL user-cwd.txt or session-cwd sentinel reads as missing, and a rewrite replaces it atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-user-cwd-nul-'));
  const saved = [process.env.MIXDOG_DATA_DIR, process.env.MIXDOG_SESSION_CWD, process.env.MIXDOG_SUPERVISOR_PID];
  process.env.MIXDOG_DATA_DIR = root;
  delete process.env.MIXDOG_SESSION_CWD;
  delete process.env.MIXDOG_SUPERVISOR_PID;
  try {
    writeFileSync(join(root, 'user-cwd.txt'), Buffer.alloc(40));
    assert.equal(explicitSessionCwd(), null);
    writeFileSync(join(root, 'session-cwd-solo.txt'), Buffer.alloc(40));
    assert.equal(readLastSessionCwd(), null);
    writeLastSessionCwd(root);
    assert.equal(readLastSessionCwd(), root);
    assert.equal(readFileSync(join(root, 'session-cwd-solo.txt'), 'utf8'), root);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
      []
    );
  } finally {
    ['MIXDOG_DATA_DIR', 'MIXDOG_SESSION_CWD', 'MIXDOG_SUPERVISOR_PID'].forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test('cwd overrides stay isolated across concurrent inline sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-user-cwd-'));
  const a = join(root, 'a');
  const b = join(root, 'b');
  const next = join(root, 'next');
  mkdirSync(a);
  mkdirSync(b);
  mkdirSync(next);
  try {
    await Promise.all([
      runWithCwdOverride(a, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(pwd(), a);
        assert.equal(explicitSessionCwd(), a);
        assert.equal(updateCurrentCwdOverride(next), true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(pwd(), next);
        assert.equal(explicitSessionCwd(), next);
      }),
      runWithCwdOverride(b, async () => {
        assert.equal(pwd(), b);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(pwd(), b);
        assert.equal(explicitSessionCwd(), b);
      }),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
