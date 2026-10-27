import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('claude-current');
process.env.MIXDOG_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(dataDir, 'anthropic-oauth-models.json'),
  JSON.stringify({
    models: [
      { id: 'claude-opus-4-1', releaseDate: '2025-08-05' },
      { id: 'claude-opus-9-3', releaseDate: '2031-02-01', contextWindow: 3_000_000 },
    ],
  })
);
const { resolveClaudeModelAlias, readClaudeCodeCurrentRoute } = await import('./claude-current.mjs');

test('a family alias resolves to the newest roster model of that family', () => {
  assert.equal(resolveClaudeModelAlias('opus'), 'claude-opus-9-3');
});

test('an explicit [1m] suffix still names a million-token window', () => {
  const route = readClaudeCodeCurrentRoute({ request: { model: 'claude-nova-9[1m]' } });
  assert.equal(route.contextWindow, 1_000_000);
});
