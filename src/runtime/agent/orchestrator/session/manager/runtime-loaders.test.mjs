import assert from 'node:assert/strict';
import test from 'node:test';

import { _getAgentLoop, prewarmAgentLoop, setAgentLoopImporterForTest } from './runtime-loaders.mjs';

test('a failed agent-loop preload is retried by the next load', async (t) => {
  t.after(() => setAgentLoopImporterForTest(null));
  let attempts = 0;
  const agentLoop = () => {};
  setAgentLoopImporterForTest(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('preload failed');
    return { agentLoop };
  });
  await assert.rejects(prewarmAgentLoop(), /preload failed/);
  assert.equal(await _getAgentLoop(), agentLoop);
  assert.equal(attempts, 2);
});
