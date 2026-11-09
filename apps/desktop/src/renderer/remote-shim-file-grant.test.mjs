// A refusal's `code` is what the grant refresh acts on, not the message text: the adapter's error carries the core's code and the page
// links the file again only for the grant code.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const FILE = 'C:/outside/report.txt';

async function openAfterRefusal(refusal) {
  let reads = 0;
  const handlers = {
    readProjectFile: (params) => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error(refusal.error), { code: refusal.errorCode });
      assert.deepEqual(params.slice(0, 3), ['C:/outside', 'report.txt', 'fresh']);
      return { content: 'linked report' };
    },
    resolveLocalPaths: (params) => {
      assert.deepEqual(params, [[FILE], null, { anyConversation: true }]);
      return [{ absolutePath: FILE, projectPath: 'C:/outside', relPath: 'report.txt', accessToken: 'fresh' }];
    },
  };
  return withPhoneApi(handlers, async ({ api, calls }) => {
    const result = await api.readProjectFile('C:/outside', 'report.txt', 'held').catch((error) => error);
    return { result, regranted: calls.some((call) => call.method === 'resolveLocalPaths') };
  });
}

test('a refusal with the grant code is granted again, whatever its message says', async () => {
  const { result, regranted } = await openAfterRefusal({ error: 'That link has lapsed.', errorCode: 'SELECTED_FILE_GRANT_UNAVAILABLE' });
  assert.equal(regranted, true);
  assert.equal(result.content, 'linked report');
});

test('a refusal with another code passes through even when its message names the grant', async () => {
  const { result, regranted } = await openAfterRefusal({ error: 'The selected-file permission is unavailable.', errorCode: 'EACCES' });
  assert.equal(regranted, false);
  assert.equal(result.code, 'EACCES');
});
