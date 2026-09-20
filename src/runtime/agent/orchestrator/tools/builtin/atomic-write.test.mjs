import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-atomic-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const leftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.mixdog-tmp-'));

test('atomicWrite lands buffered and streamed payloads without leaving temp files', async (t) => {
  const dir = scratch(t);
  const target = join(dir, 'out.txt');
  await atomicWrite(target, 'hello');
  assert.equal(readFileSync(target, 'utf8'), 'hello');
  const big = Buffer.alloc(1024 * 1024 + 5, 0x61);
  await atomicWrite(target, big);
  assert.equal(statSync(target).size, big.length);
  assert.deepEqual(leftovers(dir), []);
});

test('atomicWrite refuses an exclusive create when the target already exists', async (t) => {
  const dir = scratch(t);
  const target = join(dir, 'exists.txt');
  writeFileSync(target, 'first');
  await assert.rejects(
    atomicWrite(target, 'second', { flags: 'wx' }),
    (err) => err.code === 'EEXIST' && err.__skip === true
  );
  assert.equal(readFileSync(target, 'utf8'), 'first');
  assert.deepEqual(leftovers(dir), []);
});

test('atomicWrite detects a target that changed after the preflight snapshot', async (t) => {
  const dir = scratch(t);
  const target = join(dir, 'stale.txt');
  writeFileSync(target, 'v1');
  const before = statSync(target);
  await atomicWrite(target, 'v2 (other writer)');
  await assert.rejects(
    atomicWrite(target, 'v3', {
      expectedTargetSnapshot: {
        exists: true,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        ino: before.ino,
      },
    }),
    (err) => err.code === 'ESTALE_TARGET'
  );
  assert.equal(readFileSync(target, 'utf8'), 'v2 (other writer)');
  assert.deepEqual(leftovers(dir), []);
});

test('atomicWrite honours an already aborted signal before touching the target', async (t) => {
  const dir = scratch(t);
  const target = join(dir, 'aborted.txt');
  const controller = new AbortController();
  controller.abort(new Error('stop now'));
  await assert.rejects(atomicWrite(target, 'x', { signal: controller.signal }), /stop now/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(leftovers(dir), []);
});
