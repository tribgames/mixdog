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
  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'clear' }),
    /1 could not be removed; retry clear/,
  );
  const remaining = await scripts.initScriptResult(guest, { operation: 'list' });
  assert.doesNotMatch(remaining.text, /\[is1\]/);
  assert.match(remaining.text, /\[is2\]/);

  failSecondRemoval = false;
  assert.match(
    (await scripts.initScriptResult(guest, { operation: 'clear' })).text,
    /Removed 1 init script/,
  );
});
