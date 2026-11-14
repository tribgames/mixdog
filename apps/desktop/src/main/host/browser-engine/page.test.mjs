import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerPage } from './page.ts';

const DOC = 'p1:1';

function harness({ policy, loadURL, dialog = null } = {}) {
  const handlers = new Map();
  const log = [];
  const sent = [];
  const connection = {
    request: async () => ({}),
    handleRequest: (method, handler) => handlers.set(method, handler),
  };
  const guest = {
    getURL: () => 'https://a.example/',
    getTitle: () => 'A',
    isDestroyed: () => false,
    isLoading: () => false,
    stop: () => log.push('stop'),
    reload: () => log.push('reload'),
    loadURL: (url) => {
      log.push(`load ${url}`);
      return loadURL ? loadURL(url) : Promise.resolve();
    },
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => log.push('back'),
      goForward: () => log.push('forward'),
    },
  };
  const state = {
    pageId: 'p1',
    documentGeneration: 1,
    cdpSessions: new Map([['s1', { type: 'iframe', frameId: 'f1' }]]),
    pendingDialog: dialog,
    openedPopups: [],
  };
  let revisions = 0;
  const ctx = {
    page: (id) => (id === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {
      guestDebugger: async () => ({}),
      releaseObject: (_g, objectId) => log.push(`release ${objectId}`),
      call: async (_guest, method, params, _signal, options = {}) => {
        options.beforeDispatch?.();
        sent.push({ method, params, options });
        return ctx.replies[method]?.(params) ?? {};
      },
    },
    replies: {},
    events: {
      flush: (id) => log.push(`flush ${id}`),
      facts: (id) => ({ pageId: id, seq: 1 }),
    },
    redactKnown: (_id, text) => text,
    isEngineMode: () => true,
  };
  const host = {
    store: { invalidateInteraction: () => log.push('invalidate'), for: () => ({ networkFailures: [] }) },
    urls: {
      validatedAgentUrl: async (raw, link) => {
        log.push(`admit ${raw}${link ? ` link:${link.from_domain}` : ''}`);
        if (policy) throw new Error(policy);
        return raw.startsWith('http') ? raw : `https://${raw}/`;
      },
    },
    documents: {
      readPage: async (_guest, _query, maxChars, offset) => ({
        url: 'u',
        title: 't',
        text: 'hello'.slice(offset, offset + maxChars),
        total: 5,
        unfilteredTotal: 5,
        offset: Math.min(offset, 5),
      }),
      extractPage: async () => ({ rows: [{ text: 'x' }], total: 3, columns: '' }),
      renderCheckpoint: async () => true,
      revision: async () => `0:1:1:1:0:0:${++revisions * 4}:0`,
      collect: Object.assign(async () => [], {
        byFrame: async (_g, expression) =>
          expression.includes('readyState')
            ? [
                ['f0', { url: 'https://a.example/' }],
                ['f1', { url: 'https://b.example/' }],
              ]
            : [
                ['f0', 'main'],
                ['f1', 'inner'],
              ],
      }),
    },
    handleDialog: async (_g, accept, promptText, _s, before) => {
      before?.();
      log.push(`answer ${accept} ${promptText}`);
    },
    downloadsForSession: () => [],
    sessionIdOf: () => 'sess',
    isBackground: () => false,
    consoleFloor: () => 42,
  };
  registerPage(connection, ctx, host);
  const call = (method, params) => handlers.get(`host/browser/page/${method}`)(params, new AbortController().signal);
  return { call, log, sent, ctx, state, host };
}

test('navigate to a url the policy refuses is -32015 with the reason, and nothing loads', async () => {
  const h = harness({ policy: 'navigation to private address is blocked' });
  await assert.rejects(
    h.call('navigate', { pageId: 'p1', kind: 'url', url: 'http://10.0.0.1/', expect: { documentId: DOC } }),
    (e) => e.code === -32015 && e.data.reason === 'navigation to private address is blocked'
  );
  assert.equal(h.log.some((l) => l.startsWith('load')), false);
});

test('navigate loads the admitted url once the expect still holds, and invalidates the refs', async () => {
  const h = harness();
  const result = await h.call('navigate', { pageId: 'p1', kind: 'url', url: 'example.org', expect: { documentId: DOC } });
  assert.deepEqual(
    h.log.filter((l) => l !== 'flush p1'),
    ['admit example.org', 'invalidate', 'load https://example.org/']
  );
  assert.equal(result.facts.pageId, 'p1');
});

test('navigate whose expect moved between the admission and the load is -32010 and does not load', async () => {
  const h = harness();
  h.ctx.cdp.guestDebugger = async () => {
    h.state.documentGeneration += 1;
    return {};
  };
  await assert.rejects(
    h.call('navigate', { pageId: 'p1', kind: 'url', url: 'example.org', expect: { documentId: DOC } }),
    (e) => e.code === -32010 && e.data.reason === 'document'
  );
  assert.equal(h.log.some((l) => l.startsWith('load')), false);
});

test('a mail link is handed to the policy as a link of its own host', async () => {
  const h = harness();
  await h.call('navigate', {
    pageId: 'p1',
    kind: 'url',
    url: 'https://m.example/verify?t=1',
    mailLink: { url: 'https://m.example/verify?t=1', expiresAt: Date.now() + 1000 },
    expect: { documentId: DOC },
  });
  assert.ok(h.log.includes('admit https://m.example/verify?t=1 link:m.example'));
});

test('an aborted load is not a failure, a real one is -32000', async () => {
  const aborted = harness({ loadURL: () => Promise.reject(new Error('ERR_ABORTED (-3)')) });
  await aborted.call('navigate', { pageId: 'p1', kind: 'url', url: 'example.org', expect: { documentId: DOC } });
  const broken = harness({ loadURL: () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED')) });
  await assert.rejects(
    broken.call('navigate', { pageId: 'p1', kind: 'url', url: 'example.org', expect: { documentId: DOC } }),
    (e) => e.code === -32000 && /navigation failed: ERR_NAME_NOT_RESOLVED/.test(e.message)
  );
});

test('a dialog that opens during the load ends the wait', async () => {
  const h = harness({ loadURL: () => new Promise(() => {}) });
  const pending = h.call('navigate', { pageId: 'p1', kind: 'url', url: 'example.org', expect: { documentId: DOC } });
  setTimeout(() => (h.state.pendingDialog = { type: 'alert', message: 'm', openedAt: 1 }), 10);
  const result = await pending;
  assert.equal(result.facts.pageId, 'p1');
});

test('reload, back and forward act on the guest; a missing history entry is answered as a refusal line', async () => {
  const h = harness();
  await h.call('navigate', { pageId: 'p1', kind: 'reload', expect: { documentId: DOC } });
  await h.call('navigate', { pageId: 'p1', kind: 'back', expect: { documentId: DOC } });
  assert.ok(h.log.includes('reload') && h.log.includes('back'));
  const none = await h.call('navigate', { pageId: 'p1', kind: 'forward', expect: { documentId: DOC } });
  assert.equal(none.refused.reason, 'Cannot go forward: no later history entry.');
});

test('stop stops a loading page', async () => {
  const h = harness();
  h.ctx.page('p1').guest.isLoading = () => true;
  await h.call('stop', { pageId: 'p1' });
  assert.ok(h.log.includes('stop'));
});

test('eval sends Runtime.evaluate guarded by expect and returns the value', async () => {
  const h = harness();
  h.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 7 } });
  const result = await h.call('eval', { pageId: 'p1', expression: '3+4', timeoutMs: 1000, expect: { documentId: DOC } });
  assert.equal(result.value, 7);
  const [sent] = h.sent;
  assert.equal(sent.method, 'Runtime.evaluate');
  assert.equal(sent.params.returnByValue, true);
  assert.equal(typeof sent.options.beforeDispatch, 'function');
  h.state.documentGeneration += 1;
  assert.throws(() => sent.options.beforeDispatch(), (e) => e.code === -32010);
});

test('an exception of the script is answered as exception details and invalidates the refs', async () => {
  const h = harness();
  h.ctx.replies['Runtime.evaluate'] = () => ({
    exceptionDetails: { text: 'Uncaught', lineNumber: 2, columnNumber: 5, exception: { description: 'Error: x' } },
  });
  const result = await h.call('eval', { pageId: 'p1', expression: 'throw 1', timeoutMs: 1000 });
  assert.deepEqual(result.exception, { text: 'Error: x', line: 2, column: 5 });
  assert.ok(h.log.includes('invalidate'));
});

test('a successful eval keeps the refs only when the page provably did not change', async () => {
  const h = harness();
  h.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 1 } });
  await h.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000 });
  assert.ok(h.log.includes('invalidate'), 'no refs held: nothing proves the page unchanged');

  const changed = harness();
  changed.state.refSet = { snapshotId: 's1' };
  changed.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 1 } });
  await changed.call('eval', { pageId: 'p1', expression: 'document.body.append("x")', timeoutMs: 1000 });
  assert.ok(changed.log.includes('invalidate'), 'the revision moved');

  const same = harness();
  same.state.refSet = { snapshotId: 's1' };
  same.host.documents.revision = async () => '0:1:1:1:0:0:4:0';
  same.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 1 } });
  await same.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000 });
  assert.ok(!same.log.includes('invalidate'), 'same document, url and revision keep the refs');
});

test('eval in the utility world runs in an isolated world of the frame', async () => {
  const h = harness();
  h.ctx.replies['Page.getFrameTree'] = () => ({ frameTree: { frame: { id: 'main' } } });
  h.ctx.replies['Page.createIsolatedWorld'] = () => ({ executionContextId: 9 });
  h.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 'ok' } });
  await h.call('eval', { pageId: 'p1', expression: '1', world: 'utility', timeoutMs: 1000 });
  assert.deepEqual(
    h.sent.map((s) => s.method),
    ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate']
  );
  assert.equal(h.sent[1].params.frameId, 'main');
  assert.equal(h.sent[2].params.contextId, 9);
});

test('eval names a frame by an attached session; a dialog blocks it with -32014', async () => {
  const h = harness();
  await assert.rejects(
    h.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000, frame: { sessionId: 'nope' } }),
    (e) => e.code === -32000
  );
  await assert.rejects(
    h.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000, frame: { frameId: 'f9' } }),
    (e) => e.code === -32000
  );
  h.ctx.replies['Runtime.evaluate'] = () => ({ result: { value: 1 } });
  await h.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000, frame: { sessionId: 's1' } });
  assert.equal(h.sent.at(-1).options.sessionId, 's1');
  const blocked = harness({ dialog: { type: 'confirm', message: 'sure?', openedAt: 3, bridgeRequestId: 'r' } });
  await assert.rejects(
    blocked.call('eval', { pageId: 'p1', expression: '1', timeoutMs: 1000 }),
    (e) => e.code === -32014 && e.data.dialog.type === 'confirm' && e.data.dialog.bridge === true
  );
  assert.equal(blocked.sent.length, 0);
});

test('read answers text, a selector, a frame, documents and frames', async () => {
  const h = harness();
  const text = await h.call('read', { pageId: 'p1', kind: 'text' });
  assert.equal(text.payload.text, 'hello');
  assert.equal(text.truncated, false);
  // A text longer than one read returns is read in parts, each from where the last ended.
  const first = await h.call('read', { pageId: 'p1', kind: 'text', options: { maxChars: 2, offset: 1 } });
  assert.deepEqual([first.payload.text, first.payload.offset, first.truncated], ['el', 1, true]);
  const last = await h.call('read', { pageId: 'p1', kind: 'text', options: { maxChars: 4, offset: 3 } });
  assert.deepEqual([last.payload.text, last.truncated], ['lo', false]);
  const tail = await h.call('read', { pageId: 'p1', kind: 'text', options: { frame: { sessionId: 's1' }, maxChars: 10, offset: 2 } });
  assert.deepEqual([tail.payload.text, tail.payload.offset, tail.truncated], ['ner', 2, false]);
  const rows = await h.call('read', { pageId: 'p1', kind: 'text', options: { selector: 'a' } });
  assert.equal(rows.payload.total, 3);
  assert.equal(rows.truncated, true);
  const inFrame = await h.call('read', { pageId: 'p1', kind: 'text', options: { frame: { sessionId: 's1' } } });
  assert.equal(inFrame.payload.text, 'inner');
  const documents = await h.call('read', { pageId: 'p1', kind: 'documents' });
  assert.equal(documents.payload.documents.length, 2);
  h.ctx.replies['Page.getFrameTree'] = () => ({
    frameTree: { frame: { id: 'a', url: 'u' }, childFrames: [{ frame: { id: 'b', url: 'v' } }] },
  });
  const frames = await h.call('read', { pageId: 'p1', kind: 'frames' });
  assert.deepEqual(
    frames.payload.frames.slice(0, 2).map((f) => [f.frameId, f.parentFrameId ?? null]),
    [
      ['a', null],
      ['b', 'a'],
    ]
  );
  await assert.rejects(h.call('read', { pageId: 'p1', kind: 'nope' }), (e) => e.code === -32602);
});

test('renderCheckpoint and domQuiet answer with the facts', async () => {
  const h = harness();
  const checkpoint = await h.call('renderCheckpoint', { pageId: 'p1', timeoutMs: 500 });
  assert.equal(checkpoint.reached, true);
  h.ctx.replies['Runtime.evaluate'] = () => ({ result: {} });
  const quiet = await h.call('domQuiet', { pageId: 'p1', quietMs: 10, timeoutMs: 100 });
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.mutations, 4);
});

test('dialog/answer answers through the dialog report; with no dialog it answers false', async () => {
  const none = harness();
  assert.equal((await none.call('dialog/answer', { pageId: 'p1', accept: true, expect: { documentId: DOC } })).answered, false);
  const h = harness({ dialog: { type: 'prompt', message: 'm', openedAt: 1 } });
  const result = await h.call('dialog/answer', {
    pageId: 'p1',
    accept: true,
    promptText: 'yes',
    expect: { documentId: DOC },
  });
  assert.equal(result.answered, true);
  assert.ok(h.log.includes('answer true yes'));
  h.state.documentGeneration += 1;
  await assert.rejects(
    h.call('dialog/answer', { pageId: 'p1', accept: true, expect: { documentId: DOC } }),
    (e) => e.code === -32010
  );
});

test('sync sends the queued events first, then the facts and the console floor', async () => {
  const h = harness();
  const result = await h.call('sync', { pageId: 'p1' });
  assert.equal(result.consoleFloor, 42);
  assert.equal(result.facts.pageId, 'p1');
  assert.equal(h.log[0], 'flush p1');
});
