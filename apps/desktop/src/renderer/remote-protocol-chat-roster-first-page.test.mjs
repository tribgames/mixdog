// The phone's list read: the first page answers the page at once, the rest is read behind it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatAdapter } from './remote-protocol-chat.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { isPartialCatalog, withPartialCatalogRows } from '../shared/session-catalog.ts';
// ── the phone paints its list from the first page ────────────────────────────────────────────────────────────────────────────────────
test('the phone is answered with the first page of the list at once; the rest is read behind it and published whole, each session once, in order', async () => {
  const rows = Array.from({ length: 5 }, (_, at) => ({ id: `t${at}`, title: `T${at}`, preview: '', updatedAt: 100 - at, activityAt: 100 - at, messageCount: 0, cwd: '/w', classification: {}, projectPath: null }));
  let release;
  const second = new Promise((resolve) => (release = resolve));
  const requests = [];
  const client = {
    call: async (method, params) => {
      requests.push(params);
      const from = params.cursor ? Number(params.cursor) : 0;
      if (from > 0) await second;
      // A row of the first page shows again on the second (the list moved while it was walked).
      const data = rows.slice(from === 0 ? 0 : from - 1, from + 2);
      return { data, ...(from + 2 < rows.length ? { nextCursor: String(from + 2) } : {}) };
    },
    on: () => () => undefined,
    store: { subscribe: () => () => undefined },
  };
  const published = [];
  const adapter = createChatAdapter({ sharedFor: () => ({}), remoteSession: () => undefined, roster: { summaries: (r) => summariesOfThreadRows(r) } });
  const host = { ctx: { sessionsCatalog: { publish: (r) => published.push(r.map((s) => s.id)) } }, client: () => client, declareLane() {} };
  const first = await Promise.race([adapter.calls.listSessions([], host), new Promise((resolve) => setTimeout(() => resolve('waited'), 100))]);
  assert.notEqual(first, 'waited', 'the answer does not wait for the later pages');
  assert.deepEqual(first.map((s) => s.id), ['t0', 't1']);
  assert.equal(isPartialCatalog(first), true, 'the page is told it is a first page');
  // A read during the walk is not answered with page one.
  const during = adapter.calls.listSessions([], host);
  assert.equal(await Promise.race([during, new Promise((resolve) => setTimeout(() => resolve('waiting'), 50))]), 'waiting');
  assert.deepEqual(published, [], 'nothing partial is published to the catalog');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(published, [['t0', 't1', 't2', 't3', 't4']]);
  const whole = await during;
  assert.equal(isPartialCatalog(whole), false);
  assert.deepEqual(whole.map((s) => s.id), ['t0', 't1', 't2', 't3', 't4']);
  assert.deepEqual((await adapter.calls.listSessions([], host)).map((s) => s.id), ['t0', 't1', 't2', 't3', 't4'], 'a later read is the whole list');
});

test('a walk that fails after the first page ends in an error for the next read, which is never answered with page one again; the retry then lists everything', async () => {
  const rows = Array.from({ length: 4 }, (_, at) => ({ id: `t${at}`, title: `T${at}`, preview: '', updatedAt: 100 - at, activityAt: 100 - at, messageCount: 0, cwd: '/w', classification: {}, projectPath: null }));
  let failLater = true;
  const client = {
    call: async (_method, params) => {
      const from = params.cursor ? Number(params.cursor) : 0;
      if (from > 0 && failLater) throw new Error('connection lost');
      return { data: rows.slice(from, from + 2), ...(from + 2 < rows.length ? { nextCursor: String(from + 2) } : {}) };
    },
    on: () => () => undefined,
    store: { subscribe: () => () => undefined },
  };
  const published = [];
  const adapter = createChatAdapter({ sharedFor: () => ({}), remoteSession: () => undefined, roster: { summaries: (r) => summariesOfThreadRows(r) } });
  const host = { ctx: { sessionsCatalog: { publish: (r) => published.push(r.map((s) => s.id)) } }, client: () => client, declareLane() {} };
  const first = await adapter.calls.listSessions([], host);
  assert.equal(isPartialCatalog(first), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(adapter.calls.listSessions([], host), /connection lost/);
  assert.deepEqual(published, [], 'a failed walk publishes nothing');
  failLater = false;
  const retried = await adapter.calls.listSessions([], host);
  assert.equal(isPartialCatalog(retried), false);
  assert.deepEqual(retried.map((s) => s.id), ['t0', 't1', 't2', 't3']);
  assert.deepEqual(published, [['t0', 't1', 't2', 't3']]);
});

test('a first page adds and updates rows and removes none', () => {
  const row = (id, title) => ({ id, title });
  const merged = withPartialCatalogRows([row('a', 'old'), row('z', 'cached')], [row('b', 'new'), row('a', 'fresh')]);
  assert.deepEqual(merged.map((r) => `${r.id}:${r.title}`), ['b:new', 'a:fresh', 'z:cached']);
});