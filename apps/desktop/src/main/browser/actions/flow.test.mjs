import assert from 'node:assert/strict';
import test from 'node:test';
import { flowActions } from './flow.ts';
import { createBrowserSettle } from '../settle.ts';
import { createBrowserChangeLatch } from '../document-changes.ts';

function fixture(command, pageText, snapshotResult = async () => ({ text: 'Observed' })) {
  let closes = 0;
  const context = {
    guest: { getURL: () => 'https://fixture.example/Complete' },
    command: { action: 'wait', ...command },
    services: {
      documents: {
        pageText,
        observeChanges: async () => ({
          latch: createBrowserChangeLatch(),
          close: async () => {
            closes++;
          },
        }),
      },
      reply: { snapshotResult },
    },
  };
  return { context, closes: () => closes };
}

test('wait and expect use the same text and URL conditions, without reading text for a URL-only wait', async () => {
  for (const expected of [{ text: 'SAVED', textGone: 'Loading', url: '/complete' }, { url: '/COMPLETE' }]) {
    const pageText = async () => {
      assert.ok(expected.text, 'URL-only conditions must not read inaccessible frame text');
      return 'Saved successfully';
    };
    const f = fixture(expected, pageText);
    const settle = createBrowserSettle({ pageText });
    assert.equal(await settle.postconditionMatchesGuest(f.context.guest, expected), true);
    assert.match((await flowActions.wait(f.context)).text, /Condition met/);
    assert.equal(f.closes(), 1);
  }
});

test('wait timeouts retain both observation and final snapshot failure reasons', async () => {
  const f = fixture(
    { textGone: 'Saving', timeoutMs: 500 },
    async () => {
      throw new Error('frame unavailable');
    },
    async () => {
      throw new Error('snapshot unavailable');
    }
  );
  await assert.rejects(flowActions.wait(f.context), (error) => {
    assert.match(error.message, /Wait timed out after 500ms/);
    assert.match(error.message, /Page observation failed: frame unavailable/);
    assert.match(error.message, /Final snapshot failed: snapshot unavailable/);
    return true;
  });
  assert.equal(f.closes(), 1);
});

test('wait cancellation preserves the reason and closes observation without taking a final snapshot', async () => {
  const controller = new AbortController();
  const reason = new Error('user takeover');
  const f = fixture(
    { text: 'Saved' },
    async () => {
      controller.abort(reason);
      throw reason;
    },
    async () => assert.fail('cancellation must not enter diagnostic snapshot recovery')
  );
  f.context.signal = controller.signal;
  await assert.rejects(flowActions.wait(f.context), (error) => error === reason);
  assert.equal(f.closes(), 1);
});

test('wait and expect cannot combine a previous URL with text collected after navigation', async () => {
  for (const mode of ['wait', 'expect']) {
    let url = 'https://fixture.example/expected';
    let reads = 0;
    const pageText = async () => {
      reads++;
      url = 'https://fixture.example/other';
      return 'Saved';
    };
    const expected = { text: 'Saved', textGone: 'Saving', url: '/expected', timeoutMs: 500 };
    const f = fixture({ ...expected, internalStep: true }, pageText);
    f.context.guest.getURL = () => url;
    if (mode === 'wait') {
      await assert.rejects(flowActions.wait(f.context), /Wait timed out.*\n\nPage URL changed/s);
      assert.equal(f.closes(), 1);
    } else {
      const settle = createBrowserSettle({ pageText });
      assert.equal(await settle.postconditionMatchesGuest(f.context.guest, expected), false);
    }
    assert.equal(reads, 1, 'a mismatched URL must not trigger another page-text read');
  }
});

test('a stable observation after navigation can satisfy the condition without replaying an action', async () => {
  let url = 'https://fixture.example/before';
  let reads = 0;
  const f = fixture({ textGone: 'Saving', timeoutMs: 500, internalStep: true }, async () => {
    reads++;
    url = 'https://fixture.example/after';
    return 'Saved';
  });
  f.context.guest.getURL = () => url;
  assert.match((await flowActions.wait(f.context)).text, /Condition met/);
  assert.equal(reads, 2, 'the changed-URL result is discarded, not treated as an empty document');
  assert.equal(f.closes(), 1);
});

test('wait preserves cancellation arriving with a successful read, cleanup, or final snapshot', async () => {
  for (const phase of ['read', 'close', 'snapshot', 'timeout-snapshot']) {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${phase}`);
    let snapshots = 0;
    const f = fixture(
      { text: 'Saved', timeoutMs: 500, internalStep: phase === 'read' || phase === 'close' },
      async () => {
        if (phase === 'read') controller.abort(reason);
        return phase === 'timeout-snapshot' ? 'Saving' : 'Saved';
      },
      async () => {
        snapshots++;
        controller.abort(reason);
        return { text: 'Observed' };
      }
    );
    if (phase === 'close') {
      const observe = f.context.services.documents.observeChanges;
      f.context.services.documents.observeChanges = async () => {
        const observation = await observe();
        return {
          ...observation,
          close: async () => {
            await observation.close();
            controller.abort(reason);
          },
        };
      };
    }
    f.context.signal = controller.signal;
    await assert.rejects(flowActions.wait(f.context), (error) => error === reason);
    assert.equal(f.closes(), 1);
    assert.equal(snapshots, phase.includes('snapshot') ? 1 : 0);
  }
});

test('pre-cancelled conditions and cancellation during a successful expect read never report a match', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel before observation');
  controller.abort(reason);
  const f = fixture({ url: '/Complete' }, async () => assert.fail('cancelled read'));
  f.context.signal = controller.signal;
  f.context.services.documents.observeChanges = async () => assert.fail('cancelled observer setup');
  await assert.rejects(flowActions.wait(f.context), (error) => error === reason);
  assert.equal(f.closes(), 0);
  await assert.rejects(
    createBrowserSettle({}).postconditionMatchesGuest(f.context.guest, { url: '/Complete' }, controller.signal),
    (error) => error === reason
  );

  const reading = new AbortController();
  const settle = createBrowserSettle({
    pageText: async () => {
      reading.abort(reason);
      return 'Saved';
    },
  });
  await assert.rejects(
    settle.postconditionMatchesGuest(f.context.guest, { text: 'Saved' }, reading.signal),
    (error) => error === reason
  );
});
