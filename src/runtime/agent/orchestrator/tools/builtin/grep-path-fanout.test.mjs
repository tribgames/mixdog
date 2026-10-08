import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGrepPathFanout } from './lib/grep-path-fanout.mjs';
import { normalizeOutputPath } from './path-utils.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-path-fanout-'));
  for (const name of ['one', 'two', 'node_modules', 'one/nested']) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, 'one/exact.bin'), 'needle\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(root, run, overrides = {}) {
  return {
    args: { pattern: 'needle', glob: ['*.txt', '!skip.txt'], context: 0 },
    list: ['one', 'two'],
    workDir: root,
    options: { __runRgWindowedLines: run },
    callContextCharBudget: 4096,
    defaultHeadLimit: 100,
    executeGrepTool: async () => assert.fail('unexpected per-path search'),
    ...overrides,
  };
}

const empty = () => ({ lines: [], complete: true, partial: false, cacheSafe: true });

function subscriber(t) {
  const controller = new AbortController();
  const subscribed = Promise.withResolvers();
  const add = controller.signal.addEventListener;
  t.mock.method(controller.signal, 'addEventListener', function (type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (type === 'abort') subscribed.resolve();
    return result;
  });
  return { controller, subscribed: subscribed.promise };
}

test('compatible relative filters use one scan with original section order', async (t) => {
  const root = fixture(t);
  let scans = 0;
  const out = await runGrepPathFanout(input(root, async (args) => {
    scans++;
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [
      normalizeOutputPath(join(root, 'one')),
      normalizeOutputPath(join(root, 'two')),
    ]);
    assert.ok(args.includes('*.txt'));
    assert.ok(args.includes('!skip.txt'));
    return {
      ...empty(),
      lines: [
        `${normalizeOutputPath(join(root, 'two/b.txt'))}:1:needle two`,
        `${normalizeOutputPath(join(root, 'one/a.txt'))}:1:needle one`,
      ],
    };
  }));
  assert.equal(scans, 1);
  assert.match(out, /# grep one[\s\S]*one\/a\.txt[\s\S]*1:\s*needle one[\s\S]*# grep two[\s\S]*two\/b\.txt[\s\S]*1:\s*needle two/);
});

test('identical concurrent calls share a scan; distinct scopes still start independently', async (t) => {
  const root = fixture(t);
  const release = Promise.withResolvers();
  let scans = 0;
  const run = async () => {
    scans++;
    await release.promise;
    return empty();
  };
  const subscribers = Array.from({ length: 17 }, () => subscriber(t));
  const calls = subscribers.map(({ controller }, index) => runGrepPathFanout(input(root, run, {
    ...(index === 16 ? { list: ['two', 'one/nested'] } : {}),
    options: { __runRgWindowedLines: run, signal: controller.signal },
  })));
  await Promise.all(subscribers.map((entry) => entry.subscribed));
  assert.equal(scans, 2);
  release.resolve();
  assert.ok((await Promise.all(calls)).every((out) => out === '(no matches)'));
  await runGrepPathFanout(input(root, async () => { scans++; return empty(); }));
  assert.equal(scans, 3, 'settled scans are not retained as persistent results');
});

test('one subscriber cancellation does not cancel a shared scan or start fallback work', async (t) => {
  const root = fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const controller = new AbortController();
  const remaining = subscriber(t);
  let scans = 0;
  let scanSignal;
  const run = async (_args, { signal }) => {
    scans++;
    scanSignal = signal;
    started.resolve();
    await release.promise;
    return empty();
  };
  const first = runGrepPathFanout(input(root, run, {
    options: { __runRgWindowedLines: run, signal: controller.signal },
  }));
  const rejected = assert.rejects(first, /stop first/);
  const second = runGrepPathFanout(input(root, run, {
    options: { __runRgWindowedLines: run, signal: remaining.controller.signal },
  }));
  await started.promise;
  await remaining.subscribed;
  controller.abort(new Error('stop first'));
  await rejected;
  assert.equal(scanSignal.aborted, false);
  release.resolve();
  assert.equal(await second, '(no matches)');
  assert.equal(scans, 1);
});

test('a sole cancelled subscriber stops its scan and never starts per-path retries', async (t) => {
  const root = fixture(t);
  const started = Promise.withResolvers();
  const controller = new AbortController();
  let stopped = false;
  const run = async (_args, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      stopped = true;
      reject(new Error('scan stopped'));
    }, { once: true }));
  };
  const pending = runGrepPathFanout(input(root, run, {
    options: { __runRgWindowedLines: run, signal: controller.signal },
  }));
  const rejected = assert.rejects(pending, /stop only/);
  await started.promise;
  controller.abort(new Error('stop only'));
  await rejected;
  assert.equal(stopped, true);
});

for (const [label, overrides] of [
  ['overlapping roots', { list: ['one', 'one/nested'] }],
  ['different noise exclusions', { list: ['one', 'node_modules'] }],
  ['file glob exemption', { list: ['one/exact.bin', 'two'] }],
  ['absolute glob outside one root', { absoluteGlob: true }],
]) {
  test(`${label} keeps independent scope rules without a speculative scan`, async (t) => {
    const root = fixture(t);
    const seen = [];
    const { absoluteGlob, ...rest } = overrides;
    const out = await runGrepPathFanout(input(root, async () => assert.fail('unsafe combined scan'), {
      ...rest,
      ...(absoluteGlob ? { args: { pattern: 'needle', glob: join(root, 'one', '*.txt'), context: 0 } } : {}),
      executeGrepTool: async ({ path }) => { seen.push(path); return `result:${path}`; },
    }));
    assert.deepEqual(seen, rest.list || ['one', 'two']);
    for (const path of seen) assert.ok(out.includes(`result:${path}`));
  });
}

for (const outcome of [
  { complete: false, partial: false },
  { complete: false, partial: true, timeout: true },
  { complete: false, partial: true, rgStderr: 'permission denied' },
]) {
  test(`unverified per-root completion preserves fallback (${JSON.stringify(outcome)})`, async (t) => {
    const root = fixture(t);
    let scans = 0;
    const seen = [];
    const out = await runGrepPathFanout(input(root, async () => {
      scans++;
      return { lines: [], ...outcome };
    }, {
      executeGrepTool: async ({ path }) => { seen.push(path); return `verified:${path}`; },
    }));
    assert.equal(scans, 1);
    assert.deepEqual(seen, ['one', 'two']);
    assert.match(out, /verified:one[\s\S]*verified:two/);
  });
}

for (const cacheSafe of [false, true]) {
  test(`combined path fanout preserves watcher cache safety (${cacheSafe})`, async (t) => {
    const root = fixture(t);
    const outcome = { complete: true, cacheSafe: true };
    await runGrepPathFanout(input(root, null, {
      options: {
        scopedCacheOutcome: outcome,
        __runRgWindowedLines: async () => ({ ...empty(), cacheSafe }),
      },
    }));
    assert.equal(outcome.cacheSafe, cacheSafe);
    assert.equal(outcome.complete, true);
  });
}
