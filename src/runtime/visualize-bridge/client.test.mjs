import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeVisualizeTool, validateVisualizeArgs, visualizeBridgeAvailableSync } from './client.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';

async function withBridge(handler, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-visualize-bridge-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const previousIsolated = process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ body, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeFile(
    join(directory, 'visualize-bridge.json'),
    JSON.stringify({ version: 1, port: server.address().port, token: 'secret', pid: process.pid })
  );
  try {
    await run(requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    if (previousIsolated !== undefined) process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = previousIsolated;
    await rm(directory, { recursive: true, force: true });
  }
}

test('visualize tool-defs schema exposes action + input and the usage guidance', () => {
  assert.deepEqual(TOOL_DEFS.map((tool) => tool.name), ['visualize']);
  const schema = TOOL_DEFS[0].inputSchema;
  assert.deepEqual(schema.properties.action.enum, ['open', 'close', 'annotate', 'capture', 'export', 'check', 'inspect']);
  assert.equal(schema.properties.input.type, 'object');
  assert.equal(schema.properties.input.properties.targets.maxItems, 3);
  assert.deepEqual(schema.required, ['action']);
  assert.equal(schema.additionalProperties, false);
  assert.match(TOOL_DEFS[0].description, /auto-reload/);
  assert.match(TOOL_DEFS[0].description, /HTML pages only/);
  assert.match(TOOL_DEFS[0].description, /browser/);
  // The agent is told to check pages and fix reported problems before reporting.
  assert.match(TOOL_DEFS[0].description, /check: tab; HTML pages only/);
  assert.match(TOOL_DEFS[0].description, /"Page problems" section[\s\S]*fix them[\s\S]*before reporting/);
});

test('open takes inline content as an alternative to targets', () => {
  const content = TOOL_DEFS[0].inputSchema.properties.input.properties.content;
  assert.deepEqual(content.properties.kind.enum, ['mermaid', 'svg', 'chart', 'html', 'markdown']);
  assert.deepEqual(content.required, ['kind', 'source']);
  assert.match(TOOL_DEFS[0].description, /Prefer inline content for diagrams, charts and quick sketches/);
  assert.match(TOOL_DEFS[0].description, /write a file for real mockups/);

  const ok = validateVisualizeArgs({ action: 'open', input: { content: { kind: 'mermaid', source: 'graph TD;A-->B', title: 'Flow' } } });
  assert.equal(ok.ok, true);
  const both = validateVisualizeArgs({ action: 'open', input: { targets: ['a.html'], content: { kind: 'svg', source: '<svg/>' } } });
  assert.match(both.error, /either input\.targets or input\.content/);
  assert.match(validateVisualizeArgs({ action: 'open', input: { content: { kind: 'gif', source: 'x' } } }).error, /kind must be one of/);
  assert.match(validateVisualizeArgs({ action: 'open', input: { content: { kind: 'svg', source: ' ' } } }).error, /non-empty/);
  assert.match(
    validateVisualizeArgs({ action: 'open', input: { content: { kind: 'svg', source: 'x'.repeat(512 * 1024 + 1) } } }).error,
    /at most 512 KiB/
  );
});

test('open takes an optional kept version number', () => {
  const version = TOOL_DEFS[0].inputSchema.properties.input.properties.version;
  assert.equal(version.type, 'integer');
  assert.equal(version.minimum, 1);
  assert.match(TOOL_DEFS[0].description, /optional version/);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a.html'], version: 2 } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a.html'], version: null } }).ok, true);
  for (const bad of [0, -1, 1.5, '2']) {
    const result = validateVisualizeArgs({ action: 'open', input: { targets: ['a.html'], version: bad } });
    assert.equal(result.ok, false, `version ${JSON.stringify(bad)} is refused`);
    assert.match(result.error, /version must be a positive integer/);
  }
});

test('validateVisualizeArgs checks per-action input', () => {
  assert.equal(validateVisualizeArgs({ action: 'nope' }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: [] } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a', 'b', 'c', 'd'] } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a.html'] } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a.html', 'b.html'] } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['http://localhost:3000'] } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['http://localhost:3000', 'a.html'] } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['a.html', 'https://x.dev'] } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'open', input: { targets: ['http://a.dev', 'http://b.dev'] } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'annotate', input: { clear: true } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'capture', input: { tab: 't1', output: 'x.jpg' } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'capture', input: { tab: 't1', output: 'x.png' } }).ok, true);
  const exported = (input) => validateVisualizeArgs({ action: 'export', input });
  assert.equal(exported({ tab: 't1', format: 'png', output: 'design/a.png' }).ok, true);
  assert.equal(exported({ tab: 't1', format: 'pdf', output: 'design/a.PDF', version: 2, overwrite: true }).ok, true);
  assert.equal(exported({ format: 'png', output: 'a.png' }).ok, false, 'needs a tab');
  assert.equal(exported({ tab: 't1', output: 'a.png' }).ok, false, 'needs a format');
  assert.equal(exported({ tab: 't1', format: 'gif', output: 'a.gif' }).ok, false);
  assert.match(exported({ tab: 't1', format: 'pdf', output: 'a.png' }).error, /ending in \.pdf/);
  assert.equal(exported({ tab: 't1', format: 'png', output: 'a.png', version: 0 }).ok, false);
  assert.equal(exported({ tab: 't1', format: 'png', output: 'a.png', overwrite: 'yes' }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'close' }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'check' }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'check', input: { tab: '' } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'check', input: { tab: 'v1' } }).ok, true);
  // inspect: a tab, an optional viewport in whole px, an optional scoping selector.
  assert.equal(validateVisualizeArgs({ action: 'inspect' }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1' } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1', viewport: { width: 375, height: 812 }, selector: 'main' } }).ok, true);
  assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1', viewport: { width: 375 } } }).ok, true);
  for (const viewport of [{ height: 800 }, { width: 100 }, { width: 5000 }, { width: 375.5 }, { width: 375, height: 10 }, '375', []]) {
    assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1', viewport } }).ok, false, JSON.stringify(viewport));
  }
  assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1', selector: '' } }).ok, false);
  assert.equal(validateVisualizeArgs({ action: 'inspect', input: { tab: 'v1', selector: 'x'.repeat(501) } }).ok, false);
});

test('the tool schema and description cover inspect', () => {
  const schema = TOOL_DEFS[0].inputSchema;
  assert.ok(schema.properties.action.enum.includes('inspect'));
  assert.deepEqual(schema.properties.input.properties.viewport.required, ['width']);
  assert.match(TOOL_DEFS[0].description, /inspect: tab \+ optional viewport[\s\S]*fix the findings before reporting/);
});

test('executeVisualizeTool returns the bridge text with its page problems section', async () => {
  const text = 'Checked tab v1.\nPage problems on tab v1 (1):\n- exception: Uncaught Error: x (app.js:2)\nFix these before reporting.';
  await withBridge(
    () => ({ ok: true, text, tabs: [{ id: 'v1', label: 'Page', kind: 'html', target: 'a.html' }] }),
    async (requests) => {
      const result = await executeVisualizeTool({ action: 'check', input: { tab: 'v1' } }, { sessionId: 's1', cwd: '/proj' });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /^Checked tab v1\.\nPage problems on tab v1 \(1\):/);
      assert.deepEqual(requests[0].body, { sessionId: 's1', cwd: '/proj', action: 'check', input: { tab: 'v1' } });
    }
  );
});

test('executeVisualizeTool posts { sessionId, cwd, action, input } with bearer auth', async () => {
  await withBridge(
    () => ({ ok: true, text: 'Opened', tabs: [{ id: 't1', label: 'Page', kind: 'html', target: 'a.html' }] }),
    async (requests) => {
      assert.equal(visualizeBridgeAvailableSync(), true);
      const input = { targets: ['a.html'], label: 'Page' };
      const result = await executeVisualizeTool(
        { action: 'open', input },
        { sessionId: 's1', cwd: '/proj' }
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /Opened\nt1 html Page → a\.html/);
      assert.deepEqual(requests[0].body, { sessionId: 's1', cwd: '/proj', action: 'open', input });
      assert.equal(requests[0].authorization, 'Bearer secret');
    }
  );
});

test("executeVisualizeTool stamps the host's owner session as a structured field, not only prose", async () => {
  const note = 'Shown in the side panel of session sess_lead (the conversation this agent works for).';
  await withBridge(
    (body) =>
      body.sessionId === 'sess_child'
        ? { ok: true, text: `Opened.\n${note}`, ownerSessionId: 'sess_lead' }
        : body.sessionId === 'sess_odd'
          ? { ok: true, text: 'Opened.', ownerSessionId: '../x' }
          : { ok: true, text: `Opened. ${note}` },
    async () => {
      const open = (sessionId) =>
        executeVisualizeTool({ action: 'open', input: { targets: ['a.html'] } }, { sessionId, cwd: '/proj' });
      const child = await open('sess_child');
      assert.deepEqual(child.toolMeta, { code: 'visualize_owner', missing: [], ownerSessionId: 'sess_lead' });
      assert.match(child.content[0].text, /Shown in the side panel of session sess_lead/, 'the note stays for the model');
      const own = await open('s1');
      assert.equal(own.toolMeta, undefined, 'prose naming a session is no stamp');
      assert.equal((await open('sess_odd')).toolMeta, undefined, 'a malformed id is no stamp');
    }
  );
});

test('executeVisualizeTool surfaces capture path and bridge errors', async () => {
  await withBridge(
    (body) => (body.action === 'capture' ? { ok: true, text: 'Captured', path: 'out.png' } : { ok: false, error: 'Error: no such tab' }),
    async () => {
      const captured = await executeVisualizeTool(
        { action: 'capture', input: { tab: 't1', output: 'out.png' } },
        { sessionId: 's1', cwd: '/proj' }
      );
      assert.match(captured.content[0].text, /path: out\.png/);
      const failed = await executeVisualizeTool({ action: 'close', input: { tab: 'zz' } }, { sessionId: 's1', cwd: '/proj' });
      assert.equal(failed.isError, true);
      assert.equal(failed.content[0].text, 'Error: no such tab');
    }
  );
});

test('executeVisualizeTool reports an unavailable bridge clearly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-visualize-none-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const previousIsolated = process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  try {
    assert.equal(visualizeBridgeAvailableSync(), false);
    const result = await executeVisualizeTool({ action: 'close' }, { sessionId: 's1', cwd: '/proj' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /visualize is unavailable; the Mixdog desktop app must be running/);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    if (previousIsolated !== undefined) process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = previousIsolated;
    await rm(directory, { recursive: true, force: true });
  }
});
