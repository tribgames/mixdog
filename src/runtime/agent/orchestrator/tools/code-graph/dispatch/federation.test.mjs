import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _notSelf } from './federation.mjs';

test('a cwd is never a federation child of itself, in whatever case Windows spells it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'Fed-Self-'));
  try {
    const keep = _notSelf(cwd);
    assert.equal(keep(cwd), false);
    assert.equal(keep(join(cwd, '.')), false);
    assert.equal(keep(join(cwd, 'child')), true);
    // The graph cache keys a root lowercased; on Windows that spelling is the same directory.
    assert.equal(keep(cwd.toLowerCase()), process.platform !== 'win32');
    assert.equal(keep(cwd.toUpperCase()), process.platform !== 'win32');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
