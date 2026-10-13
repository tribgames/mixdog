import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const connect = async ({ ctx, dial }, visualize) => {
  ctx.updaterListeners = new Set();
  ctx.settingsChangedListeners = new Set();
  const api = createRemoteApi(ctx);
  const leg = await dial({ remoteParity: true, visualize, ready: publishedCeilings(4096, 4096) });
  return { api, leg };
};

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};

test('a host without the visualize flag reads as having no tabs and gets no calls', async () => {
  await withShim({}, async (shim) => {
    const { api } = await connect(shim, false);
    assert.equal(shim.ctx.peerVisualize, false);
    const sent = shim.ctx.socket.sent.length;
    assert.deepEqual(await api.visualizeState(), []);
    await api.visualizeCommand({ sessionId: 's1', tabId: 'v1', action: 'activate' });
    await assert.rejects(api.visualizePaneSource('s1', 'v1', 0), /does not serve/);
    assert.equal(shim.ctx.socket.sent.length, sent, 'nothing was sent to the older host');
  });
});

test('a visualize host serves state and commands, and pushes on the visualize lane', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    assert.equal(shim.ctx.peerVisualize, true);

    const events = [];
    const off = api.onVisualizeChanged((event) => events.push(event));
    const lanes = await nextCall(leg, 'setRemoteLanes');
    assert.deepEqual(lanes.params, [['visualize']], 'listening registers the visualize lane');

    const reading = api.visualizeState();
    const state = await nextCall(leg, 'visualizeState');
    await leg.deliver({ id: state.id, ok: true, value: [{ sessionId: 's1', tabs: [], active: null }] });
    assert.deepEqual(await reading, [{ sessionId: 's1', tabs: [], active: null }]);

    const command = { sessionId: 's1', tabId: 'v2', action: 'close' };
    const sending = api.visualizeCommand(command);
    const sent = await nextCall(leg, 'visualizeCommand');
    assert.deepEqual(sent.params, [command]);
    await leg.deliver({ id: sent.id, ok: true, value: null });
    await sending;

    const tab = { id: 'v1', label: 'page', revision: 2, panes: [{ kind: 'html', label: 'a', target: 'a', url: '' }] };
    await leg.deliver({
      event: 'visualizeChanged',
      payload: { sessionId: 's1', state: { sessionId: 'other', tabs: [tab], active: 'v1' }, reveal: true, openUrl: 'x' },
    });
    await leg.deliver({ event: 'visualizeChanged', payload: { sessionId: 's1' } });
    await leg.deliver({ event: 'visualizeChanged', payload: null });
    assert.deepEqual(events, [
      { sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: 'v1' }, reveal: true },
    ]);

    off();
    assert.equal(shim.ctx.visualizeListeners.size, 0);
    assert.deepEqual((await nextCall(leg, 'setRemoteLanes')).params, [[]], 'the last listener releases the lane');
  });
});

test('a media pane is read in bounded ranges into a blob URL', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    const loading = api.visualizePaneSource('s1', 'v2', 0);
    const meta = await nextCall(leg, 'visualizePaneFile');
    assert.deepEqual(meta.params, ['s1', 'v2', 0]);
    await leg.deliver({
      id: meta.id,
      ok: true,
      value: { kind: 'image', mime: 'image/png', size: 3, mtimeMs: 1, rel: 'out/chart.png' },
    });
    const range = await nextCall(leg, 'visualizePaneRange');
    assert.equal(range.params[0], 's1');
    assert.equal(range.params[1], 'v2');
    assert.equal(range.params[2], 'out/chart.png');
    assert.equal(range.params[3], 0);
    assert.ok(range.params[4] > 0);
    await leg.deliver({
      id: range.id,
      ok: true,
      value: { data: Buffer.from('png').toString('base64'), mime: 'image/png', offset: 0, size: 3, mtimeMs: 1 },
    });
    const source = await loading;
    assert.equal(source.kind, 'image');
    assert.match(source.url, /^blob:/);
    URL.revokeObjectURL(source.url);
  });
});

test('a pane over the remote size cap is refused before any byte moves', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    const loading = api.visualizePaneSource('s1', 'v2', 0);
    const refused = assert.rejects(loading, /too large/);
    const meta = await nextCall(leg, 'visualizePaneFile');
    const sent = shim.ctx.socket.sent.length;
    await leg.deliver({
      id: meta.id,
      ok: true,
      value: { kind: 'video', mime: 'video/mp4', size: 65 * 1024 * 1024, mtimeMs: 1, rel: 'clip.mp4' },
    });
    await refused;
    assert.equal(shim.ctx.socket.sent.length, sent, 'no range was requested');
  });
});
