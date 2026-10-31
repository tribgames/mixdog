import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const calls = [];
mock.module(new URL('../../runtime/media/tool.mjs', import.meta.url).href, {
  namedExports: {
    executeMediaTool: async (args, opts) => {
      calls.push(opts);
      return { ok: true };
    },
  },
});
mock.module(new URL('../../runtime/agent/orchestrator/session/manager/session-crud.mjs', import.meta.url).href, {
  namedExports: { getSession: (id) => (id === 'caller-session' ? { sourceType: 'schedule' } : null) },
});
const { createFeatureToolHandlers } = await import('./feature-tools.mjs');

test('media generation is attributed to the calling session and its source', async () => {
  const handlers = createFeatureToolHandlers({
    rt: { session: null },
    setupTool: {},
  });
  await handlers.media({ action: 'generate' }, { callerCtx: { sessionId: 'caller-session' }, callerCwd: 'C:/work' });
  assert.equal(calls[0].sessionId, 'caller-session');
  assert.equal(calls[0].sourceType, 'schedule');
});
