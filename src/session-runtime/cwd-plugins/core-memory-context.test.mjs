import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreMemoryContext } from './core-memory-context.mjs';

const { formatCoreMemoryLines } = createCoreMemoryContext({
  clean: (value) => String(value ?? '').trim(),
});

test('core memory keeps every entry that fits the byte budget', () => {
  const userLines = Array.from({ length: 60 }, (_, index) => `rule ${index}`);
  const out = formatCoreMemoryLines({ userLines });
  assert.equal(out.split('\n').length, 60);
  assert.equal(out.endsWith('- rule 59'), true);
});

test('core memory over 32 KiB is cut on a character boundary with a marker', () => {
  const userLines = Array.from({ length: 40 }, (_, index) => `${index} ${'한글 지침 문장 '.repeat(120)}`);
  const out = formatCoreMemoryLines({ userLines });
  assert.equal(Buffer.byteLength(out, 'utf8') <= 32 * 1024, true);
  assert.equal(Buffer.byteLength(out, 'utf8') > 31 * 1024, true);
  assert.equal(out.endsWith('\n- ...'), true);
  assert.equal(out.includes('\uFFFD'), false);
});
