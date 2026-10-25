import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { browserHandoffPage, browserSecretInput } from './client.mjs';

async function withDesktop(handler, run, { discovery = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-browser-handoff-'));
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
      const { status = 200, reply } = handler(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (discovery) {
    await writeFile(
      join(directory, 'browser-bridge.json'),
      JSON.stringify({ version: 1, port: server.address().port, token: 'tok', pid: process.pid })
    );
  }
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

test('browserSecretInput relays the host outcome and sends the bound request', async () => {
  await withDesktop(
    () => ({ reply: { ok: true, value: { text: 'entered' } } }),
    async (requests) => {
      assert.equal(await browserSecretInput('s1', 'r1'), 'entered');
      assert.deepEqual(requests[0].body, { action: 'secret_input', session_id: 's1', request_id: 'r1' });
      assert.equal(requests[0].authorization, 'Bearer tok');
    }
  );
});

test('browserSecretInput maps unknown answers and failures to blocked without leaking them', async () => {
  const replies = [
    { reply: { ok: true, value: { text: 'hunter2-leaked' } } },
    { reply: { ok: true, value: {} } },
    { reply: { ok: false, value: { text: 'entered' } } },
    { status: 500, reply: { ok: true, value: { text: 'entered' } } },
  ];
  for (const answer of replies) {
    await withDesktop(
      () => answer,
      async () => {
        assert.equal(await browserSecretInput('s1', 'r1'), 'blocked');
      }
    );
  }
});

test('browserSecretInput is blocked with no desktop, no discovery, or missing ids', async () => {
  await withDesktop(
    () => assert.fail('no request expected'),
    async () => {
      assert.equal(await browserSecretInput('s1', 'r1'), 'blocked');
    },
    { discovery: false }
  );
  await withDesktop(
    () => assert.fail('no request expected'),
    async () => {
      assert.equal(await browserSecretInput('', 'r1'), 'blocked');
      assert.equal(await browserSecretInput('s1', ''), 'blocked');
    }
  );
});

test('browserSecretInput is blocked, not thrown, when the bridge is unreachable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-browser-dead-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  try {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    await writeFile(
      join(directory, 'browser-bridge.json'),
      JSON.stringify({ version: 1, port, token: 'tok', pid: process.pid })
    );
    assert.equal(await browserSecretInput('s1', 'r1'), 'blocked');
    assert.equal(await browserHandoffPage('s1', 'page_url'), null);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('browserHandoffPage returns the host value and forwards fields', async () => {
  await withDesktop(
    () => ({ reply: { ok: true, value: { origin: 'https://a.test', kind: 'password' } } }),
    async (requests) => {
      const value = await browserHandoffPage('s1', 'secret_bind', { request_id: 'r1', tab: 2 });
      assert.deepEqual(value, { origin: 'https://a.test', kind: 'password' });
      assert.deepEqual(requests[0].body, { request_id: 'r1', tab: 2, action: 'secret_bind', session_id: 's1' });
    }
  );
});

test('browserHandoffPage is null for refusals, non-object values, and a missing desktop', async () => {
  for (const answer of [
    { reply: { ok: false, value: { origin: 'x' } } },
    { status: 403, reply: { ok: true, value: { origin: 'x' } } },
    { reply: { ok: true, value: 'text' } },
    { reply: { ok: true } },
  ]) {
    await withDesktop(
      () => answer,
      async () => {
        assert.equal(await browserHandoffPage('s1', 'page_url'), null);
      }
    );
  }
  await withDesktop(
    () => assert.fail('no request expected'),
    async () => {
      assert.equal(await browserHandoffPage('s1', 'page_url'), null);
    },
    { discovery: false }
  );
  await withDesktop(
    () => assert.fail('no request expected'),
    async () => {
      assert.equal(await browserHandoffPage('', 'page_url'), null);
    }
  );
});
