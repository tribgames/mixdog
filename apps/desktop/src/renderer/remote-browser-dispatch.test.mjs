import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_BROWSER_FRAME_EVENT, REMOTE_BROWSER_OPEN_EVENT } from '../shared/remote-browser.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const frame = (overrides = {}) => ({
  sessionId: 's1',
  seq: 1,
  frameId: 'f1',
  documentId: 'd1',
  url: 'https://example.test/',
  title: 'T',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 100,
  height: 50,
  viewportWidth: 200,
  viewportHeight: 100,
  image: { mimeType: 'image/jpeg', data: 'AA==' },
  ...overrides,
});

test('browser stream pushes fan out to listeners, authenticated and well-formed only', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const frames = [];
    const opens = [];
    const offFrame = api.onRemoteBrowserFrame((next) => frames.push(next));
    const offOpen = api.onBrowserOpenRequested((request) => opens.push(request));

    ctx.handleMessage({ event: REMOTE_BROWSER_FRAME_EVENT, payload: frame() }, false);
    ctx.handleMessage({ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: 's1' } }, false);
    assert.deepEqual([frames, opens], [[], []], 'clear relay data is ignored');

    await leg.deliver({ event: REMOTE_BROWSER_FRAME_EVENT, payload: frame() });
    await leg.deliver({ event: REMOTE_BROWSER_FRAME_EVENT, payload: frame({ seq: 2, image: undefined }) });
    for (const bad of [
      null,
      'x',
      frame({ sessionId: '' }),
      frame({ documentId: undefined }),
      frame({ seq: 'two' }),
      frame({ viewportWidth: Number.NaN }),
      frame({ image: { mimeType: 'text/html', data: 'AA==' } }),
    ]) {
      await leg.deliver({ event: REMOTE_BROWSER_FRAME_EVENT, payload: bad });
    }
    assert.deepEqual(
      frames.map((next) => next.seq),
      [1, 2]
    );

    await leg.deliver({ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: 's1', reveal: true } });
    await leg.deliver({ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: 's1', hide: true } });
    await leg.deliver({ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId: '' } });
    await leg.deliver({ event: REMOTE_BROWSER_OPEN_EVENT, payload: 'nope' });
    assert.deepEqual(opens, [
      { sessionId: 's1', reveal: true },
      { sessionId: 's1', hide: true },
    ]);

    offFrame();
    offOpen();
    await leg.deliver({ event: REMOTE_BROWSER_FRAME_EVENT, payload: frame({ seq: 3 }) });
    assert.equal(frames.length, 2);
  });
});

test('stream start/stop use call and acks use fire on the fixed relay methods', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const started = api.remoteBrowserStream('s1', { maxWidth: 800, maxHeight: 600 });
    const start = await leg.nextPayload();
    assert.equal(start.method, 'browserRemoteStream');
    assert.deepEqual(start.params, ['s1', { maxWidth: 800, maxHeight: 600 }]);
    await leg.deliver({ id: start.id, ok: true, value: undefined });
    await started;

    api.remoteBrowserStreamAck('s1', 7);
    const ack = await leg.nextPayload();
    assert.equal(ack.method, 'browserRemoteStreamAck');
    assert.deepEqual(ack.params, ['s1', 7]);
    assert.equal(ack.id, undefined, 'ack is fire-and-forget');

    const stopped = api.remoteBrowserStream('s1', null);
    const stop = await leg.nextPayload();
    assert.deepEqual(stop.params, ['s1', null]);
    await leg.deliver({ id: stop.id, ok: true, value: undefined });
    await stopped;
  });
});
