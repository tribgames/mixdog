import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parallel agent routes flush in one atomic batch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-route-batch-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const {
      flushAgentStatuslineRoutes,
      writeAgentStatuslineRoute,
    } = await import(`../src/standalone/agent-tool/helpers.mjs?batch=${Date.now()}`);
    const {
      readGatewaySessionRoute,
    } = await import('../src/vendor/statusline/src/gateway/session-routes.mjs');

    const count = 48;
    for (let i = 0; i < count; i += 1) {
      assert.equal(writeAgentStatuslineRoute(`sess_route_batch_${i}`, {
        id: 'worker',
        name: 'Worker',
        provider: 'openai-oauth',
        model: 'gpt-5.5',
      }), true);
    }
    assert.equal(flushAgentStatuslineRoutes(), true);

    const routes = Array.from({ length: count }, (_, i) =>
      readGatewaySessionRoute(`sess_route_batch_${i}`));
    assert.equal(routes.every((route) => route?.defaultProvider === 'openai-oauth'), true);
    assert.equal(new Set(routes.map((route) => route?.updatedAt)).size, 1);
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
