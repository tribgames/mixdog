// `syntax.check` answers exactly as `new vm.Script(source)` does, message included.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { startWorker } from './test/worker-client.mjs';

const SOURCES = [
  'const a = 1; a + 1',
  '',
  'await 1',
  'import fs from "node:fs"',
  'export const x = 1',
  'return 5',
  'let a = 1; let a = 2;',
  'function (',
  '"unterminated',
  'const f = async () => { await 1 }; f()',
  'class A { #p = 1; static m() { return new A().#p } }',
  'a ?? b',
  '#!/usr/bin/env node\nconsole.log(1)',
];

function direct(source) {
  try {
    new Script(source);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error.message) };
  }
}

test('syntax.check matches new vm.Script for every source, with the same message', async () => {
  const worker = startWorker();
  try {
    await worker.ready;
    for (const source of SOURCES) {
      const { result } = await worker.call('syntax.check', { source, kind: 'commonjs-script' }, []);
      assert.deepEqual(result.ok, direct(source), JSON.stringify(source));
    }
    assert.equal(direct('await 1').ok, false, 'top-level await is not a CommonJS script');
  } finally {
    await worker.stop();
  }
});

test('syntax.check refuses an unknown kind and a non-string source', async () => {
  const worker = startWorker();
  try {
    await worker.ready;
    const kind = await worker.call('syntax.check', { source: '1', kind: 'esm' }, []);
    assert.equal(kind.result.err.code, 'invalid_kind');
    const source = await worker.call('syntax.check', { source: 1, kind: 'commonjs-script' }, []);
    assert.equal(source.result.err.code, 'invalid_params');
  } finally {
    await worker.stop();
  }
});
