// The relay's result frame carries a refusal's structured code (JSON drops an
// Error's custom properties), with the message left as it is for display.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectedFileGrants, executeRemoteFrame } from './remote-methods.ts';

test('a missing selected-file grant answers with its structured code and the unchanged message', async () => {
  const grants = createSelectedFileGrants(() => false);
  const methods = { read: (params) => grants.grantedFile(params[0], 'C:/outside', 'a.txt') };
  const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 7, method: 'read', params: ['dropped'] }));
  assert.deepEqual(frame, {
    id: 7,
    ok: false,
    error: 'The selected-file permission is unavailable.',
    errorCode: 'SELECTED_FILE_GRANT_UNAVAILABLE',
  });
  // A refusal about the path is a different answer and carries no such code.
  const token = grants.rememberFileGrant('C:/outside/a.txt', 's1');
  const mismatch = await executeRemoteFrame(
    { read: (params) => grants.grantedFile(params[0], 'C:/outside', 'b.txt') },
    JSON.stringify({ id: 8, method: 'read', params: [token] })
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.errorCode, undefined);
});
