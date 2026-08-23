import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { _searchRemainingMsForTest } from './native-search-client.mjs';
import { executeFuzzyFindTool } from './list-tool.mjs';
import { runWithLocalSearchTelemetry } from './local-search-telemetry.mjs';

test('server setup is not charged to the search budget', () => {
  const deadline = 1_500;
  const startedAt = 0;
  // 1000ms of the elapsed wall time was server startup: the search itself has
  // not begun, so the full deadline must still be available.
  assert.equal(_searchRemainingMsForTest(deadline, startedAt, 1_000, 1_000), 1_500);
  // Once searching starts, elapsed search time does reduce the budget.
  assert.equal(_searchRemainingMsForTest(deadline, startedAt, 1_000, 1_400), 1_100);
  // No setup recorded means the old behaviour: every elapsed ms counts.
  assert.equal(_searchRemainingMsForTest(deadline, startedAt, 0, 400), 1_100);
  // The budget never goes to zero or negative, which would break timers.
  assert.equal(_searchRemainingMsForTest(deadline, startedAt, 0, 9_000), 1);
});

test('a fuzzy deadline recovers a real candidate through one targeted path scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-find-budget-'));
  try {
    writeFileSync(join(root, 'anchor.txt'), 'anchor\n');
    const timeout = Object.assign(
      new Error('native fuzzy search timed out after 1500ms.'),
      { code: 'NATIVE_SEARCH_TIMEOUT' },
    );
    let targetedEnumerationCalls = 0;
    let targetedArgs = null;
    const telemetry = {};
    const out = String(await runWithLocalSearchTelemetry(telemetry, () => executeFuzzyFindTool(
      { query: 'needle-that-never-ranks', path: '.', head_limit: 5 },
      root,
      {
        __tryServeFuzzySearch: async () => { throw timeout; },
        __runRg: async (args) => {
          targetedEnumerationCalls += 1;
          targetedArgs = args;
          return 'src/needle-that-never-ranks.ts\n';
        },
      },
    )));
    assert.ok(!/^Error[\s:[]/.test(out.trimStart()), `must not surface as a tool failure:\n${out}`);
    assert.match(out, /src\/needle-that-never-ranks\.ts/);
    assert.match(out, /targeted path matches shown/);
    assert.equal(targetedEnumerationCalls, 1);
    assert.ok(targetedArgs.includes('--iglob'), `expected a targeted --iglob scan: ${JSON.stringify(targetedArgs)}`);
    assert.equal(telemetry.native_fuzzy_partials, 1);
    assert.equal(telemetry.native_fuzzy_targeted_hits, 1);
    assert.equal(telemetry.native_fuzzy_errors, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a served partial still reports its ranked matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-find-partial-'));
  try {
    const out = String(await executeFuzzyFindTool(
      { query: 'alpha', path: '.', head_limit: 5 },
      root,
      {
        __tryServeFuzzySearch: async () => ({
          matches: ['src/alpha.ts'],
          hasMore: false,
          totalMatches: 1,
          totalSeen: 1,
          complete: false,
          partial: true,
          timeout: true,
          scanErrors: 0,
          walkErrorDetails: [],
        }),
        __runRg: async () => '',
      },
    ));
    assert.match(out, /src\/alpha\.ts/);
    assert.ok(!/^Error[\s:[]/.test(out.trimStart()), `partials are results, not failures:\n${out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
