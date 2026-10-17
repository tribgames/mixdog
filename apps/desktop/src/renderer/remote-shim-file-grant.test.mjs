// A relay result frame's `errorCode` is put back on the rebuilt Error, and the
// grant refresh acts on that code rather than on the message text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};

const FILE = 'C:/outside/report.txt';

async function openAfterRefusal(refusal) {
  return withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    const leg = await shim.dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    const pending = api.readProjectFile('C:/outside', 'report.txt', 'held').catch((error) => error);
    const first = await nextCall(leg, 'readProjectFile');
    await leg.deliver({ id: first.id, ok: false, ...refusal });
    const next = await Promise.race([nextCall(leg, 'resolveLocalPaths'), pending.then(() => null)]);
    if (!next) return { result: await pending, regranted: false };
    assert.deepEqual(next.params, [[FILE], null, { anyConversation: true }]);
    await leg.deliver({
      id: next.id,
      ok: true,
      value: [{ absolutePath: FILE, projectPath: 'C:/outside', relPath: 'report.txt', accessToken: 'fresh' }],
    });
    const retry = await nextCall(leg, 'readProjectFile');
    assert.deepEqual(retry.params.slice(0, 3), ['C:/outside', 'report.txt', 'fresh']);
    await leg.deliver({ id: retry.id, ok: true, value: { content: 'linked report' } });
    return { result: await pending, regranted: true };
  });
}

test('a relay refusal frame with the grant code is granted again, whatever its message says', async () => {
  const { result, regranted } = await openAfterRefusal({
    error: 'That link has lapsed.',
    errorCode: 'SELECTED_FILE_GRANT_UNAVAILABLE',
  });
  assert.equal(regranted, true);
  assert.equal(result.content, 'linked report');
});

test('a relay refusal frame with another code passes through even when its message names the grant', async () => {
  const { result, regranted } = await openAfterRefusal({
    error: 'The selected-file permission is unavailable.',
    errorCode: 'EACCES',
  });
  assert.equal(regranted, false);
  assert.equal(result.code, 'EACCES');
});
