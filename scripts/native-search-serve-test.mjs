// Resident native search server. `mixdog-graph --serve-search` answers the
// rg-arg subset the grep builder emits; anything else must degrade to the
// real rg spawn with byte-identical tool output. Requires a locally built
// dev binary — the test SKIPS (pass) when it is absent so CI without cargo
// stays green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL(
  '../native/mixdog-graph/target/release/mixdog-graph.exe', import.meta.url,
));
const TARGET = fileURLToPath(new URL('../src/standalone', import.meta.url));

if (!existsSync(BIN)) {
  test('native search serve (skipped: dev binary not built)', () => {});
} else {
  process.env.MIXDOG_SEARCH_SERVER_BIN = BIN;
  const { executeGrepTool } = await import(
    '../src/runtime/agent/orchestrator/tools/builtin/search-tool.mjs'
  );

  const CASES = [
    { pattern: 'createSessionService', head_limit: 20 },
    { pattern: 'createSessionService', head_limit: 20, context: 2 },
    { pattern: ['subscribeSession', 'unsubscribeSession', 'pendingViewers'], head_limit: 15, context: 2 },
    { pattern: 'zqxv_nomatch_1', head_limit: 20 },
    { pattern: 'sessionOwner', head_limit: 5, output_mode: 'files_with_matches' },
  ];

  test('served grep output is byte-identical to the rg spawn path', async () => {
    for (const args of CASES) {
      process.env.MIXDOG_SEARCH_SERVER = '0';
      const viaRg = await executeGrepTool({ ...args, path: TARGET }, TARGET, null);
      delete process.env.MIXDOG_SEARCH_SERVER;
      const viaServer = await executeGrepTool({ ...args, path: TARGET }, TARGET, null);
      assert.equal(viaServer, viaRg, `parity for ${JSON.stringify(args.pattern)}`);
    }
  });

  test('a broken server binary degrades to the rg spawn path', async () => {
    const { tryServeSearch, _resetNativeSearchClientForTest } = await import(
      '../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs'
    );
    _resetNativeSearchClientForTest();
    process.env.MIXDOG_SEARCH_SERVER_BIN = `${BIN}.does-not-exist`;
    try {
      const served = await tryServeSearch(['-e', 'sessionOwner', '--', TARGET], { cwd: TARGET }, { offset: 0, limit: 10 });
      assert.equal(served, null, 'unavailable server yields null (caller spawns rg)');
      const out = await executeGrepTool({ pattern: 'sessionOwner', path: TARGET, head_limit: 5 }, TARGET, null);
      assert.match(out, /sessionOwner/);
    } finally {
      process.env.MIXDOG_SEARCH_SERVER_BIN = BIN;
      _resetNativeSearchClientForTest();
    }
  });
}
