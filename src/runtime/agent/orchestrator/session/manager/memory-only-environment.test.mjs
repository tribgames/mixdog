import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshSessionBp3Environment } from './prompt-utils.mjs';

test('legacy project instructions cannot reenter either session environment layout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-memory-only-'));
  try {
    mkdirSync(join(cwd, '.mixdog'));
    writeFileSync(join(cwd, '.mixdog', 'instructions.md'), 'RETIRED_PROJECT_INSTRUCTION');
    for (const split of [true, false]) {
      const session = {
        owner: 'cli', model: 'test', cwd,
        bp3EnvSplit: split, bp3CoreContext: '# Core Memory\n- User-authored memory',
        bp3EnvironmentContext: 'Environment',
        messages: [{ role: 'system', cacheTier: split ? 'env' : 'tier3', content: 'old' }],
      };
      refreshSessionBp3Environment(session, cwd);
      const text = session.messages.map(message => message.content).join('\n');
      assert.doesNotMatch(text, /RETIRED_PROJECT_INSTRUCTION/);
      assert.match(text, /Environment/);
      if (!split) assert.match(text, /User-authored memory/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
