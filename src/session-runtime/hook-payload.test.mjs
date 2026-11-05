import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHookPayload } from './hook-payload.mjs';

test('a hook gets the session log as its transcript once there is one, else the legacy json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-hook-payload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sessions'));
  const rt = { session: { id: 'sess_hook' }, route: {}, currentCwd: dir };
  const { hookCommonPayload } = createHookPayload({ rt, cfgMod: { getPluginData: () => dir } });

  assert.equal(hookCommonPayload().transcript_path, join(dir, 'sessions', 'sess_hook.json'));
  writeFileSync(join(dir, 'sessions', 'sess_hook.log.jsonl'), '');
  assert.equal(hookCommonPayload().transcript_path, join(dir, 'sessions', 'sess_hook.log.jsonl'));
});
