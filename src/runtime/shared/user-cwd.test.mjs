import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  explicitSessionCwd,
  pwd,
  runWithCwdOverride,
  updateCurrentCwdOverride,
} from './user-cwd.mjs';

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
