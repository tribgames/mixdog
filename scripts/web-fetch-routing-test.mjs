#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  isLoopbackHttpUrl,
  preDispatchDenyForSession,
} from '../src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { executeTool } from '../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import {
  getInternalTools,
  setInternalToolsProvider,
} from '../src/runtime/agent/orchestrator/internal-tools.mjs';
import { previewSessionTools } from '../src/runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { TOOL_DEFS as SEARCH_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { dispatchSearchRuntimeTool } from '../src/session-runtime/runtime-core.mjs';
import {
  fetchLoopbackText,
  fetchPublicImage,
} from '../src/runtime/search/lib/http-fetch.mjs';

test('pre-dispatch keeps hook-facing web_fetch name unchanged', () => {
  const local = { name: 'web_fetch', arguments: { url: 'http://127.0.0.1:4321/status' } };
  const image = { name: 'web_fetch', arguments: { url: 'https://cdn.example.com/a.png?x=1' } };
  const document = { name: 'web_fetch', arguments: { url: 'https://example.com/docs' } };
  assert.equal(preDispatchDenyForSession({}, local), null);
  assert.equal(preDispatchDenyForSession({}, image), null);
  assert.equal(preDispatchDenyForSession({}, document), null);
  assert.equal(local.name, 'web_fetch');
  assert.equal(image.name, 'web_fetch');
  assert.equal(document.name, 'web_fetch');
  assert.equal(isLoopbackHttpUrl('http://localhost:80/'), true);
  assert.equal(isLoopbackHttpUrl('http://192.168.1.2/'), false);
});

test('hidden routed tools remain dispatchable but absent from every model schema', () => {
  setInternalToolsProvider({
    tools: SEARCH_TOOL_DEFS,
    executor: async () => '',
  });
  const registered = getInternalTools().map((tool) => tool.name);
  assert.equal(registered.includes('local_fetch'), true);
  assert.equal(registered.includes('image_fetch'), true);
  for (const spec of ['full', 'mcp', 'readonly', ['tools:mcp']]) {
    const visible = previewSessionTools(spec, []).map((tool) => tool.name);
    assert.equal(visible.includes('local_fetch'), false, `local_fetch leaked for ${JSON.stringify(spec)}`);
    assert.equal(visible.includes('image_fetch'), false, `image_fetch leaked for ${JSON.stringify(spec)}`);
    assert.equal(visible.includes('web_fetch'), true, `web_fetch missing for ${JSON.stringify(spec)}`);
  }
});

test('hook sees public name before routed dispatch and can change routing inputs', async () => {
  const observed = [];
  setInternalToolsProvider({
    tools: SEARCH_TOOL_DEFS,
    executor: async (name, args) => {
      observed.push({ stage: 'dispatch', name, args });
      return { content: [{ type: 'text', text: name }] };
    },
  });
  const result = await executeTool(
    'web_fetch',
    { url: 'https://example.com/document' },
    process.cwd(),
    'routing-order-test',
    {
      beforeToolHook: async ({ name, args }) => {
        observed.push({ stage: 'hook', name, args });
        return { action: 'modify', args: { url: 'http://127.0.0.1:4321/status' } };
      },
    },
    { toolCallId: 'routing-order-call' },
  );
  assert.equal(result, 'local_fetch');
  assert.deepEqual(observed.map(({ stage, name }) => ({ stage, name })), [
    { stage: 'hook', name: 'web_fetch' },
    { stage: 'dispatch', name: 'local_fetch' },
  ]);
});

test('cancellation signal propagates across executeTool and runtime search dispatch', async () => {
  const received = [];
  setInternalToolsProvider({
    tools: SEARCH_TOOL_DEFS,
    executor: (name, args, callerCtx) => dispatchSearchRuntimeTool(name, args, callerCtx, {
      getSearchModule: async () => ({
        handleToolCall: async (_name, _args, options) => {
          received.push({ name: _name, signal: options.signal });
          await new Promise((resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        },
      }),
      getCurrentCwd: () => process.cwd(),
      getSession: () => null,
      notifyFnForSession: () => null,
      runNativeWebSearch: async () => null,
    }),
  });
  for (const [index, testCase] of [
    { url: 'https://example.com/document', expectedName: 'web_fetch' },
    { url: 'http://127.0.0.1:4321/status', expectedName: 'local_fetch' },
  ].entries()) {
    const controller = new AbortController();
    const running = executeTool(
      'web_fetch',
      { url: testCase.url },
      process.cwd(),
      `cancel-test-${index}`,
      {},
      { toolCallId: `cancel-call-${index}`, signal: controller.signal },
    );
    controller.abort(new Error(`cancelled-by-test-${index}`));
    await assert.rejects(running, new RegExp(`cancelled-by-test-${index}`));
    assert.equal(received[index].name, testCase.expectedName);
    assert.equal(received[index].signal, controller.signal);
  }
});

test('local_fetch reads loopback and rejects redirect escape', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/escape') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('local-ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal(await fetchLoopbackText(`http://127.0.0.1:${port}/ok`), 'local-ok');
  await assert.rejects(fetchLoopbackText(`http://127.0.0.1:${port}/escape`), /non-loopback/);
  await assert.rejects(fetchLoopbackText('http://10.0.0.1/'), /non-loopback/);
});

test('public image fetch is bounded, media-shaped, and blocks private redirect targets', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const okFetch = async () => new Response(png, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
  });
  const image = await fetchPublicImage('https://images.example.com/a.png', { fetchImpl: okFetch });
  assert.deepEqual(image, { mimeType: 'image/png', data: png.toString('base64'), bytes: png.length });

  let calls = 0;
  const redirectFetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  };
  await assert.rejects(
    fetchPublicImage('https://images.example.com/a.png', { fetchImpl: redirectFetch }),
    /private address/,
  );
  assert.equal(calls, 1);
});
