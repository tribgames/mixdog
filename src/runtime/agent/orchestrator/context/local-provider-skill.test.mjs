import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectPromptSkillsCached, invalidateSkillsCache, loadSkillResource } from './collect.mjs';

test('local-provider bootstrap skill is discoverable and loadable without an installed feature', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-skill-'));
  const previous = { data: process.env.MIXDOG_DATA_DIR, root: process.env.MIXDOG_ROOT };
  process.env.MIXDOG_DATA_DIR = root;
  process.env.MIXDOG_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    invalidateSkillsCache();
    const skill = collectPromptSkillsCached(root).find((entry) => entry.name === 'local-provider');
    assert.ok(skill, 'installation guidance must be available on a fresh profile');
    const loaded = loadSkillResource('local-provider', root);
    assert.ok(loaded.content.length > 0);
  } finally {
    invalidateSkillsCache();
    if (previous.data === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous.data;
    if (previous.root === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previous.root;
    rmSync(root, { recursive: true, force: true });
  }
});
