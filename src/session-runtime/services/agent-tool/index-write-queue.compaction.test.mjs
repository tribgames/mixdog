import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIndexWriteQueue, flushAllIndexWrites } from './index-write-queue.mjs';

// Replay compaction: persisted outcome must equal sequential replay of every
// mutation, while overwritten values are decoded at most once.

function setup(initial = { map: {}, set: [] }) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-queue-compact-'));
  const file = join(root, 'index.json');
  const readFile = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { map: {}, set: [] });
  const calls = { rewrite: 0 };
  if (initial) writeFileSync(file, JSON.stringify(initial));
  const queue = createIndexWriteQueue({
    file,
    readDoc: readFile,
    rewrite(cur, mutator) {
      calls.rewrite += 1;
      const map = new Map(Object.entries(cur?.map ?? {}));
      const set = new Set(cur?.set ?? []);
      mutator(map, set);
      return { map: Object.fromEntries(map), set: [...set] };
    },
  });
  return { root, file, queue, readFile, calls };
}

// Sequential expectation: apply every mutator to plain Map/Set in order.
function expected(initial, mutators) {
  const map = new Map(Object.entries(initial.map));
  const set = new Set(initial.set);
  for (const mutate of mutators) mutate(map, set);
  return { map: [...map], set: [...set] };
}
const entriesOf = (doc) => ({ map: Object.entries(doc.map), set: doc.set });

for (const synchronous of [false, true]) {
  test(`${synchronous ? 'exit' : 'async'} replay matches sequential mutations across generated operation orders`, async () => {
    for (let seed = 1; seed <= 16; seed++) {
      let state = seed;
      const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
      const initial = { map: { first: { v: 0 }, w0: { v: -1 }, w1: { v: -1 } }, set: ['base'] };
      const mutations = Array.from({ length: 48 }, (_, step) => {
        const key = `w${(next() >>> 16) % 7}`;
        const kind = (next() >>> 16) % 3;
        if (kind === 0) return (map) => map.delete(key);
        if (kind === 1) return (_map, set) => set.add(key);
        return (map) => map.set(key, { v: step, seed });
      });
      const { root, queue, readFile } = setup(initial);
      try {
        for (const mutation of mutations) queue.write(mutation);
        const wanted = expected(initial, mutations);
        assert.deepEqual(entriesOf(queue.projection()), wanted, `projection seed=${seed}`);
        if (synchronous) assert.equal(queue.flushSync(), true);
        else await queue.flush();
        assert.deepEqual(entriesOf(readFile()), wanted, `persistence seed=${seed}`);
      } finally {
        await flushAllIndexWrites();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test('process exit preserves both the in-flight and newer pending state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-queue-exit-'));
  const file = join(root, 'index.json');
  const moduleUrl = new URL('./index-write-queue.mjs', import.meta.url).href;
  const source = `
    import { readFileSync } from 'node:fs';
    import { createIndexWriteQueue } from ${JSON.stringify(moduleUrl)};
    const file = process.argv[1];
    const queue = createIndexWriteQueue({
      file,
      readDoc: () => JSON.parse(readFileSync(file, 'utf8')),
      rewrite: (cur, mutate) => {
        const map = new Map(Object.entries(cur || {}));
        mutate(map);
        return Object.fromEntries(map);
      },
    });
    queue.write((map) => map.set('worker', { status: 'running' }));
    void queue.flush();
    queue.write((map) => map.set('worker', { status: 'completed' }));
    queue.write((map) => map.set('other', { status: 'idle' }));
    process.exit(queue.flushSync() ? 0 : 2);
  `;
  try {
    writeFileSync(file, '{}');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, file], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      worker: { status: 'completed' },
      other: { status: 'idle' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SCENARIO = [
  (m, s) => {
    m.set('a', { v: 1 });
    m.set('b', { v: 1 });
    s.add('x');
  },
  (m) => m.set('a', { v: 2 }),
  (m) => m.delete('a'),
  (m, s) => {
    m.set('a', { v: 3 });
    m.set('c', { v: 1 });
    s.add('y');
    s.add('x');
  },
  (m) => m.set('b', { v: 4 }),
  (m) => {
    m.set('tmp', { v: 1 });
    m.delete('tmp');
  },
  (m) => m.delete('foreign-del'),
];
const INITIAL = { map: { first: { v: 0 }, 'foreign-del': { v: 9 }, a: { v: 0 } }, set: ['s0'] };

test('async persistence matches sequential replay incl. order, reinsert, deletes, sets', async () => {
  const { root, queue, readFile, calls } = setup(INITIAL);
  try {
    let runs = 0;
    for (const mutate of SCENARIO)
      queue.write((...args) => {
        runs += 1;
        mutate(...args);
      });
    assert.equal(runs, SCENARIO.length);
    await queue.flush();
    assert.equal(runs, SCENARIO.length);
    assert.equal(calls.rewrite, SCENARIO.length + 1, 'one rewrite per write plus one persist');
    assert.deepEqual(entriesOf(readFile()), expected(INITIAL, SCENARIO));
    assert.equal(readFile().map['foreign-del'], undefined);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('synchronous flush matches sequential replay', async () => {
  const { root, queue, readFile } = setup(INITIAL);
  try {
    for (const mutate of SCENARIO) queue.write(mutate);
    assert.equal(queue.flushSync(), true);
    assert.deepEqual(entriesOf(readFile()), expected(INITIAL, SCENARIO));
    assert.equal(queue.hasUnpersisted(), false);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a key created then deleted still deletes a concurrent foreign writer key', async () => {
  const { root, file, queue, readFile } = setup({ map: {}, set: [] });
  try {
    queue.write((m) => m.set('k', { v: 1 }));
    queue.write((m) => m.delete('k'));
    writeFileSync(file, JSON.stringify({ map: { k: { foreign: true }, other: { v: 1 } }, set: [] }));
    await queue.flush();
    assert.deepEqual(Object.keys(readFile().map), ['other']);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreign keys are merged and new keys keep sequential order after them', async () => {
  const { root, file, queue, readFile } = setup({ map: {}, set: [] });
  try {
    queue.write((m) => m.set('a', { v: 1 }));
    queue.write((m) => m.set('b', { v: 1 }));
    queue.write((m) => m.set('a', { v: 2 }));
    writeFileSync(file, JSON.stringify({ map: { foreign: { v: 1 } }, set: ['f'] }));
    await queue.flush();
    const doc = readFile();
    assert.deepEqual(Object.entries(doc.map), [
      ['foreign', { v: 1 }],
      ['a', { v: 2 }],
      ['b', { v: 1 }],
    ]);
    assert.deepEqual(doc.set, ['f']);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a burst on one key decodes only the final value during persistence', async () => {
  const { root, queue, readFile } = setup({ map: {}, set: [] });
  const realParse = JSON.parse;
  try {
    const BURST = 50;
    for (let i = 0; i < BURST; i += 1) queue.write((m) => m.set('w', { status: `burst-${i}` }));
    let burstDecodes = 0;
    JSON.parse = (text, ...rest) => {
      if (typeof text === 'string' && text.includes('burst-')) burstDecodes += 1;
      return realParse(text, ...rest);
    };
    try {
      await queue.flush();
    } finally {
      JSON.parse = realParse;
    }
    assert.equal(burstDecodes, 1);
    assert.deepEqual(readFile().map.w, { status: `burst-${BURST - 1}` });
  } finally {
    JSON.parse = realParse;
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes arriving while a persistence is inflight persist after it, in order', async () => {
  const { root, queue, readFile } = setup(INITIAL);
  try {
    const half = 4;
    for (const mutate of SCENARIO.slice(0, half)) queue.write(mutate);
    const first = queue.flush(); // hands the first batch to the running job
    for (const mutate of SCENARIO.slice(half)) queue.write(mutate); // pending during inflight
    assert.equal(queue.hasUnpersisted(), true);
    await first;
    await queue.flush();
    assert.deepEqual(entriesOf(readFile()), expected(INITIAL, SCENARIO));
    assert.equal(queue.hasUnpersisted(), false);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-your-writes projection and version are unaffected by compaction', async () => {
  const { root, queue } = setup({ map: {}, set: [] });
  try {
    const v0 = queue.version();
    queue.write((m) => m.set('a', { v: 1 }));
    const next = queue.write((m) => m.set('a', { v: 2 }));
    assert.deepEqual(next.map, { a: { v: 2 } });
    assert.equal(queue.version(), v0 + 2);
    assert.deepEqual(queue.projection().map, { a: { v: 2 } });
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});
