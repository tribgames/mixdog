import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, test } from 'node:test';

import { graphBinaryPath } from '../code-graph/graph-binary.mjs';
import {
  _resetNativeSearchClientForTest,
  shutdownNativeSearchServer,
  tryServeSearch,
} from './native-search-client.mjs';

// The resident server's first walk used to record a root as the request
// spelled it while its file-change updates recorded the resolved path, so any
// other spelling of the same folder listed every file twice. These run the
// real server against such spellings: on the first listing, after a change,
// and for grep, whose results must keep the caller's spelling.
const binary = graphBinaryPath();
const skip = binary ? false : 'mixdog-graph binary not available';
const savedEnv = {};
let base;

before(() => {
  if (skip) return;
  // A canonical base: an 8.3 temp dir would itself be another spelling.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-root-spelling-')));
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_SEARCH_SERVER_BIN', 'MIXDOG_SEARCH_SERVER']) {
    savedEnv[key] = process.env[key];
  }
  process.env.MIXDOG_DATA_DIR = join(base, 'data');
  process.env.MIXDOG_SEARCH_SERVER_BIN = binary;
  delete process.env.MIXDOG_SEARCH_SERVER;
  _resetNativeSearchClientForTest();
});

after(async () => {
  if (skip) return;
  await shutdownNativeSearchServer('test');
  _resetNativeSearchClientForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const slash = (lines) => lines.map((line) => line.replaceAll('\\', '/')).sort();

async function listFiles(cwd) {
  const result = await tryServeSearch(['--files', '--hidden', '.'], { cwd, timeout: 15_000 }, { keepWarm: true });
  return slash(result.lines);
}

async function grepNeedle(cwd, operand) {
  const args = ['--no-heading', '-H', '-e', 'needle', '--', operand];
  const result = await tryServeSearch(args, { cwd, timeout: 15_000 }, { keepWarm: true });
  return slash(result.lines);
}

async function until(read, done) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function makeTree(name) {
  const real = join(base, name);
  mkdirSync(join(real, 'sub'), { recursive: true });
  writeFileSync(join(real, 'a.txt'), 'needle\n');
  writeFileSync(join(real, 'sub', 'b.txt'), 'needle\n');
  return real;
}

async function assertSingleCopies(real, alias) {
  const under = (...names) => slash(names.map((name) => `${alias}${sep}${name}:needle`));
  assert.deepEqual(await listFiles(alias), ['./a.txt', './sub/b.txt']);
  assert.deepEqual(await grepNeedle(alias, alias), under('a.txt', join('sub', 'b.txt')));

  writeFileSync(join(real, 'sub', 'c.txt'), 'needle\n');
  writeFileSync(join(real, 'a.txt'), 'needle\nchanged\n');
  // Listing and grep keep separate inventories (`--hidden` is part of the
  // key), and each is current only once the watcher has delivered the change.
  // A listing that re-reads the folder for an earlier event can show c.txt
  // before grep's cached inventory hears about it — macOS FSEvents delivers
  // late enough for that — so each waits for the change on its own.
  const listed = await until(
    () => listFiles(alias),
    (lines) => lines.some((line) => line.endsWith('c.txt'))
  );
  assert.deepEqual(listed, ['./a.txt', './sub/b.txt', './sub/c.txt']);
  const grepped = await until(
    () => grepNeedle(alias, alias),
    (lines) => lines.some((line) => line.endsWith('c.txt:needle'))
  );
  assert.deepEqual(grepped, under('a.txt', join('sub', 'b.txt'), join('sub', 'c.txt')));
}

test('a stale inventory snapshot is dropped once before the first server loads it', { skip }, async () => {
  const snapshotDir = join(base, 'data', 'search-index');
  const snapshot = join(snapshotDir, 'file-inventories-v1.bin');
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(snapshot, 'stale');
  const real = makeTree('snapshot');
  assert.deepEqual(await listFiles(real), ['./a.txt', './sub/b.txt']);
  readFileSync(join(snapshotDir, 'file-inventories-v1.canonical-roots'));
  let content = null;
  try {
    content = readFileSync(snapshot, 'utf8');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  assert.notEqual(content, 'stale');
});

test('a junction or symlinked root lists and greps each file once', { skip }, async (t) => {
  const real = makeTree('junction-Real');
  const alias = join(base, 'junction-alias');
  try {
    symlinkSync(real, alias, 'junction');
  } catch (error) {
    t.skip(`junction unsupported: ${error.code}`);
    return;
  }
  await assertSingleCopies(real, alias);
});

test('a lower-case Windows root lists and greps each file once', {
  skip: skip || process.platform !== 'win32',
}, async () => {
  const real = makeTree('lower-Real');
  const alias = real.toLowerCase();
  await assertSingleCopies(real, alias);
  // An exact-file operand keeps the requested spelling too.
  const file = join(alias, 'sub', 'b.txt');
  assert.deepEqual(await grepNeedle(alias, file), slash([`${file}:needle`]));
});

test('a root reached through `..` lists and greps each file once', { skip }, async () => {
  const real = makeTree('dotdot-Real');
  mkdirSync(join(base, 'detour'));
  const alias = `${base}${sep}detour${sep}..${sep}dotdot-Real`;
  await assertSingleCopies(real, alias);
});
