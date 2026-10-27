import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGrepPatternFanout } from './lib/grep-pattern-fanout.mjs';
import { runSharedNativeScan } from './lib/shared-native-scan.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';

const TIMEOUT = { timeout: 10_000 };

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-share-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function request(root, options, overrides = {}) {
  return {
    args: {},
    patterns: ['alpha', 'beta'],
    workDir: root,
    executeChildBuiltinTool: async () => '',
    readStateScope: null,
    options,
    callContextCharBudget: 4_096,
    patternCapNote: '',
    searchPath: '.',
    grepResolvedPath: root,
    normalizedGlobPatterns: [],
    outputMode: 'content',
    headLimit: 10,
    offset: 0,
    caseInsensitive: false,
    showLineNumbers: true,
    beforeN: null,
    afterN: null,
    contextN: 0,
    multilineMode: false,
    pcre2Mode: false,
    fileType: '',
    executeGrepTool: async () => 'no matches',
    ...overrides,
  };
}

// Every backend call is held until released; waitCalls(n) resolves once n
// calls have started. Cleanup releases anything still held.
function heldBackend(t, result) {
  const calls = [];
  const waiters = [];
  const run = (argv, spawn, window) => {
    const hold = Promise.withResolvers();
    calls.push({ argv, spawn, window, hold });
    for (const w of waiters.filter((x) => calls.length >= x.n)) w.resolve();
    return hold.promise.then(() => result);
  };
  const waitCalls = (n) => {
    if (calls.length >= n) return Promise.resolve();
    const w = { n, ...Promise.withResolvers() };
    waiters.push(w);
    return w.promise;
  };
  const release = (i) => calls[i].hold.resolve();
  const releaseAll = () => calls.forEach((c) => c.hold.resolve());
  t.after(releaseAll);
  return { calls, run, waitCalls, release, releaseAll };
}

// An AbortSignal whose abort-listener registrations (one per joined
// single-flight subscription) are observable.
function subscriber(t) {
  const controller = new AbortController();
  const waiters = [];
  let count = 0;
  const add = controller.signal.addEventListener;
  t.mock.method(controller.signal, 'addEventListener', function (type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (type === 'abort') {
      count += 1;
      for (const w of waiters.filter((x) => count >= x.n)) w.resolve();
    }
    return result;
  });
  const subscribed = (n) => {
    if (count >= n) return Promise.resolve();
    const w = { n, ...Promise.withResolvers() };
    waiters.push(w);
    return w.promise;
  };
  return { controller, signal: controller.signal, subscribed };
}

const clean = { lines: [], complete: true, partial: false };

test('identical concurrent combined scans share one backend call', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const a = subscriber(t);
  const b = subscriber(t);
  const runs = [
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal })),
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal })),
  ];
  await Promise.all([backend.waitCalls(1), a.subscribed(1), b.subscribed(1)]);
  backend.releaseAll();
  const [x, y] = await Promise.all(runs);
  assert.equal(backend.calls.length, 1);
  assert.equal(x, y);
});

test('fallback prefilters share one backend call after the combined stage', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  // complete:false declines the combined pass, then the prefilter.
  const backend = heldBackend(t, { lines: [], complete: false, partial: false });
  const a = subscriber(t);
  const b = subscriber(t);
  const runs = [
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal })),
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal })),
  ];
  await Promise.all([backend.waitCalls(1), a.subscribed(1), b.subscribed(1)]);
  backend.release(0);
  // Prefilter stage: held until both callers have joined it.
  await Promise.all([backend.waitCalls(2), a.subscribed(2), b.subscribed(2)]);
  assert.equal(backend.calls.length, 2);
  backend.release(1);
  await Promise.all(runs);
  assert.equal(backend.calls.length, 2);
});

test('different request semantics stay independent', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const opts = { __runRgWindowedLines: backend.run };
  const runs = [
    runGrepPatternFanout(request(root, { ...opts })),
    runGrepPatternFanout(request(root, { ...opts }, { patterns: ['alpha', 'gamma'] })),
    // 2 * (500 + 4) raw lines changes the backend window; headLimit 10 is
    // floored to the 400-line minimum.
    runGrepPatternFanout(request(root, { ...opts }, { headLimit: 500 })),
    runGrepPatternFanout(request(root, { ...opts }, { caseInsensitive: true })),
  ];
  await backend.waitCalls(4);
  assert.equal(backend.calls.length, 4);
  assert.deepEqual(
    backend.calls.map((call) => call.window.limit).sort((a, b) => a - b),
    [400, 400, 400, 1008]
  );
  backend.releaseAll();
  await Promise.all(runs);
});

test('distinct presentation limits with an identical raw window share a scan', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const a = subscriber(t);
  const b = subscriber(t);
  const runs = [
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal }, { headLimit: 10 })),
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal }, { headLimit: 20 })),
  ];
  await Promise.all([backend.waitCalls(1), a.subscribed(1), b.subscribed(1)]);
  backend.releaseAll();
  await Promise.all(runs);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].window.limit, 400);
});

test('shared helper does not share differing bulkHint values', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const scan = (bulkHint) =>
    runSharedNativeScan(backend.run, {
      cwd: root,
      argv: ['--files-with-matches', 'x'],
      window: { offset: 0, limit: 400, summaryLimit: 0, bulkHint },
      scopes: [root],
    });
  const runs = [scan(true), scan(false), scan(true)];
  await backend.waitCalls(2);
  backend.releaseAll();
  await Promise.all(runs);
  assert.equal(backend.calls.length, 2);
});

test('one subscriber cancelling does not cancel the shared scan', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const a = subscriber(t);
  const b = subscriber(t);
  const survivor = runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal }));
  const cancelled = runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal }));
  await Promise.all([backend.waitCalls(1), a.subscribed(1), b.subscribed(1)]);
  const rejected = assert.rejects(cancelled);
  b.controller.abort();
  await rejected;
  assert.equal(backend.calls[0].spawn.signal.aborted, false);
  backend.releaseAll();
  await survivor;
  assert.equal(backend.calls.length, 1);
});

test('all subscribers cancelling aborts the shared scan', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const a = subscriber(t);
  const b = subscriber(t);
  const runs = [
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal })),
    runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal })),
  ];
  await Promise.all([backend.waitCalls(1), a.subscribed(1), b.subscribed(1)]);
  const rejected = runs.map((run) => assert.rejects(run));
  a.controller.abort();
  b.controller.abort();
  await Promise.all(rejected);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].spawn.signal.aborted, true);
});

test('mutation invalidation detaches the old scan', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  const backend = heldBackend(t, clean);
  const a = subscriber(t);
  const b = subscriber(t);
  const first = runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: a.signal }));
  await Promise.all([backend.waitCalls(1), a.subscribed(1)]);
  invalidateBuiltinResultCache([root]);
  const second = runGrepPatternFanout(request(root, { __runRgWindowedLines: backend.run, signal: b.signal }));
  await Promise.all([backend.waitCalls(2), b.subscribed(1)]);
  assert.equal(backend.calls.length, 2);
  assert.equal(backend.calls[0].spawn.signal.aborted, false);
  backend.releaseAll();
  await Promise.all([first, second]);
});

test('completed scans are not reused', TIMEOUT, async (t) => {
  const root = makeRoot(t);
  let calls = 0;
  const run = async () => {
    calls += 1;
    return clean;
  };
  await runGrepPatternFanout(request(root, { __runRgWindowedLines: run }));
  await runGrepPatternFanout(request(root, { __runRgWindowedLines: run }));
  assert.equal(calls, 2);
});
