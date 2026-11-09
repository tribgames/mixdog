import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRemotePageCache } from './remote-file-preview.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version (b6f10295a) drove these over a fake relay socket with the challenge's `visualize` flag. The table is the same
// (remote-shim-api.ts); the flag is the context's `peerVisualize` (set per connection from the core's capabilities,
// apps/mobile/src/phone-capabilities.ts), and what Node read off the socket is what reaches the adapter that owns the name.
// Not kept: the normalization of a pushed `visualizeChanged` frame (session id forced to the frame's, malformed pushes dropped) -- nothing in
// the phone delivers that push until PH-2's visualize adapter does, so its test belongs there.

test('a host without the visualize flag reads as having no tabs and gets no calls', async () => {
  await withPhoneApi({}, async ({ ctx, api, calls }) => {
    ctx.peerVisualize = false;
    assert.deepEqual(await api.visualizeState(), []);
    await assert.rejects(api.visualizeCommand({ sessionId: 's1', tabId: 'v1', action: 'activate' }), /does not serve/);
    await assert.rejects(api.visualizePaneSource('s1', 'v1', 0), /does not serve/);
    assert.deepEqual(calls, [], 'nothing reached the adapter for an older host');
  });
});

test('a visualize host serves state and commands, and listening registers the visualize lane', async () => {
  const command = { sessionId: 's1', tabId: 'v2', action: 'close' };
  await withPhoneApi(
    { visualizeState: () => [{ sessionId: 's1', tabs: [], active: null }], visualizeCommand: () => null },
    async ({ ctx, api, calls }) => {
      ctx.peerVisualize = true;
      const off = api.onVisualizeChanged(() => {});
      assert.equal(ctx.visualizeListeners.size, 1);
      assert.deepEqual([...ctx.activeLanes], ['visualize'], 'listening registers the visualize lane');
      assert.deepEqual(await api.visualizeState(), [{ sessionId: 's1', tabs: [], active: null }]);
      await api.visualizeCommand(command);
      assert.deepEqual(calls, [
        { method: 'visualizeState', params: [{ deferInline: true }] },
        { method: 'visualizeCommand', params: [command] },
      ]);
      off();
      assert.equal(ctx.visualizeListeners.size, 0);
      assert.deepEqual([...ctx.activeLanes], [], 'the last listener releases the lane');
    }
  );
});

test('a media pane is read in bounded ranges into a blob URL', async () => {
  await withPhoneApi(
    {
      visualizePaneFile: () => ({ kind: 'image', mime: 'image/png', size: 3, mtimeMs: 1, rel: 'out/chart.png' }),
      visualizePaneRange: () => ({ data: Buffer.from('png').toString('base64'), mime: 'image/png', offset: 0, size: 3, mtimeMs: 1 }),
    },
    async ({ ctx, api, calls }) => {
      ctx.peerVisualize = true;
      const source = await api.visualizePaneSource('s1', 'v2', 0);
      assert.deepEqual(calls[0], { method: 'visualizePaneFile', params: ['s1', 'v2', 0] });
      const range = calls[1].params;
      assert.equal(calls[1].method, 'visualizePaneRange');
      assert.deepEqual(range.slice(0, 4), ['s1', 'v2', 'out/chart.png', 0]);
      assert.ok(range[4] > 0);
      assert.equal(source.kind, 'image');
      assert.match(source.url, /^blob:/);
      URL.revokeObjectURL(source.url);
    }
  );
});

test('a page is read once per host content identity, on its own pairing only', async (t) => {
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
  t.after(() => {
    delete globalThis.DOMParser;
  });
  // What the host answers: the metadata the test sets for the next load, and the bytes it holds for the range read.
  let meta = null;
  let bytes = '';
  await withPhoneApi(
    {
      visualizePaneFile: () => meta,
      visualizePaneRange: () => ({ data: Buffer.from(bytes).toString('base64'), mime: 'text/html', offset: 0, size: bytes.length, mtimeMs: 1 }),
    },
    async ({ ctx, api, calls }) => {
      ctx.peerVisualize = true;
      let pairing = 'pairing-a';
      ctx.visualizePages = createRemotePageCache(() => pairing);
      const page = (body) => `<!doctype html><html><head></head><body>${body}</body></html>`;
      const id = (scope, html) => `${scope}:${createHash('sha256').update(html).digest('hex')}`;
      // Size and mtime never change here: only the content identity tells pages apart.
      const serve = async (contentId, read) => {
        const before = calls.length;
        meta = { kind: 'html', mime: 'text/html', size: 60, mtimeMs: 1, rel: 'page.html', ...(contentId ? { contentId } : {}) };
        bytes = read ?? '';
        const source = await api.visualizePaneSource('s1', 'v5', 0);
        return { ...source, calls: calls.length - before };
      };

      const one = await serve(id('live', page('one')), page('one'));
      assert.match(one.srcdoc, /one/);
      assert.equal(one.calls, 2);
      const again = await serve(id('live', page('one')), null);
      assert.deepEqual([again.srcdoc, again.calls], [one.srcdoc, 1], 'same content: only the metadata call');
      assert.notEqual(again.fetch, one.fetch, 'a cached page gets this load’s fetch');
      // Same size and mtime, different bytes.
      assert.match((await serve(id('live', page('two')), page('two'))).srcdoc, /two/);

      // Kept versions under the same path: each version's own snapshot.
      assert.match((await serve(id('v1', page('old')), page('old'))).srcdoc, /old/);
      assert.match((await serve(id('v2', page('new')), page('new'))).srcdoc, /new/);
      assert.equal((await serve(id('v1', page('old')), null)).calls, 1);

      // No identity from the host, or bytes that are not the hashed ones: never kept.
      assert.equal((await serve(undefined, page('one'))).calls, 2);
      assert.equal((await serve(undefined, page('one'))).calls, 2);
      assert.match((await serve(id('live', page('xyz')), page('abc'))).srcdoc, /abc/);
      assert.match((await serve(id('live', page('xyz')), page('xyz'))).srcdoc, /xyz/);

      // Another pairing (server switch, re-pair) or none reuses nothing.
      pairing = 'pairing-b';
      assert.equal((await serve(id('v1', page('old')), page('old'))).calls, 2);
      ctx.visualizePages.clear();
      assert.equal((await serve(id('v1', page('old')), page('old'))).calls, 2);
      pairing = null;
      assert.equal((await serve(id('v1', page('old')), page('old'))).calls, 2);
      assert.equal((await serve(id('v1', page('old')), page('old'))).calls, 2);
    }
  );
});

test('a pane over the remote size cap is refused before any byte moves', async () => {
  await withPhoneApi(
    { visualizePaneFile: () => ({ kind: 'video', mime: 'video/mp4', size: 65 * 1024 * 1024, mtimeMs: 1, rel: 'clip.mp4' }), visualizePaneRange: () => ({}) },
    async ({ ctx, api, calls }) => {
      ctx.peerVisualize = true;
      await assert.rejects(api.visualizePaneSource('s1', 'v2', 0), /too large/);
      assert.deepEqual(calls.map((call) => call.method), ['visualizePaneFile'], 'no range was requested');
    }
  );
});
