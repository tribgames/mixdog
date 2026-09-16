import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserInitScripts } from './init-scripts.ts';

test('init script clear preserves only transient failures so cleanup can be retried', async () => {
  const guest = {};
  let identifier = 0;
  let failSecondRemoval = true;
  const scripts = createBrowserInitScripts({
    cdp: {
      call: async (_guest, method, params) => {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          identifier += 1;
          return { identifier: `cdp-${identifier}` };
        }
        if (params.identifier === 'cdp-2' && failSecondRemoval) {
          throw new Error('fixture transient failure');
        }
        return {};
      },
    },
  });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.one = 1;' });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.two = 2;' });
  await assert.rejects(scripts.initScriptResult(guest, { operation: 'clear' }), /1 could not be removed; retry clear/);
  const remaining = await scripts.initScriptResult(guest, { operation: 'list' });
  assert.doesNotMatch(remaining.text, /\[is1\]/);
  assert.match(remaining.text, /\[is2\]/);

  failSecondRemoval = false;
  assert.match((await scripts.initScriptResult(guest, { operation: 'clear' })).text, /Removed 1 init script/);
});

test('only Chromium script absence counts as removal; transport failures retain handles and their reason', async () => {
  for (const message of [
    'Session with given id not found',
    'target not found',
    'unknown identifier',
    'Script not found',
  ]) {
    for (const operation of ['remove', 'clear']) {
      const guest = {};
      let failure = message;
      const scripts = createBrowserInitScripts({
        cdp: {
          call: async (_guest, method) => {
            if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'cdp-script' };
            if (failure) throw new Error(failure);
            return {};
          },
        },
      });
      await scripts.initScriptResult(guest, { operation: 'add', script: 'window.fixture = 1' });
      const command = { operation, ...(operation === 'remove' ? { scriptId: 'is1' } : {}) };
      if (message === 'Script not found') {
        await scripts.initScriptResult(guest, command);
      } else {
        await assert.rejects(scripts.initScriptResult(guest, command), (error) => error.message.includes(message));
        assert.match((await scripts.initScriptResult(guest, { operation: 'list' })).text, /\[is1\]/);
        failure = '';
        await scripts.initScriptResult(guest, command);
      }
      assert.match((await scripts.initScriptResult(guest, { operation: 'list' })).text, /No init scripts/);
    }
  }
});

test('cancellation after a successful script mutation updates the ledger but never reports success', async () => {
  const guest = {};
  let cancel = () => {};
  let calls = 0;
  const scripts = createBrowserInitScripts({
    cdp: {
      call: async (_guest, method) => {
        calls++;
        cancel();
        return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'cdp-script' } : {};
      },
    },
  });
  const controller = new AbortController();
  const reason = new Error('cancel after registration');
  cancel = () => controller.abort(reason);
  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'add', script: 'window.fixture = 1' }, controller.signal),
    (error) => error === reason
  );
  assert.match((await scripts.initScriptResult(guest, { operation: 'list' })).text, /\[is1\]/);
  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'clear' }, controller.signal),
    (error) => error === reason
  );
  assert.equal(calls, 1);
  const removing = new AbortController();
  cancel = () => removing.abort(reason);
  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'clear' }, removing.signal),
    (error) => error === reason
  );
  assert.match((await scripts.initScriptResult(guest, { operation: 'list' })).text, /No init scripts/);
});
