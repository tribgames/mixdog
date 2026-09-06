import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserDocuments, BROWSER_DOCUMENT_ROOTS } from './documents.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserCommandQueue } from './command-queue.ts';
import { READ_ONLY_ACTIONS } from './command.ts';
import { flowActions } from './actions/flow.ts';
import { createBrowserSettle } from './settle.ts';
import { observationActions } from './actions/observe.ts';
import { createBrowserRemoteControl } from './remote-control.ts';
import { createBrowserPageState } from './page-state.ts';
import { createBrowserRefActions } from './ref-actions.ts';
import { normalizeAgentUrl, assertResolvedAddressAllowed } from './url-policy.ts';
import { createBrowserDownloads } from './downloads.ts';

const page = () => ({ getURL: () => 'https://fixture.example/', getTitle: () => 'Fixture', getZoomFactor: () => 1 });
test('canonical IPv4-mapped private and metadata addresses are rejected', () => {
  for (const address of ['::ffff:192.168.1.1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:0a00:0001']) {
    assert.throws(() => normalizeAgentUrl(`http://[${address}]/`), /private|metadata/);
  }
  assert.match(normalizeAgentUrl('http://[::ffff:8.8.8.8]/'), /808:808/);
  assert.throws(() => normalizeAgentUrl('http://[::ffff:a9fe:a9fe]/', { allowPrivateNetwork: true }), /metadata/);
  assert.throws(() => assertResolvedAddressAllowed('::ffff:a9fe:a9fe', 'fixture.example', { allowPrivateNetwork: true }), /metadata/);
});

test('cookie values stay private and known secrets remain masked in reads after navigation', async () => {
  const guest = page();
  const state = new BrowserGuestStateStore();
  const secret = 'opaque-credential-fixture-1234';
  state.rememberSecret(guest, secret);
  state.for(guest).remoteFrame = { frameId: 'old' };
  state.for(guest).refSet = { snapshotId: 'old' };
  state.beginDocument(guest);
  assert.equal(state.for(guest).remoteFrame, undefined);
  assert.equal(state.for(guest).refSet, undefined);
  const read = await observationActions.read({
    guest, command: { action: 'read' }, services: { state,
      documents: { readPage: async () => ({ url: guest.getURL(), title: 'Fixture', text: secret, total: secret.length, offset: 0 }) },
    },
  });
  assert.ok(!read.text.includes(secret));
  const cookies = createBrowserPageState({
    partitionSession: { cookies: { get: async () => [{ name: 'sid', value: secret, httpOnly: true }] } },
    urlPolicy: () => ({}),
  });
  assert.ok(!(await cookies.cookiesResult(guest, { action: 'cookies' })).text.includes(secret));
});

test('same-page observations serialize their generations while independent pages overlap', async () => {
  let active = 0;
  let peak = 0;
  const queue = createBrowserCommandQueue({
    chains: new Map(), pendingReads: new Map(), backgroundEntryByPageId: () => null,
    readOnlyActions: READ_ONLY_ACTIONS, commandTimeoutMs: 1000, bounded: async (p) => p,
    run: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { text: 'observed' };
    },
  });
  await Promise.all(['snapshot', 'locate', 'wait'].map((action) => queue.executeSerialized({ action })));
  assert.equal(peak, 1);
  await Promise.all(['a', 'b'].map((tab) => queue.executeSerialized({ action: 'snapshot', background: true, tab })));
  assert.equal(peak, 2);
});

test('failed observation cannot satisfy textGone and blocked sequence steps never count as completed', async () => {
  const guest = page();
  let probes = 0;
  const waited = await flowActions.wait({
    guest, command: { action: 'wait', textGone: 'Saving' },
    services: {
      documents: { pageText: async () => { if (++probes === 1) throw new Error('context destroyed'); return 'Saved'; } },
      reply: { snapshotResult: async () => ({ text: 'Saved' }) },
    },
  });
  assert.equal(probes, 2);
  assert.match(waited.text, /Condition met/);
  const settle = createBrowserSettle({ pageText: async () => { throw new Error('frame unavailable'); } });
  assert.equal(await settle.postconditionMatchesGuest(guest, { textGone: 'Saving' }), false);
  let calls = 0;
  await assert.rejects(flowActions.sequence({
    guest, command: { action: 'sequence', steps: [{ action: 'click' }, { action: 'click' }] },
    services: {
      state: new BrowserGuestStateStore(),
      runCommand: async () => { calls++; return { outcome: 'blocked', text: 'dialog blocked' }; },
      reply: { snapshotResult: async () => ({ text: 'dialog blocked' }) },
    },
  }), /Sequence stopped.*no step completed/);
  assert.equal(calls, 1);
});

test('remote frame is consumed once and changed pixels or revisions refuse input', async () => {
  for (const variant of ['same', 'pixels', 'revision']) {
    const guest = page();
    const state = new BrowserGuestStateStore();
    let taps = 0;
    const remote = createBrowserRemoteControl({
      state, ensureGuest: async () => guest, noteRemoteViewer() {}, cdp: {},
      revision: async () => variant === 'revision' ? 'new' : 'old',
      captureScreenshot: async () => ({ data: variant === 'pixels' ? 'new' : 'pixels' }),
      input: { tapAt: async () => { taps++; } },
    });
    state.for(guest).remoteFrame = {
      frameId: 'frame', url: guest.getURL(), capturedAt: Date.now(), revision: 'old',
      image: { data: 'pixels' },
    };
    const command = { type: 'tap', frameId: 'frame', x: 1, y: 1 };
    if (variant === 'same') {
      await remote.remoteBrowserControl('s', command);
      assert.equal(taps, 1);
      await assert.rejects(remote.remoteBrowserControl('s', command), /stale/);
    } else {
      await assert.rejects(remote.remoteBrowserControl('s', command), /changed/);
      assert.equal(taps, 0);
    }
  }
});

test('fill respects readonly, disabled and disabled fieldset in AX and fallback paths', async () => {
  const dom = new JSDOM('<input readonly value="original"><fieldset disabled><input value="original"></fieldset><input disabled value="original">', { runScripts: 'outside-only' });
  try {
    for (const input of dom.window.document.querySelectorAll('input')) {
      input.scrollIntoView = () => {};
      for (const ax of [true, false]) {
        dom.window.__mixdogAgentSnapshot = { refs: new Map([['ref', input]]) };
        const refs = createBrowserRefActions({
          callAccessibilityRef: async (_guest, _ref, source, args) => ax
            ? { handled: true, value: dom.window.Function(`return (${source})`)().apply(input, args) }
            : { handled: false },
          evaluate: async (_guest, source) => dom.window.eval(source),
        });
        await assert.rejects(refs.fillRef(page(), 'ref', 'changed'), /readonly|disabled/);
        assert.equal(input.value, 'original');
      }
    }
  } finally { dom.window.close(); }
});

test('download wait pins newest file rather than an older completed download', async () => {
  const entries = [
    { id: 'new', file: 'new', path: 'new', url: '', total: 1, mimeType: 'text/plain', state: 'in_progress' },
    { id: 'old', file: 'old', path: 'old', url: '', total: 1, mimeType: 'text/plain', state: 'completed' },
  ];
  let polls = 0;
  const downloads = createBrowserDownloads({
    downloads: () => entries, pause: async () => { polls++; entries[0].state = 'completed'; }, attachMaxBytes: 1,
  });
  await downloads.listDownloads('s', { wait: true });
  assert.equal(polls, 1);
});

test('document traversal includes open shadow roots and uses child target contexts', async () => {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'outside-only' });
  dom.window.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<span>inside</span>';
  assert.equal(dom.window.eval(`(${BROWSER_DOCUMENT_ROOTS})()`).length, 2);
  dom.window.close();
  const calls = [];
  let failure = false;
  const documents = createBrowserDocuments({
    sessions: () => new Map([['child', { type: 'iframe', frameId: 'child-frame' }]]),
    cdp: {
      guestDebugger: async () => ({}),
      call: async (_guest, method, params, _signal, options) => {
        calls.push([method, options?.sessionId]);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: options?.sessionId ? 'child-frame' : 'root' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (failure && options?.sessionId) throw new Error('frame unavailable');
        return { result: { value: options?.sessionId ? 'child text' : 'root text' } };
      },
    },
  });
  assert.equal(await documents.pageText(page()), 'root text\nchild text');
  assert.ok(calls.some(([method, session]) => method === 'Runtime.evaluate' && session === 'child'));
  failure = true;
  await assert.rejects(documents.pageText(page()), /frame unavailable/);
});
