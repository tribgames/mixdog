// A PDF that never loads, or never yields a page, rejects at the deadline and
// its document is destroyed (pdf-extract.mjs inspectPdfBuffer).
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const never = new Promise(() => {});
let loading = () => never;
mock.module('unpdf', {
  namedExports: {
    definePDFJSModule: async () => {},
    getDocumentProxy: (...args) => loading(...args),
  },
});
const { inspectPdfBuffer } = await import('./pdf-extract.mjs');

const PDF = Buffer.from('%PDF-1.4\n');
const DEADLINE_MS = 20;
const timedOut = (error) => error.code === 'PDF_INSPECTION_TIMEOUT' && /timed out/.test(error.message);

// The deadline runs on node's mock clock: a test advances it only after the
// document has reached the stage under test, so no scenario races wall-clock
// time and a loaded machine cannot change the outcome.
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return t.mock.timers;
}

test('a document that never loads rejects at the deadline', async (t) => {
  const clock = mockClock(t);
  const requested = deferred();
  loading = () => {
    requested.resolve();
    return never;
  };
  const inspected = inspectPdfBuffer(PDF, { timeoutMs: DEADLINE_MS });
  await requested.promise;
  clock.tick(DEADLINE_MS);
  await assert.rejects(inspected, timedOut);
});

test('a document that stalls on a page is destroyed and rejects at the deadline', async (t) => {
  const clock = mockClock(t);
  const stalled = deferred();
  let destroyed = 0;
  loading = async () => ({
    numPages: 1,
    getPage: () => {
      stalled.resolve();
      return never;
    },
    destroy: async () => {
      destroyed += 1;
    },
  });
  const inspected = inspectPdfBuffer(PDF, { timeoutMs: DEADLINE_MS, extractText: true });
  await stalled.promise;
  clock.tick(DEADLINE_MS);
  await assert.rejects(inspected, timedOut);
  assert.ok(destroyed >= 1, 'the stalled document is destroyed');
});

test('a document that arrives after the deadline is destroyed on arrival', async (t) => {
  const clock = mockClock(t);
  const requested = deferred();
  const destroyedOnArrival = deferred();
  let destroyed = 0;
  let arrive;
  loading = () => {
    requested.resolve();
    return new Promise((resolve) => {
      arrive = resolve;
    });
  };
  const inspected = inspectPdfBuffer(PDF, { timeoutMs: DEADLINE_MS });
  await requested.promise;
  clock.tick(DEADLINE_MS);
  await assert.rejects(inspected, timedOut);
  assert.equal(destroyed, 0, 'nothing to destroy before the document arrives');
  arrive({
    numPages: 1,
    destroy: async () => {
      destroyed += 1;
      destroyedOnArrival.resolve();
    },
  });
  await destroyedOnArrival.promise;
  assert.equal(destroyed, 1);
});

test('a document inside the deadline is inspected as before', async (t) => {
  mockClock(t);
  let destroyed = 0;
  loading = async () => ({
    numPages: 3,
    destroy: async () => {
      destroyed += 1;
    },
  });
  assert.deepEqual(await inspectPdfBuffer(PDF, { timeoutMs: DEADLINE_MS }), {
    pageCount: 3,
    text: '',
    truncated: false,
  });
  assert.equal(destroyed, 1);
});

test('without a timeoutMs there is no deadline', async (t) => {
  const clock = mockClock(t);
  const requested = deferred();
  const loaded = deferred();
  loading = () => {
    requested.resolve();
    return loaded.promise;
  };
  const inspected = inspectPdfBuffer(PDF);
  await requested.promise;
  clock.tick(24 * 60 * 60 * 1000);
  loaded.resolve({ numPages: 2, destroy: async () => {} });
  assert.deepEqual(await inspected, { pageCount: 2, text: '', truncated: false });
});
