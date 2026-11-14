import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

import { createSecretInputs } from '../../secret-input.ts';
import { createBrowserCredentialFill } from '../../browser/credential-autofill.ts';
import { runSecretFill } from '../../browser/host-agent.ts';
import { createSavedLoginHost } from '../../browser/saved-login-host.ts';
import { HostRpcError } from '../connection.ts';
import { createEngineEvents } from './events.ts';
import { registerInputBatch } from './input-batch.ts';
import { createLeases } from './lease.ts';
import { registerCdpSend } from './cdp-send.ts';
import { documentIdOf } from './precondition.ts';
import { registerPage } from './page.ts';
import { registerPages } from './pages.ts';
import { registerRefCall } from './ref-call.ts';
import { registerRefMint } from './ref-mint.ts';
import { registerScreenshot } from './screenshot.ts';
import { createInterceptTable, registerSession } from './session.ts';
import { registerSnapshot } from './snapshot.ts';
import { registerUpload } from './upload.ts';
import { createTranscriptTap } from './transcript.ts';

const SECRET = 'S3CR3T-precondition-value-77';
const REQUEST = 'secret_0123456789abcdef';
const ORIGIN = 'https://bank.example';
const FACTS = (pageId) => ({ pageId, seq: 1 });

/** One page: its guest, its state (document generation, child sessions) and the CDP the fill sends through. */
function world({ onWorld } = {}) {
  const guest = { url: `${ORIGIN}/login`, getURL: () => guest.url, isDestroyed: () => false };
  const state = { pageId: 'p1', documentGeneration: 1, cdpSessions: new Map([['c1', {}]]) };
  const sent = [];
  const secrets = new Set();
  const cdp = {
    call: async (_guest, method, _params, _signal, options) => {
      options?.beforeDispatch?.();
      sent.push(method);
      switch (method) {
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
        case 'Page.createIsolatedWorld':
          onWorld?.({ guest, state });
          return { executionContextId: 1 };
        case 'DOM.resolveNode':
          return { object: { objectId: 'o1' } };
        case 'Runtime.callFunctionOn':
          return { result: { value: { filled: true } } };
        default:
          return {};
      }
    },
  };
  const fill = createBrowserCredentialFill({
    cdp,
    rememberSecret: (_g, secret) => secrets.add(secret),
    forgetSecret: (_g, secret) => secrets.delete(secret),
    redactText: (_g, text) => text,
  });
  const engine = {
    isEngineMode: () => true,
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    facts: FACTS,
  };
  return { guest, state, sent, secrets, fill, engine };
}

function host(w, extra = {}) {
  return {
    hostId: 'h',
    pageById: () => w.guest,
    fill: w.fill.fillSecretField,
    assertFree: () => undefined,
    engine: w.engine,
    ...extra,
  };
}

function bound() {
  const registry = createSecretInputs();
  registry.bind(REQUEST, {
    sessionId: 's1',
    pageId: 'p1',
    document: 'main:L1',
    origin: ORIGIN,
    form: 'otp',
    targets: [{ node: 5, type: 'text' }],
  });
  return registry;
}

const fillWith = (w, expect, extra) =>
  runSecretFill(host(w, extra), 's1', REQUEST, { value: SECRET, username: '', save: false, expect }, undefined, bound());

test('a cross-origin navigation between the precheck and the fill refuses it and nothing is typed', async () => {
  const w = world({
    onWorld: ({ guest, state }) => {
      state.documentGeneration += 1;
      guest.url = 'https://evil.example/';
    },
  });
  const out = await fillWith(w, { documentId: documentIdOf(w.state) });
  assert.deepEqual(out, { text: 'page_changed' });
  assert.ok(!w.sent.includes('Runtime.callFunctionOn'), 'no write reached the page');
});

test('a same-address reload between the precheck and the fill is refused as document, nothing typed', async () => {
  const w = world({ onWorld: ({ state }) => (state.documentGeneration += 1) });
  await assert.rejects(
    fillWith(w, { documentId: documentIdOf(w.state) }),
    (e) => e instanceof HostRpcError && e.code === -32010 && e.data.reason === 'document'
  );
  assert.ok(!w.sent.includes('Runtime.callFunctionOn'), 'no write reached the page');
});

test('a child session that went away refuses the write with childSession', async () => {
  const w = world({ onWorld: ({ state }) => state.cdpSessions.clear() });
  await assert.rejects(
    fillWith(w, { documentId: documentIdOf(w.state), childSessions: ['c1'] }),
    (e) => e.code === -32010 && e.data.reason === 'childSession'
  );
  assert.ok(!w.sent.includes('Runtime.callFunctionOn'));
});

test('a state that still holds is typed once, and the value is kept for redaction', async () => {
  const w = world();
  const out = await fillWith(w, { documentId: documentIdOf(w.state), origin: ORIGIN, childSessions: ['c1'] });
  assert.deepEqual(out, { text: 'entered' });
  assert.equal(w.sent.filter((m) => m === 'Runtime.callFunctionOn').length, 1);
  assert.ok(w.secrets.has(SECRET));
});

test('the takeover taken meanwhile blocks the write of a bound call', async () => {
  const w = world();
  let free = true;
  const out = await fillWith(w, { documentId: documentIdOf(w.state) }, {
    assertFree: () => {
      if (!free) throw new Error('takeover');
    },
    fill: (guest, request, signal) => {
      free = false;
      return w.fill.fillSecretField(guest, request, signal);
    },
  });
  assert.deepEqual(out, { text: 'blocked' });
  assert.ok(!w.sent.includes('Runtime.callFunctionOn'));
});

test('engine mode refuses a secret fill without expect with -32010 document, nothing typed', async () => {
  const w = world();
  await assert.rejects(fillWith(w, undefined), (e) => e.code === -32010 && e.data.reason === 'document');
  assert.deepEqual(w.sent, []);
  await assert.rejects(fillWith(w, 'p1:1'), (e) => e.code === -32010);
});

test('the forward path without an engine lane fills without expect', async () => {
  const w = world();
  const out = await fillWith(w, undefined, { engine: undefined });
  assert.deepEqual(out, { text: 'entered' });
});

test('saved_login_type is refused without expect in engine mode and checked beside the dispatch otherwise', async () => {
  const w = world();
  const dispatched = [];
  const saved = createSavedLoginHost({
    autoSignIn: () => true,
    credentials: {},
    worker: {
      run: async (command) => {
        dispatched.push(command);
        return { saved_login_response: { ok: true } };
      },
    },
    engine: w.engine,
    text: async () => ({}),
  });
  const input = { turn_id: 1, window_id: 'w1', account: 'a', field: 'password', text: 'x', expected: { name: 'f' } };
  saved.admit('s1', { turn_id: 1 });
  await assert.rejects(saved.type('s1', input), (e) => e.code === -32010 && e.data.reason === 'document');
  await assert.rejects(saved.type('s1', { ...input, expect: { documentId: 'p1:0' } }), (e) => e.data.reason === 'document');
  assert.equal(dispatched.length, 0);
  const ok = await saved.type('s1', { ...input, expect: { documentId: documentIdOf(w.state) } });
  assert.deepEqual(ok, { ok: true });
  assert.equal(dispatched.length, 1);
});

/**
 * A stand-in for everything a handler reaches the desktop through: any property is another stand-in, a call answers an
 * object whose strings carry the secret, so whatever a handler forwards or throws would leak it if the exits did not mask it.
 */
function leaky() {
  const answer = () => ({ text: SECRET, value: SECRET, url: `${ORIGIN}/?k=${SECRET}`, title: SECRET, message: SECRET, name: SECRET });
  return new Proxy(function () {}, {
    get: (_target, key) => (key === 'then' || key === 'toJSON' || typeof key === 'symbol' ? undefined : leaky()),
    apply: answer,
    construct: answer,
  });
}

/** The methods the protocol lists as the host's engine lane (every `host/browser/*` request but the two the host serves itself). */
function engineMethods() {
  const file = fileURLToPath(new URL('../../../../../../packages/protocol/src/index.ts', import.meta.url));
  const line = readFileSync(file, 'utf8').split('\n').find((text) => text.startsWith('export type ServerRequest ='));
  const names = [...line.matchAll(/"method": "(host\/browser\/[A-Za-z/]+)"/g)].map((match) => match[1]);
  return names.filter((name) => name !== 'host/browser/command' && name !== 'host/browser/liveControl');
}

const DOC = 'p1:1';
const PARAMS = {
  'host/browser/pages/resolve': { sessionId: 's1', tab: { pageId: 'p1' }, lease: { commandId: 'c1', ttlMs: 1000 } },
  'host/browser/pages/list': { sessionId: 's1' },
  'host/browser/pages/close': { pageId: 'p1', reason: 'agent' },
  'host/browser/pages/surface': { sessionId: 's1', op: 'reveal', pageId: 'p1' },
  'host/browser/page/navigate': { pageId: 'p1', kind: 'url', url: `${ORIGIN}/next`, expect: { documentId: DOC } },
  'host/browser/page/eval': { pageId: 'p1', expression: '1', expect: { documentId: DOC } },
  'host/browser/page/read': { pageId: 'p1', kind: 'text', options: {} },
  'host/browser/page/dialog/answer': { pageId: 'p1', accept: true },
  'host/browser/snapshot': { pageId: 'p1', mode: 'full', expect: { documentId: DOC } },
  'host/browser/ref/call': { pageId: 'p1', snapshotId: 's', ref: 'e1', functionDeclaration: 'function(){}', expect: { documentId: DOC } },
  'host/browser/ref/mint': { pageId: 'p1', snapshotId: 's', selector: 'a', limit: 50, expect: { documentId: DOC } },
  'host/browser/input/batch': {
    pageId: 'p1',
    steps: [{ op: 'type', text: 'a' }, { op: 'press', key: 'Enter' }],
    stopOnDialog: true,
    timeoutMs: 0,
    expect: { documentId: DOC },
  },
  'host/browser/screenshot': { pageId: 'p1', format: 'jpeg', expect: { documentId: DOC } },
  'host/browser/cdp/send': { pageId: 'p1', method: 'Page.getNavigationHistory', params: {} },
  'host/browser/cookies': { pageId: 'p1', op: 'get' },
  'host/browser/storage': { pageId: 'p1', op: 'get', area: 'local' },
  'host/browser/initScripts': { pageId: 'p1', op: 'list' },
  'host/browser/intercept': { pageId: 'p1', op: 'list' },
  'host/browser/performance': { pageId: 'p1', op: 'metrics' },
  'host/browser/emulation': { pageId: 'p1', overrides: null },
  'host/browser/downloads': { sessionId: 's1', op: 'list' },
  'host/browser/upload': { pageId: 'p1', paths: ['x'], expect: { documentId: DOC } },
};

const SESSION_DEPS = ['partitionSession', 'evaluate', 'invalidateInteractionState', 'applyFetchPatterns', 'tracesByGuest', 'processMemoryMb', 'pause', 'emulation', 'downloads', 'urlPolicy'];

test('after a typed secret and a submit, no engine reply, error, event or transcript line carries it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-secret-'));
  try {
    const w = world();
    assert.deepEqual(await fillWith(w, { documentId: documentIdOf(w.state) }), { text: 'entered' });
    assert.ok(w.secrets.has(SECRET), 'the host remembers the typed value for masking');

    const wire = [];
    const handlers = new Map();
    const connection = {
      request: async (method, params) => {
        wire.push({ method, params });
        return {};
      },
      notify: (method, params) => wire.push({ method, params }),
      handleRequest: (method, handler) => handlers.set(method, handler),
      handleNotification: (method, handler) => handlers.set(method, handler),
      onClose: () => undefined,
    };
    const leakyGuest = {
      ...w.guest,
      getURL: () => `${ORIGIN}/?k=${SECRET}`,
      getTitle: () => SECRET,
      isDestroyed: () => false,
      isLoading: () => false,
      isOffscreen: () => false,
      getZoomFactor: () => 1,
    };
    const redactKnown = (_pageId, text) => (w.secrets.has(SECRET) ? text.replaceAll(SECRET, '[redacted]') : text);
    const factsOf = (pageId) => ({ pageId, seq: 2, url: `${ORIGIN}/?k=${SECRET}`, title: `t ${SECRET}` });
    const events = createEngineEvents(connection, { nextSeq: () => 2, redact: redactKnown, facts: factsOf });
    const ctx = {
      page: (pageId) => (pageId === 'p1' ? { guest: leakyGuest, state: w.state } : undefined),
      session: () => undefined,
      cdp: leaky(),
      events,
      redactKnown,
      isEngineMode: () => true,
      transcript: createTranscriptTap({ dir, devBuild: true }),
    };
    ctx.leases = createLeases(connection, ctx);
    registerPages(connection, ctx, leaky());
    registerPage(connection, ctx, leaky());
    registerCdpSend(connection, ctx);
    registerSnapshot(connection, ctx, leaky());
    registerRefCall(connection, ctx, leaky());
    registerRefMint(connection, ctx);
    registerInputBatch(connection, ctx);
    registerScreenshot(connection, ctx, leaky());
    registerSession(connection, ctx, {
      ...Object.fromEntries(SESSION_DEPS.map((key) => [key, leaky()])),
      intercept: createInterceptTable(),
    });
    registerUpload(connection, ctx, { host: leaky(), invalidateInteractionState: leaky() });

    // Every method the protocol lists is served, so none is left out of the scan.
    const names = engineMethods();
    assert.ok(names.length >= 20, 'the protocol lists the engine methods');
    for (const name of names) assert.ok(handlers.has(name), `${name} is registered`);

    const signal = new AbortController().signal;
    const replies = [];
    for (const name of names) {
      const params = PARAMS[name] ?? { pageId: 'p1', sessionId: 's1' };
      // Once as asked, once bound to a document that is gone (the refusal carries the facts).
      for (const variant of [params, { ...params, expect: { documentId: 'p1:0' } }]) {
        try {
          replies.push({ name, reply: await handlers.get(name)(variant, signal) });
        } catch (error) {
          replies.push({ name, error: { code: error.code, message: error.message, data: error.data } });
        }
      }
    }
    events.push('p1', {
      method: 'Runtime.consoleAPICalled',
      params: { args: [{ type: 'string', value: SECRET }], url: `${ORIGIN}/?k=${SECRET}` },
    });
    events.push('p1', {
      method: 'Network.requestWillBeSent',
      params: { request: { url: `${ORIGIN}/?k=${SECRET}`, postData: SECRET, headers: { a: SECRET } } },
    });
    events.flush('p1');

    const lines = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
    assert.ok(lines.join('').length > 0, 'the tap recorded');
    assert.ok(replies.some((entry) => entry.reply !== undefined), 'some method answered');
    assert.ok(wire.some((frame) => frame.method === 'host/browser/events'), 'the events left');
    assert.deepEqual(replies.filter((entry) => JSON.stringify(entry).includes(SECRET)).map((entry) => entry.name), [], 'no reply or error carries the secret');
    assert.ok(!JSON.stringify(wire).includes(SECRET), 'no frame or notification carries the secret');
    assert.ok(!lines.join('').includes(SECRET), 'the transcript does not carry it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
