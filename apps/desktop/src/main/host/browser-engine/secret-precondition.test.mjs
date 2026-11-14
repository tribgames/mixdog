import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createSecretInputs } from '../../secret-input.ts';
import { createBrowserCredentialFill } from '../../browser/credential-autofill.ts';
import { runSecretFill } from '../../browser/host-agent.ts';
import { createSavedLoginHost } from '../../browser/saved-login-host.ts';
import { HostRpcError } from '../connection.ts';
import { registerEngineMethod } from './registry.ts';
import { documentIdOf } from './precondition.ts';
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

test('after a typed secret no engine frame or transcript line carries it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-secret-'));
  try {
    const w = world();
    assert.deepEqual(await fillWith(w, { documentId: documentIdOf(w.state) }), { text: 'entered' });
    const wire = [];
    const handlers = new Map();
    const connection = {
      request: async (method, params) => {
        wire.push({ method, params });
        return {};
      },
      handleRequest: (method, handler) => handlers.set(method, handler),
    };
    const ctx = {
      page: (pageId) =>
        pageId === 'p1' ? { guest: { ...w.guest, getURL: () => `${ORIGIN}/?k=${SECRET}`, isDestroyed: () => false }, state: w.state } : undefined,
      session: () => undefined,
      cdp: {},
      events: {
        flush: (pageId) => wire.push({ method: 'host/browser/events', params: { pageId, events: [] } }),
        facts: (pageId) => ({ pageId, seq: 2, url: `${ORIGIN}/?k=${SECRET}`, title: `t ${SECRET}` }),
      },
      redactKnown: (_pageId, text) => (w.secrets.has(SECRET) ? text.replaceAll(SECRET, '[redacted]') : text),
      isEngineMode: () => true,
      transcript: createTranscriptTap({ dir, devBuild: true }),
    };
    registerEngineMethod(connection, ctx, 'host/browser/read', async () => ({
      text: `page ${SECRET}`,
      url: `${ORIGIN}/?k=${SECRET}`,
    }));
    registerEngineMethod(connection, ctx, 'host/browser/fail', async () => {
      throw new Error(`failed on ${SECRET}`);
    });
    const signal = new AbortController().signal;
    wire.push({ method: 'reply', params: await handlers.get('host/browser/read')({ pageId: 'p1' }, signal) });
    await handlers.get('host/browser/fail')({ pageId: 'p1' }, signal).catch((error) => {
      wire.push({ method: 'error', params: { code: error.code, message: error.message, data: error.data } });
    });
    const lines = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8'));
    assert.ok(lines.join('').length > 0, 'the tap recorded');
    assert.ok(!JSON.stringify(wire).includes(SECRET), 'no frame carries the secret');
    assert.ok(!lines.join('').includes(SECRET), 'the transcript does not carry it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
