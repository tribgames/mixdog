// The header copy a save keeps as failure evidence is only deserialized when a
// failure needs it: a successful save never runs structuredClone or a v8
// deserialize on it, and every failure path still gets the header exactly as it
// was when the payload was posted, whatever the live session did afterwards.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import v8 from 'node:v8';
import { Worker } from 'node:worker_threads';

const root = mkdtempSync(join(tmpdir(), 'mixdog-save-evidence-header-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';
mkdirSync(join(root, 'sessions'));

const { saveSessionAsync, saveSessionDurably } = await import('../store.mjs');
const { getFailedSaveSnapshot } = await import('./live-state.mjs');
const { _saveWorkerForTest, _setSaveWorkerHungMsForTest } = await import('./save-worker.mjs');
const { _attemptEvidence, _buildWirePayload, _clearDeltaBaselines } = await import('./save-delta.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

const originalStructuredClone = globalThis.structuredClone;

// Fires right after a write is handed to the worker, i.e. at post time.
let afterPost = null;
const originalPost = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  const result = originalPost.call(this, message, ...rest);
  if (message && message.reqId !== undefined) afterPost?.(message);
  return result;
};

test.after(async () => {
  Worker.prototype.postMessage = originalPost;
  _setSaveWorkerHungMsForTest(null);
  _clearDeltaBaselines();
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const catalog = (tag, count) =>
  Array.from({ length: count }, (_, index) => ({
    name: `${tag}_${index}`,
    description: `${tag} tool ${index} `.padEnd(200, 'd'),
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }));

/** A session with a header far larger than its transcript. */
function bigHeaderSession(id) {
  return {
    id,
    owner: 'user',
    generation: 0,
    closed: false,
    title: 'at post',
    tools: catalog('tool', 30),
    deferredToolCatalog: catalog('deferred', 300),
    deferredLateToolCatalog: catalog('late', 100),
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
  };
}

test('a successful save runs no structuredClone or v8 deserialize on the evidence header', async (t) => {
  const cloned = [];
  const originalClone = globalThis.structuredClone;
  globalThis.structuredClone = (value, options) => {
    cloned.push(value);
    return originalClone(value, options);
  };
  let deserialized = 0;
  const originalDeserialize = v8.deserialize;
  v8.deserialize = (...args) => {
    deserialized += 1;
    return originalDeserialize.apply(v8, args);
  };
  t.after(() => {
    globalThis.structuredClone = originalClone;
    v8.deserialize = originalDeserialize;
  });

  const session = bigHeaderSession('sess_evidence_success');
  await saveSessionAsync(session); // full
  session.messages = [...session.messages, { role: 'user', content: 'third' }];
  await saveSessionAsync(session); // delta

  assert.deepEqual(
    cloned.filter((value) => value && typeof value === 'object' && 'deferredToolCatalog' in value),
    [],
    'no header was structuredCloned'
  );
  assert.equal(deserialized, 0, 'no evidence header was deserialized');
});

for (const kind of ['full', 'delta']) {
  test(`${kind} attempt evidence is the header at post time, unaffected by later mutation`, () => {
    _clearDeltaBaselines();
    const id = `sess_evidence_unit_${kind}`;
    const session = bigHeaderSession(id);
    if (kind === 'delta') {
      _buildWirePayload(id, session);
      session.messages = [...session.messages, { role: 'user', content: 'third' }];
    }
    const wire = _buildWirePayload(id, session);
    assert.equal(Boolean(wire.delta), kind === 'delta');
    const postedHeader = wire.delta ? wire.delta.header : wire.session;
    const expected = originalStructuredClone({ ...postedHeader, messages: session.messages.slice() });

    // The live session moves on after the post, nested fields included.
    session.title = 'mutated';
    session.tools[0].name = 'mutated';
    session.tools.push({ name: 'added' });
    session.deferredToolCatalog[0].inputSchema.properties.value.type = 'number';
    session.deferredLateToolCatalog.length = 0;
    delete session.owner;

    assert.deepEqual(_attemptEvidence(wire.attempt), expected);
    assert.deepEqual(_attemptEvidence(wire.attempt), expected, 'evidence can be rebuilt again');
  });
}

// Values structuredClone treats differently from a plain v8 round-trip.
const cloneSensitive = () => ({
  blob: Buffer.from([1, 2, 3]),
  slice: Buffer.from('xyz-pooled').subarray(4),
  shared: new SharedArrayBuffer(8),
});

const cloneCases = {
  buffer: (evidence, expected) => {
    assert.equal(Buffer.isBuffer(evidence.blob), false);
    assert.ok(evidence.blob instanceof Uint8Array);
    assert.equal(JSON.stringify(evidence.blob), '{"0":1,"1":2,"2":3}');
    assert.equal(JSON.stringify(evidence.slice), JSON.stringify(expected.slice));
  },
  shared: (evidence) => {
    assert.ok(evidence.shared instanceof SharedArrayBuffer);
  },
};

for (const [valueKind, check] of Object.entries(cloneCases)) {
  for (const kind of ['full', 'delta']) {
    test(`${kind} attempt evidence matches structuredClone for a ${valueKind} value`, () => {
      _clearDeltaBaselines();
      const id = `sess_evidence_clone_${valueKind}_${kind}`;
      const { blob, slice, shared } = cloneSensitive();
      const session = { ...bigHeaderSession(id), ...(valueKind === 'buffer' ? { blob, slice } : { shared }) };
      if (kind === 'delta') {
        _buildWirePayload(id, session);
        session.messages = [...session.messages, { role: 'user', content: 'third' }];
      }
      const wire = _buildWirePayload(id, session);
      assert.equal(Boolean(wire.delta), kind === 'delta');
      const postedHeader = wire.delta ? wire.delta.header : wire.session;
      const expected = originalStructuredClone({ ...postedHeader, messages: session.messages.slice() });
      if (session.blob) session.blob[0] = 99; // later mutation of the live bytes

      const evidence = _attemptEvidence(wire.attempt);
      assert.notEqual(evidence, null, 'a header structuredClone accepts keeps its evidence');
      assert.deepEqual(evidence, expected);
      check(evidence, expected);
    });
  }
}

test('a header structuredClone refuses still records no evidence', () => {
  _clearDeltaBaselines();
  const session = { ...bigHeaderSession('sess_evidence_unclonable'), hook: () => {} };
  assert.equal(_buildWirePayload('sess_evidence_unclonable', session).attempt, null);
});

test('a hung worker records the header as it was at post time, even after the live session changed', async () => {
  const id = 'sess_evidence_hung';
  const session = { ...bigHeaderSession(id), ...cloneSensitive() };
  await saveSessionDurably(session);
  assert.equal(_setSaveWorkerHungMsForTest(300), true);

  const silent = _saveWorkerForTest();
  silent.removeAllListeners('message');
  session.messages = [...session.messages, { role: 'assistant', content: 'unsaved' }];
  let expected;
  afterPost = (message) => {
    const header = message.delta ? message.delta.header : message.session;
    // What the worker received: the header structured-cloned, then written as JSON.
    expected = JSON.parse(JSON.stringify(originalStructuredClone({ ...header, messages: undefined })));
    session.title = 'mutated after post';
    session.tools[0].name = 'mutated after post';
    session.deferredToolCatalog.length = 0;
  };
  try {
    await assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' });
  } finally {
    afterPost = null;
  }

  assert.equal(expected.title, 'at post');
  const snapshot = getFailedSaveSnapshot(id);
  assert.deepEqual(
    snapshot.messages.map((message) => message.content),
    ['first', 'second', 'unsaved']
  );
  const { messages: _messages, ...header } = snapshot;
  assert.deepEqual(header, JSON.parse(JSON.stringify({ ...expected })));
  assert.equal(header.deferredToolCatalog.length, 300);
  assert.deepEqual(header.blob, { 0: 1, 1: 2, 2: 3 }, 'a Buffer is evidenced as the worker received it');
});
