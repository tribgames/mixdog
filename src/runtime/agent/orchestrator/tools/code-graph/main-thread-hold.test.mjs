// Work moved off (or sliced on) the daemon main thread must answer exactly
// what the synchronous path answered (#308).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { _attachGraphRuntimeCaches, _estimateGraphRetainedBytes } from './graph-model.mjs';
import { _maskNonCodeText } from './text-mask.mjs';
import { _findSymbolHits, _prewarmMaskedSourceNodes, _prewarmSymbolSources, _runCodeGraphQuery } from './search.mjs';
import { _ensureTokenIndex } from './symbol-index.mjs';
import { _configureMaskPoolForTest, _maskTextsOffThread } from './mask-pool.mjs';
import { MAIN_THREAD_SLICE_MS } from './main-thread-slice.mjs';
import { _postCodeGraphWorkerSuccess, _codeGraphWorkerReceiver } from './build.mjs';

function syntheticGraph(fileCount) {
  const nodes = new Map();
  const texts = new Map();
  for (let i = 0; i < fileCount; i++) {
    const rel = `src/f${i}.mjs`;
    const text = [
      `// target() in a comment must not count`,
      `export function target${i % 3 === 0 ? '' : i}() { return "target"; }`,
      `const x = target();`,
      `/* target */ target(1);`,
    ].join('\n');
    texts.set(rel, text);
    nodes.set(rel, {
      rel,
      abs: `/repo/${rel}`,
      lang: 'javascript',
      fingerprint: `fp${i}`,
      tokenSymbols: ['target', `target${i}`, 'x'],
      symbols: [{ name: i % 3 === 0 ? 'target' : `target${i}`, kind: 'function', startLine: 2, endLine: 2 }],
      calls: Array.from({ length: 10 }, (_, col) => ['target', 3, col, 0, '', '']),
    });
  }
  const graph = _attachGraphRuntimeCaches({ cwd: '/repo', nodes, reverse: new Map() });
  for (const [rel, text] of texts) graph._sourceTextCache.set(rel, { fingerprint: nodes.get(rel).fingerprint, text });
  return graph;
}

test('prewarmed masking and memoized hits equal the synchronous computation', async () => {
  const warmed = syntheticGraph(60);
  const cold = syntheticGraph(60);
  await _ensureTokenIndex(warmed);
  await _runCodeGraphQuery(async () => {
    await _prewarmSymbolSources(warmed, ['target'], null);
    for (const [rel, node] of warmed.nodes) {
      const text = warmed._sourceTextCache.get(rel).text;
      assert.deepEqual(warmed._maskedLinesCache.get(rel).lines, _maskNonCodeText(text, node.lang).split(/\r?\n/));
    }
    // The sources are gone (their abs paths do not exist), so only the hits
    // computed ahead can still answer — and they equal a synchronous scan.
    warmed._sourceTextCache.clear();
    warmed._maskedLinesCache.clear();
    assert.deepEqual(_findSymbolHits(warmed, 'target'), _findSymbolHits(cold, 'target'));
  });
});

test('a hit scan that met an unreadable source is not memoized, and a later query sees the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-cg-unreadable-'));
  try {
    const nodes = new Map();
    for (const name of ['a', 'b']) {
      const rel = `${name}.mjs`;
      nodes.set(rel, {
        rel,
        abs: join(root, rel),
        lang: 'javascript',
        fingerprint: `fp-${name}`,
        tokenSymbols: ['target'],
        symbols: [{ name: 'target', kind: 'function', startLine: 1, endLine: 1 }],
      });
    }
    const graph = _attachGraphRuntimeCaches({ cwd: root, nodes, reverse: new Map() });
    await writeFile(join(root, 'b.mjs'), 'export function target() {}\n');
    await _ensureTokenIndex(graph);
    // An unreadable file still yields its record-only hit, with no source line.
    const lines = (hits) => hits.map((hit) => `${hit.rel}:${hit.content}`).sort();
    const read = ['a.mjs:export function target() {}', 'b.mjs:export function target() {}'];
    const unread = ['a.mjs:', 'b.mjs:export function target() {}'];
    await _runCodeGraphQuery(async () => {
      await _prewarmSymbolSources(graph, ['target'], null);
      // a.mjs was unreadable during the scan: the synchronous call re-reads.
      await writeFile(join(root, 'a.mjs'), 'export function target() {}\n');
      assert.deepEqual(lines(_findSymbolHits(graph, 'target')), read);
    });
    await rm(join(root, 'a.mjs'));
    graph._sourceTextCache.delete('a.mjs');
    graph._maskedLinesCache.delete('a.mjs');
    graph._sourceLinesCache.delete('a.mjs');
    await _runCodeGraphQuery(async () => {
      await _prewarmSymbolSources(graph, ['target'], null);
      assert.deepEqual(lines(_findSymbolHits(graph, 'target')), unread);
    });
    // Readable again: the next query does not answer from the previous one.
    await writeFile(join(root, 'a.mjs'), 'export function target() {}\n');
    await _runCodeGraphQuery(async () => {
      await _prewarmSymbolSources(graph, ['target'], null);
      assert.deepEqual(lines(_findSymbolHits(graph, 'target')), read);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const MASKABLE_LINE = '/* c */ const a = "s"; // target x\n';

// Every event-loop gap while `run` is pending, in ms.
async function eventLoopGaps(run) {
  const gaps = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    await run();
  } finally {
    running = false;
  }
  return gaps;
}

test('small files of batches the pool refuses or fails are masked before evaluation in yielding slices, under a hard cap', async () => {
  const graph = syntheticGraph(36);
  for (const [rel, entry] of graph._sourceTextCache) {
    graph._sourceTextCache.set(rel, {
      ...entry,
      text: MASKABLE_LINE.repeat(Math.ceil(100_000 / MASKABLE_LINE.length)),
    });
  }
  // A saturated pool: the one admitted batch goes to a worker that never
  // answers (failed at its deadline), every other batch is refused.
  const posted = [];
  _configureMaskPoolForTest({
    maxOutstandingChars: 1,
    deadlineMs: 200,
    createWorker: () => ({
      on() {},
      ref() {},
      unref() {},
      terminate: async () => {},
      postMessage: ({ texts }) => posted.push(texts.reduce((sum, text) => sum + text.length, 0)),
    }),
  });
  let ticks = 0;
  let running = true;
  const tick = () => {
    ticks += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    await _prewarmMaskedSourceNodes(graph, [...graph.nodes.values()]);
  } finally {
    running = false;
    _configureMaskPoolForTest();
  }
  assert.ok(posted.length > 0 && posted.every((chars) => chars <= 1 << 20), `batches over the cap: ${posted}`);
  // Nothing is left for evaluation to mask synchronously …
  for (const [rel, node] of graph.nodes) {
    const text = graph._sourceTextCache.get(rel).text;
    assert.deepEqual(graph._maskedLinesCache.get(rel)?.lines, _maskNonCodeText(text, node.lang).split(/\r?\n/), rel);
  }
  // … and the main thread was released between files while masking them.
  assert.ok(ticks >= 3, `only ${ticks} event-loop turns while 3.6M chars were masked`);
});

test('a saturated pool makes an oversized file wait for admission instead of masking it on the main thread', async () => {
  const graph = syntheticGraph(1);
  const [[rel, entry]] = graph._sourceTextCache;
  // CRLF, empty and lone-CR lines too: the lines must equal split(/\r?\n/).
  const unit = `${MASKABLE_LINE}x\r\n\r\n\ny\rz\n`;
  const text = `${unit.repeat(Math.ceil(4_200_000 / unit.length))}\r`;
  graph._sourceTextCache.set(rel, { ...entry, text });
  // Lines already split: this test is about masking alone.
  graph._sourceLinesCache.set(rel, { fingerprint: entry.fingerprint, lines: text.split(/\r?\n/) });
  // Another query's request keeps the (real) pool saturated while this one prewarms.
  _configureMaskPoolForTest({ maxOutstandingChars: 1 });
  const occupying = _maskTextsOffThread([MASKABLE_LINE.repeat(200_000)], ['javascript']);
  let gaps;
  try {
    gaps = await eventLoopGaps(() => _prewarmMaskedSourceNodes(graph, [...graph.nodes.values()]));
    await occupying;
  } finally {
    _configureMaskPoolForTest();
  }
  assert.deepEqual(graph._maskedLinesCache.get(rel)?.lines, _maskNonCodeText(text, 'javascript').split(/\r?\n/));
  const worst = gaps.reduce((max, gap) => Math.max(max, gap), 0);
  // One slice plus the scavenges that land inside it (a few ms each with this
  // many line strings); masking this file on the main thread took ~100 ms.
  assert.ok(
    worst <= 3 * MAIN_THREAD_SLICE_MS,
    `a ${worst.toFixed(1)}ms event-loop gap while a 4.2M-char file was masked`
  );
});

test('an oversized file whose pool requests crash twice is masked in slices, not in one stretch', async () => {
  const graph = syntheticGraph(1);
  const [[rel, entry]] = graph._sourceTextCache;
  const unit = `${MASKABLE_LINE}const t = \`a \${f("x")} b\`; /* multi\n line */ x\r\n`;
  const text = unit.repeat(Math.ceil(4_200_000 / unit.length));
  graph._sourceTextCache.set(rel, { ...entry, text });
  graph._sourceLinesCache.set(rel, { fingerprint: entry.fingerprint, lines: text.split(/\r?\n/) });
  // Every mask worker crashes on its first request.
  let crashes = 0;
  _configureMaskPoolForTest({
    createWorker: () => {
      const handlers = {};
      return {
        on: (event, handler) => {
          handlers[event] = handler;
        },
        ref() {},
        unref() {},
        terminate: async () => {},
        postMessage: () =>
          setImmediate(() => {
            crashes += 1;
            handlers.error?.(new Error('injected crash'));
          }),
      };
    },
  });
  let gaps;
  try {
    gaps = await eventLoopGaps(() => _prewarmMaskedSourceNodes(graph, [...graph.nodes.values()]));
  } finally {
    _configureMaskPoolForTest();
  }
  assert.equal(crashes, 2, 'the batch request and the admission retry both crashed');
  assert.deepEqual(graph._maskedLinesCache.get(rel)?.lines, _maskNonCodeText(text, 'javascript').split(/\r?\n/));
  const worst = gaps.reduce((max, gap) => Math.max(max, gap), 0);
  // As above: one slice plus the scavenges inside it.
  assert.ok(worst <= 3 * MAIN_THREAD_SLICE_MS, `a ${worst.toFixed(1)}ms event-loop gap after two crashes`);
});

test("an oversized file's source lines are split and measured in slices, to the same lines and bytes", async (t) => {
  const graph = syntheticGraph(1);
  const [[rel, entry]] = graph._sourceTextCache;
  const unit = `${MASKABLE_LINE}x\r\n\r\n\ny\rz\n`;
  const text = `${unit.repeat(Math.ceil(4_200_000 / unit.length))}\r`;
  graph._sourceTextCache.set(rel, { ...entry, text });
  // The same caches, filled without prewarming: the byte estimate is the plain walk.
  const walked = syntheticGraph(1);
  walked._sourceTextCache.set(rel, graph._sourceTextCache.get(rel));
  walked._sourceLinesCache.set(rel, { fingerprint: entry.fingerprint, lines: text.split(/\r?\n/) });
  // A clock that moves 1 ms per reading: a slice expires after a fixed number
  // of checks, however fast the machine is.
  let now = 0;
  const clock = t.mock.method(performance, 'now', () => now++);
  let turns = 0;
  let running = true;
  const tick = () => {
    turns += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    await _prewarmMaskedSourceNodes(graph, [...graph.nodes.values()], { masked: false });
  } finally {
    running = false;
    clock.mock.restore();
  }
  // Splitting and measuring 150k lines in one stretch took ~18 ms here (60+ ms on a CI runner).
  assert.ok(turns >= 10, `only ${turns} event-loop turns while a 4.2M-char file's lines were split`);
  assert.deepEqual(graph._sourceLinesCache.get(rel).lines, walked._sourceLinesCache.get(rel).lines);
  assert.equal(_estimateGraphRetainedBytes(graph), _estimateGraphRetainedBytes(walked));
});

test('a finished query leaves no path from the shared mask pool to its hit memo', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const graph = syntheticGraph(30);
  await _ensureTokenIndex(graph);
  // A fresh pool, so its worker and idle timer are first created inside the query.
  _configureMaskPoolForTest();
  let memoRef = null;
  await _runCodeGraphQuery(async () => {
    await _prewarmSymbolSources(graph, ['target'], null);
    // The query's memo, found through the registered runtime stores.
    for (const ref of globalThis[Symbol.for('mixdog.rootAsyncContext')].stores) {
      const store = ref.deref()?.getStore();
      if (store instanceof WeakMap && store.get(graph)?.size > 0) memoRef = new WeakRef(store);
    }
  });
  assert.ok(memoRef?.deref(), 'the query populated a registered memo store');
  try {
    for (let i = 0; i < 6 && memoRef.deref(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    assert.equal(memoRef.deref(), undefined, 'the pooled worker or its timers still pin the finished query');
  } finally {
    _configureMaskPoolForTest();
  }
});

test('a worker graph arrives in ack-paced chunks and reassembles in node order', async () => {
  const graph = syntheticGraph(1200);
  graph.signature = 'sig';
  graph.reverse.set('src/f1.mjs', new Set(['src/f0.mjs']));
  const posted = [];
  let acks = 0;
  const receive = _codeGraphWorkerReceiver();
  let result = null;
  await _postCodeGraphWorkerSuccess(
    graph,
    (message) => {
      posted.push(message);
      result = receive(structuredClone(message)) || result;
    },
    () => {},
    { nextChunk: async () => acks++ }
  );
  const nodeChunks = posted.filter((message) => message.key === 'nodes');
  assert.ok(nodeChunks.length > 1, 'the nodes are split across messages');
  assert.equal(posted[0].shell.nodes.size, 0, 'the header carries no node');
  // Every message after the header waited for one ack.
  assert.equal(acks, posted.length - 1);
  assert.equal(result.ok, true);
  assert.deepEqual([...result.graph.nodes.keys()], [...graph.nodes.keys()]);
  assert.deepEqual(result.graph.nodes, graph.nodes);
  assert.deepEqual(result.graph.reverse, graph.reverse);
  assert.deepEqual(result.graph._sourceTextCache, graph._sourceTextCache);
});
