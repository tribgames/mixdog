import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveProjectId } from './project-id-resolver.mjs';

function projectWithId(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-project-id-'));
  mkdirSync(join(root, '.mixdog'));
  writeFileSync(join(root, '.mixdog', 'project.id'), bytes);
  return root;
}

test('a NUL-filled project.id is no marker, a real one still resolves', () => {
  const damaged = projectWithId(Buffer.alloc(64));
  const good = projectWithId('my-project\n');
  try {
    assert.equal(resolveProjectId(damaged), null);
    assert.equal(resolveProjectId(good), 'my-project');
  } finally {
    rmSync(damaged, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});
