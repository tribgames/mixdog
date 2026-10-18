import assert from 'node:assert/strict';
import test from 'node:test';

import { publishedCeilings, settle, withShim } from './remote-shim-test-harness.mjs';

test('boot reads leave with the channel; only the reads the sync owns wait for it', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const { prefetchBootReads } = await import('./remote-shim-calls.ts');
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    // A busy PC: the view sync has not landed.
    ctx.peerViewSync = true;
    ctx.viewSync.ready = () => new Promise(() => {});
    const sentBefore = leg.ws.sent.length;
    prefetchBootReads(ctx, [
      ['getSnapshot', []],
      ['listProjects', []],
      ['readSettings', []],
      ['readHostDisplayPreferences', []],
    ]);
    await settle();
    const methods = [];
    // Decrypted in wire order from the first frame after the hello.
    for (const [index, frame] of leg.ws.sent.slice(1).entries()) {
      const { method } = await leg.server.decryptJson(frame);
      if (index + 1 >= sentBefore) methods.push(method);
    }
    assert.deepEqual(methods.sort(), ['readHostDisplayPreferences', 'readSettings']);
  });
});
