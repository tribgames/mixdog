import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HostRpcError } from '../connection.ts';
import { MAX_INLINE_RESULT_BYTES } from './blob-upload.ts';
import { registerEngineMethod, registerEngineSessionMethod } from './registry.ts';
import { createTranscriptTap } from './transcript.ts';

const SECRET = 'hunter2hunter2hunter2';

function harness({ destroyed = false, transcript } = {}) {
  const log = [];
  const handlers = new Map();
  const puts = [];
  const connection = {
    request: async (method, params) => {
      log.push(`request ${method}`);
      puts.push(params);
      return {};
    },
    handleRequest: (method, handler) => handlers.set(method, handler),
  };
  const guest = { getURL: () => 'https://a.example/', isDestroyed: () => destroyed };
  const state = { pageId: 'p1', documentGeneration: 1, cdpSessions: new Map() };
  let seq = 0;
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {},
    events: {
      flush: (pageId) => log.push(`flush ${pageId}`),
      facts: (pageId) => ({ pageId, seq: ++seq, url: `https://a.example/?k=${SECRET}` }),
    },
    redactKnown: (_pageId, text) => text.replaceAll(SECRET, '[SECRET]'),
    isEngineMode: () => true,
    transcript,
  };
  const call = (method, params) => handlers.get(method)(params, new AbortController().signal);
  return { log, connection, ctx, puts, call };
}

test('params must be an object and a page method names its page', async () => {
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/x', async () => ({}));
  await assert.rejects(h.call('host/browser/x', []), (e) => e.code === -32602);
  await assert.rejects(h.call('host/browser/x', {}), (e) => e.code === -32602);
});

test('a page that is not there, or was destroyed, is -32011 and the handler does not run', async () => {
  let ran = false;
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/x', async () => (ran = true));
  await assert.rejects(h.call('host/browser/x', { pageId: 'p9' }), (e) => e.code === -32011);
  const dead = harness({ destroyed: true });
  registerEngineMethod(dead.connection, dead.ctx, 'host/browser/x', async () => (ran = true));
  await assert.rejects(dead.call('host/browser/x', { pageId: 'p1' }), (e) => e.code === -32011);
  assert.equal(ran, false);
});

test('a stale expect is -32010 with the facts, before the handler runs', async () => {
  let ran = false;
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/x', async () => {
    ran = true;
    return {};
  });
  await assert.rejects(
    h.call('host/browser/x', { pageId: 'p1', expect: { documentId: 'p1:0' } }),
    (e) => e.code === -32010 && e.data.reason === 'document' && e.data.facts.pageId === 'p1'
  );
  assert.equal(ran, false);
  const fresh = await h.call('host/browser/x', { pageId: 'p1', expect: { documentId: 'p1:1' } });
  assert.deepEqual(Object.keys(fresh), ['facts']);
});

test('the handler guards its own send against a page that moved after the first check', async () => {
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/x', async (params, _signal, page) => {
    page.state.documentGeneration += 1;
    return page.guarded(params.expect, async () => 'sent');
  });
  await assert.rejects(
    h.call('host/browser/x', { pageId: 'p1', expect: { documentId: 'p1:1' } }),
    (e) => e.code === -32010
  );
});

test('events are flushed before the reply, on success and on failure, and the facts ride the result', async () => {
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/ok', async () => {
    h.log.push('handler');
    return { value: 1 };
  });
  registerEngineMethod(h.connection, h.ctx, 'host/browser/bad', async () => {
    throw new Error('boom');
  });
  const result = await h.call('host/browser/ok', { pageId: 'p1' });
  h.log.push('reply');
  assert.deepEqual(h.log, ['handler', 'flush p1', 'reply']);
  assert.equal(result.value, 1);
  assert.equal(result.facts.seq, 1);
  await assert.rejects(h.call('host/browser/bad', { pageId: 'p1' }), (e) => e.code === -32000 && e.message === 'boom');
  assert.equal(h.log.at(-1), 'flush p1');
});

test('every string of a result and of an error is masked with what the page knows', async () => {
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/ok', async () => ({
    text: `a ${SECRET} b`,
    list: [SECRET, 4],
    nested: { deep: `x ${SECRET}` },
  }));
  registerEngineMethod(h.connection, h.ctx, 'host/browser/bad', async () => {
    throw new HostRpcError(-32015, `refused ${SECRET}`, { reason: SECRET });
  });
  const result = await h.call('host/browser/ok', { pageId: 'p1' });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.text, 'a [SECRET] b');
  assert.equal(result.facts.url, 'https://a.example/?k=[SECRET]');
  await assert.rejects(h.call('host/browser/bad', { pageId: 'p1' }), (e) => {
    assert.equal(e.code, -32015);
    assert.equal(JSON.stringify([e.message, e.data]).includes(SECRET), false);
    return true;
  });
});

test('a base64 payload over 192 KiB moves to blob/put and the result carries the ref', async () => {
  const h = harness();
  const bytes = Buffer.alloc(MAX_INLINE_RESULT_BYTES, 7);
  registerEngineMethod(h.connection, h.ctx, 'host/browser/shot', async () => ({
    mimeType: 'image/png',
    data: bytes.toString('base64'),
  }));
  const result = await h.call('host/browser/shot', { pageId: 'p1' });
  assert.equal(result.data, undefined);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.blob.size, bytes.length);
  assert.match(result.blob.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(h.puts.length >= 2);
  assert.equal(result.facts.pageId, 'p1');
});

test('a result over 192 KiB that is not a payload fails, and one just under goes through', async () => {
  const h = harness();
  registerEngineMethod(h.connection, h.ctx, 'host/browser/big', async () => ({ rows: 'x'.repeat(MAX_INLINE_RESULT_BYTES) }));
  registerEngineMethod(h.connection, h.ctx, 'host/browser/fits', async () => ({
    rows: 'x'.repeat(MAX_INLINE_RESULT_BYTES - 1024),
  }));
  await assert.rejects(
    h.call('host/browser/big', { pageId: 'p1' }),
    (e) => e.code === -32000 && /larger than/.test(e.message)
  );
  assert.equal((await h.call('host/browser/fits', { pageId: 'p1' })).rows.length, MAX_INLINE_RESULT_BYTES - 1024);
  assert.equal(h.puts.length, 0);
});

test('a session method has the same exits and no page', async () => {
  const h = harness();
  registerEngineSessionMethod(h.connection, h.ctx, 'host/browser/pages/resolve', async (params) => ({
    got: params.sessionId,
  }));
  assert.deepEqual(await h.call('host/browser/pages/resolve', { sessionId: 's1' }), { got: 's1' });
  assert.equal(h.log.length, 0);
  await assert.rejects(h.call('host/browser/pages/resolve', 5), (e) => e.code === -32602);
});

test('the transcript records the call and the masked answer, and only in a development build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-transcript-'));
  try {
    assert.equal(createTranscriptTap({ dir, devBuild: false }), undefined);
    assert.equal(createTranscriptTap({ dir: undefined, devBuild: true }), undefined);
    const tap = createTranscriptTap({ dir, devBuild: true, now: () => 42 });
    const h = harness({ transcript: tap });
    registerEngineMethod(h.connection, h.ctx, 'host/browser/ok', async () => ({ text: SECRET }));
    await h.call('host/browser/ok', { pageId: 'p1', typed: SECRET });
    const file = join(dir, `engine-${process.pid}.jsonl`);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.dir, line.method, line.t]),
      [
        ['in', 'host/browser/ok', 42],
        ['out', 'host/browser/ok', 42],
      ]
    );
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
    assert.equal(lines[1].result.text, '[SECRET]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
