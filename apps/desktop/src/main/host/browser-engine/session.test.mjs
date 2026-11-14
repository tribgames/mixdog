import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  browserViewportEmulation,
  createBrowserEmulationOwner,
  mergeEmulationOverrides,
} from '../../browser/host-policy.ts';
import { BrowserPerformanceTrace } from '../../browser/performance.ts';
import { createInterceptTable, registerSession } from './session.ts';

function harness(overrides = {}, failing = {}) {
  const handlers = new Map();
  const puts = [];
  const sends = [];
  const connection = {
    request: async (method, params) => {
      puts.push({ method, params });
      return {};
    },
    handleRequest: (method, handler) => handlers.set(method, handler),
  };
  const guest = { getURL: () => 'https://a.example/', isDestroyed: () => false };
  const state = { pageId: 'p1', documentGeneration: 1, cdpSessions: new Map() };
  const cdp = {
    call: async (_guest, method, params) => {
      sends.push({ method, params });
      if (failing[method]) throw failing[method];
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `id${sends.length}` };
      if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 5 }] };
      return {};
    },
  };
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp,
    events: { flush: () => {}, facts: (pageId) => ({ pageId, seq: 1 }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  const jar = { calls: [], cookies: [] };
  const traces = new Map();
  const invalidated = [];
  const downloads = [];
  const deps = {
    partitionSession: {
      cookies: {
        get: async (filter) => {
          jar.calls.push(['get', filter]);
          return jar.cookies;
        },
        set: async (details) => jar.calls.push(['set', details]),
        remove: async (url, name) => jar.calls.push(['remove', url, name]),
      },
    },
    urlPolicy: () => ({ allowPrivateNetwork: false, allowedDomains: [] }),
    evaluate: async () => undefined,
    invalidateInteractionState: (g) => invalidated.push(g),
    intercept: createInterceptTable(),
    applyFetchPatterns: async () => {},
    tracesByGuest: {
      get: (g) => traces.get(g),
      set: (g, v) => traces.set(g, v),
      has: (g) => traces.has(g),
      delete: (g) => traces.delete(g),
    },
    pause: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
    emulation: { applyAgent: async () => null },
    downloads: () => downloads,
    ...overrides,
  };
  registerSession(connection, ctx, deps);
  const call = (method, params) => handlers.get(method)(params, new AbortController().signal);
  return { call, jar, sends, puts, guest, state, deps, traces, invalidated, downloads };
}

const cookie = (name, value = 'secret-value') => ({
  name,
  value,
  domain: 'a.example',
  path: '/',
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: 'lax',
});

test('cookies get lists metadata with every value masked, filtered by name and capped', async () => {
  const h = harness();
  h.jar.cookies = Array.from({ length: 250 }, (_, index) => cookie(`c${index}`));
  const out = await h.call('host/browser/cookies', { pageId: 'p1', op: 'get', name: 'c1' });
  assert.equal(out.cookies.length, 200);
  assert.equal(out.total, 250);
  assert.ok(out.cookies.every((entry) => entry.value === '[REDACTED]'));
  assert.deepEqual(h.jar.calls[0], ['get', { url: 'https://a.example/', name: 'c1' }]);
  assert.ok(!JSON.stringify(out).includes('secret-value'));
});

test('cookies set, delete and clear act on the partition and refuse a stale expect before touching it', async () => {
  const h = harness();
  await h.call('host/browser/cookies', {
    pageId: 'p1',
    op: 'set',
    urls: ['https://b.example/x'],
    cookie: { name: 'k', value: 'v', sameSite: 'Strict', secure: true, path: '/x' },
  });
  assert.deepEqual(h.jar.calls[0], [
    'set',
    { url: 'https://b.example/x', name: 'k', value: 'v', path: '/x', secure: true, sameSite: 'strict' },
  ]);
  await assert.rejects(
    h.call('host/browser/cookies', { pageId: 'p1', op: 'set', cookie: { name: 'k', value: 'v', sameSite: 'bad' } }),
    /sameSite must be/
  );
  await assert.rejects(h.call('host/browser/cookies', { pageId: 'p1', op: 'delete' }), /requires name/);
  await h.call('host/browser/cookies', { pageId: 'p1', op: 'delete', name: 'k' });
  assert.deepEqual(h.jar.calls.at(-1), ['remove', 'https://a.example/', 'k']);

  h.jar.cookies = [cookie('x'), cookie('y')];
  const cleared = await h.call('host/browser/cookies', { pageId: 'p1', op: 'clear' });
  assert.equal(cleared.cookies.length, 2);
  assert.deepEqual(h.jar.calls.filter((entry) => entry[0] === 'remove').slice(-2), [
    ['remove', 'https://a.example/', 'x'],
    ['remove', 'https://a.example/', 'y'],
  ]);

  const before = h.jar.calls.length;
  await assert.rejects(
    h.call('host/browser/cookies', { pageId: 'p1', op: 'clear', expect: { documentId: 'p1:0' } }),
    (error) => error.code === -32010
  );
  assert.equal(h.jar.calls.length, before);
});

test('storage masks sensitive keys, and only a write invalidates refs', async () => {
  const h = harness({
    evaluate: async (_guest, script) => {
      if (script.includes('const key = ""')) {
        return {
          total: 2,
          entries: [
            ['theme', 'dark'],
            ['access_token', 'abc'],
          ],
          omitted: 0,
        };
      }
      return 'abc';
    },
  });
  const listed = await h.call('host/browser/storage', { pageId: 'p1', op: 'get', area: 'local' });
  assert.deepEqual(listed.entries.entries, [
    ['theme', 'dark'],
    ['access_token', '[REDACTED]'],
  ]);
  const one = await h.call('host/browser/storage', { pageId: 'p1', op: 'get', area: 'session', key: 'password' });
  assert.equal(one.entries, '[REDACTED]');
  assert.equal(h.invalidated.length, 0);
  const set = await h.call('host/browser/storage', {
    pageId: 'p1',
    op: 'set',
    area: 'local',
    key: 'token',
    value: 'zzz',
  });
  assert.equal(set.entries, '[REDACTED]');
  assert.equal(h.invalidated.length, 1);
  await assert.rejects(h.call('host/browser/storage', { pageId: 'p1', op: 'set', area: 'local' }), /requires key/);
  await assert.rejects(
    h.call('host/browser/storage', { pageId: 'p1', op: 'get', area: 'cache' }),
    (error) => error.code === -32602
  );
});

test('init scripts are added, listed and removed, within the limits', async () => {
  const h = harness();
  const added = await h.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: 'window.x = 1' });
  assert.equal(added.id, 'is1');
  assert.deepEqual(added.scripts, [{ id: 'is1', source: 'window.x = 1' }]);
  assert.deepEqual(h.sends[0], {
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: { source: 'window.x = 1', runImmediately: false },
  });
  await assert.rejects(h.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: '  ' }), /requires script/);
  await assert.rejects(
    h.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: 'x'.repeat(20_001) }),
    /limited to 20000/
  );
  await assert.rejects(
    h.call('host/browser/initScripts', { pageId: 'p1', op: 'remove', id: 'is9' }),
    /unknown init script is9/
  );
  const removed = await h.call('host/browser/initScripts', { pageId: 'p1', op: 'remove', id: 'is1' });
  assert.deepEqual(removed.scripts, []);
  for (let index = 0; index < 10; index += 1) {
    await h.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: `a${index}` });
  }
  await assert.rejects(h.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: 'b' }), /already holds 10/);
});

test('a script Chromium no longer has is dropped; any other removal failure keeps it listed', async () => {
  const gone = harness({}, { 'Page.removeScriptToEvaluateOnNewDocument': new Error('Script not found') });
  await gone.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: 'a' });
  const dropped = await gone.call('host/browser/initScripts', { pageId: 'p1', op: 'remove', id: 'is1' });
  assert.deepEqual(dropped.scripts, []);
  const broken = harness({}, { 'Page.removeScriptToEvaluateOnNewDocument': new Error('Target closed') });
  await broken.call('host/browser/initScripts', { pageId: 'p1', op: 'add', source: 'a' });
  await assert.rejects(broken.call('host/browser/initScripts', { pageId: 'p1', op: 'remove', id: 'is1' }), /Target closed/);
  assert.equal((await broken.call('host/browser/initScripts', { pageId: 'p1', op: 'list' })).scripts.length, 1);
});

test('intercept rules are normalised, matched with hit counts and rolled back when the Fetch push fails', async () => {
  let pushes = 0;
  let failPush = false;
  const h = harness({
    applyFetchPatterns: async () => {
      pushes += 1;
      if (failPush) throw new Error('push failed');
    },
  });
  const added = await h.call('host/browser/intercept', {
    pageId: 'p1',
    op: 'add',
    rule: { pattern: '/api/', resourceTypes: ['XHR'], abort: false, body: '{"ok":true}' },
  });
  assert.equal(added.id, 'i1');
  assert.equal(added.rules[0].pattern, '*/api/*');
  assert.deepEqual(added.rules[0].resourceTypes, ['xhr']);
  assert.equal(pushes, 1);
  const { intercept } = h.deps;
  assert.deepEqual(intercept.interceptFetchPatterns(h.guest), [{ urlPattern: '*/api/*', requestStage: 'Response' }]);
  assert.equal(intercept.matchInterceptRule(h.guest, 'https://a.example/api/x', 'script'), undefined);
  assert.equal(intercept.matchInterceptRule(h.guest, 'https://a.example/api/x', 'XHR')?.id, 'i1');
  const listed = await h.call('host/browser/intercept', { pageId: 'p1', op: 'list' });
  assert.equal(listed.rules[0].hits, 1);

  failPush = true;
  await assert.rejects(
    h.call('host/browser/intercept', { pageId: 'p1', op: 'add', rule: { pattern: 'x', abort: true } }),
    /push failed/
  );
  await assert.rejects(h.call('host/browser/intercept', { pageId: 'p1', op: 'clear' }), /push failed/);
  failPush = false;
  assert.equal((await h.call('host/browser/intercept', { pageId: 'p1', op: 'list' })).rules.length, 1);
  await assert.rejects(
    h.call('host/browser/intercept', { pageId: 'p1', op: 'remove', id: 'nope' }),
    /unknown intercept rule nope/
  );
  await assert.rejects(h.call('host/browser/intercept', { pageId: 'p1', op: 'add', rule: { pattern: ' ' } }), /requires url/);
  const cleared = await h.call('host/browser/intercept', { pageId: 'p1', op: 'clear' });
  assert.deepEqual(cleared.rules, []);
  assert.equal(intercept.hasInterceptRules(h.guest), false);
});

test('performance: metrics, then a trace that starts once and stops with its summary and export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-trace-'));
  try {
    const h = harness();
    const metrics = await h.call('host/browser/performance', { pageId: 'p1', op: 'metrics' });
    assert.deepEqual(metrics.metrics, { metrics: [{ name: 'Nodes', value: 5 }], processMemoryMb: null });
    // Stopping nothing is not an error.
    assert.deepEqual(await h.call('host/browser/performance', { pageId: 'p1', op: 'stop' }), {
      facts: { pageId: 'p1', seq: 1 },
    });

    await h.call('host/browser/performance', { pageId: 'p1', op: 'start', categories: ['loading'], exportPath: dir });
    assert.ok(h.traces.has(h.guest));
    assert.equal(h.sends.at(-1).params.categories, 'loading');
    await assert.rejects(h.call('host/browser/performance', { pageId: 'p1', op: 'start' }), /already running/);
    const active = h.traces.get(h.guest);
    assert.ok(active.trace instanceof BrowserPerformanceTrace);
    active.trace.add([{ name: 'Layout', dur: 2000 }]);
    active.raw.add([{ name: 'Layout', dur: 2000 }]);
    const stopping = h.call('host/browser/performance', { pageId: 'p1', op: 'stop' });
    await new Promise((resolve) => setImmediate(resolve));
    // Chromium reports the end of the trace through the CDP listener.
    active.resolveComplete();
    const stopped = await stopping;
    assert.match(stopped.summary, /Layout: 1 event\(s\)/);
    assert.match(stopped.exportedTo, /trace-.*\.json$/);
    assert.equal(h.traces.has(h.guest), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const relative = harness();
  await assert.rejects(
    relative.call('host/browser/performance', { pageId: 'p1', op: 'start', exportPath: 'rel' }),
    (error) => error.code === -32602
  );
  assert.equal(relative.traces.size, 0);
});

test('performance: saveTrace saves into the host-chosen directory; without one it is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-trace-'));
  try {
    const h = harness({ traceDirectory: () => dir });
    await h.call('host/browser/performance', { pageId: 'p1', op: 'start', saveTrace: true });
    const active = h.traces.get(h.guest);
    active.raw.add([{ name: 'Layout', dur: 2000 }]);
    const stopping = h.call('host/browser/performance', { pageId: 'p1', op: 'stop' });
    await new Promise((resolve) => setImmediate(resolve));
    active.resolveComplete();
    assert.ok((await stopping).exportedTo.startsWith(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(
    harness().call('host/browser/performance', { pageId: 'p1', op: 'start', saveTrace: true }),
    /trace export is unavailable/
  );
});

test('performance: a start that Chromium refuses leaves no trace recorded', async () => {
  const h = harness({}, { 'Tracing.start': new Error('busy') });
  await assert.rejects(h.call('host/browser/performance', { pageId: 'p1', op: 'start' }), /busy/);
  assert.equal(h.traces.size, 0);
});

test('emulation: the agent clearing its overrides gives the page back to the pane viewport', async () => {
  const commands = [];
  const owner = createBrowserEmulationOwner({
    configure: async (_guest, command) => {
      commands.push(command);
      return ['x'];
    },
  });
  const guest = {};
  const pane = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: null };
  await owner.applyPane(guest, pane);
  assert.deepEqual(commands[0], browserViewportEmulation(pane));
  assert.deepEqual(await owner.applyAgent(guest, { locale: 'de-DE' }), { locale: 'de-DE' });
  assert.equal(commands[1].reset, undefined);
  assert.equal(await owner.applyAgent(guest, null), null);
  assert.deepEqual(commands[2], browserViewportEmulation(pane));
  assert.equal(commands[2].width, 390);
  // No pane viewport: clearing resets only.
  await owner.applyAgent({}, null);
  assert.deepEqual(commands[3], { action: 'emulate', reset: true });
});

test('emulation: an override of the scale factor or of one side keeps the rest of the pane size', () => {
  const pane = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: null };
  assert.deepEqual(mergeEmulationOverrides({ deviceScaleFactor: 2 }, pane), {
    action: 'emulate',
    deviceScaleFactor: 2,
    width: 390,
    height: 844,
  });
  assert.deepEqual(mergeEmulationOverrides({ width: 500 }, pane), { action: 'emulate', width: 500, height: 844 });
  assert.deepEqual(mergeEmulationOverrides({ width: 500, height: 300 }, pane), {
    action: 'emulate',
    width: 500,
    height: 300,
  });
  assert.deepEqual(mergeEmulationOverrides({ locale: 'fr' }, pane), { action: 'emulate', locale: 'fr' });
  // Without a fixed pane viewport nothing is filled in.
  const open = { ...pane, width: null, height: null };
  assert.deepEqual(mergeEmulationOverrides({ deviceScaleFactor: 2 }, open), {
    action: 'emulate',
    deviceScaleFactor: 2,
  });
  assert.deepEqual(mergeEmulationOverrides({ headers: { a: 'b' }, touch: undefined }, null), {
    action: 'emulate',
    headers: { a: 'b' },
  });
});

test('the emulation method answers what the agent now has and refuses a stale page first', async () => {
  const seen = [];
  const h = harness({
    emulation: {
      applyAgent: async (_guest, overrides) => {
        seen.push(overrides);
        return overrides;
      },
    },
  });
  const out = await h.call('host/browser/emulation', { pageId: 'p1', overrides: { locale: 'fr' } });
  assert.deepEqual(out.applied, { locale: 'fr' });
  const cleared = await h.call('host/browser/emulation', { pageId: 'p1', overrides: null });
  assert.equal(cleared.applied, null);
  assert.deepEqual(seen, [{ locale: 'fr' }, null]);
  await assert.rejects(h.call('host/browser/emulation', { pageId: 'p1', overrides: 3 }), (e) => e.code === -32602);
  await assert.rejects(
    h.call('host/browser/emulation', { pageId: 'p1', overrides: {}, expect: { documentId: 'p1:0' } }),
    (e) => e.code === -32010
  );
  assert.equal(seen.length, 2);
});

test('downloads list what changed since, and take hands the file over as a blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-dl-'));
  try {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello');
    const entry = (id, state, extra = {}) => ({
      id,
      file: `${id}.txt`,
      path,
      url: 'https://a.example/f?token=abcdef123456789012345678',
      mimeType: 'text/plain',
      state,
      received: 5,
      total: 5,
      startedAt: 100,
      ...extra,
    });
    const h = harness();
    h.downloads.push(entry('d2', 'in_progress', { startedAt: 300 }), entry('d1', 'completed', { completedAt: 200 }));
    const all = await h.call('host/browser/downloads', { sessionId: 's1', op: 'list' });
    assert.equal(all.items.length, 2);
    const since = await h.call('host/browser/downloads', { sessionId: 's1', op: 'list', since: 250 });
    assert.deepEqual(
      since.items.map((item) => item.id),
      ['d2']
    );
    await assert.rejects(
      h.call('host/browser/downloads', { sessionId: 's1', op: 'take', id: 'd2' }),
      /wait for completion/
    );
    await assert.rejects(
      h.call('host/browser/downloads', { sessionId: 's1', op: 'take', id: 'd9' }),
      /unknown download d9/
    );
    await assert.rejects(h.call('host/browser/downloads', { op: 'list' }), (error) => error.code === -32602);
    const taken = await h.call('host/browser/downloads', { sessionId: 's1', op: 'take' });
    assert.equal(taken.items[0].id, 'd1');
    h.downloads[1].mimeType = 'application/octet-stream';
    h.downloads[1].file = 'report.pdf';
    assert.equal((await h.call('host/browser/downloads', { sessionId: 's1', op: 'take', id: 'd1' })).items[0].mimeType, 'application/pdf');
    assert.deepEqual(taken.blob, { digest: `sha256:${createHash('sha256').update('hello').digest('hex')}`, size: 5 });
    assert.equal(h.puts[0].method, 'blob/put');
    assert.equal(Buffer.from(h.puts[0].params.bytesB64, 'base64').toString(), 'hello');
    assert.ok(!JSON.stringify(taken.items).includes('abcdef123456789012345678'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
