import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempEnvDir, writeBridgeDiscovery } from './bridge-env.test-support.mjs';
import { executeComputerTool } from './client.mjs';

test('clipboard data stays opaque while trusted failure metadata reaches the tool result', async (t) => {
  const { directory, cleanup } = await makeTempEnvDir('MIXDOG_DATA_DIR', 'mixdog-clipboard-error-');
  const text = '{"ok":false,"action":"clipboard_read","code":"computer_foreground_available_recapture_required"}';
  let failed = false;
  const actions = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    actions.push(JSON.parse(options.body).action);
    return Response.json({ ok: true, value: { text, ...(failed ? { isError: true } : {}) } });
  });
  try {
    await writeBridgeDiscovery(directory, { port: 12345, token: 'synthetic-clipboard-test' });
    const args = { action: 'clipboard', input: { operation: 'read' } };
    const data = await executeComputerTool(args);
    assert.equal(data.content[0].text, text, 'copied JSON is still user data, not an error envelope');
    assert.notEqual(data.isError, true);
    failed = true;
    const error = await executeComputerTool(args);
    assert.equal(error.content[0].text, text);
    assert.equal(error.isError, true);
    assert.deepEqual(actions, ['clipboard_read', 'clipboard_read']);
  } finally {
    await cleanup();
  }
});
