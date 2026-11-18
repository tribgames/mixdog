import assert from 'node:assert/strict';
import { test } from 'node:test';

import { silentReturns } from './scan-silent-returns.mjs';

const kinds = (source) => silentReturns(source).map((hit) => `${hit.line}:${hit.kind}`);

test('a guard on an absent file that returns is reported, in a nested callback as well', () => {
  assert.deepEqual(kinds("test('a', () => {\n  if (!existsSync(p)) return;\n  assert.ok(1);\n});"), ['2:guard']);
  assert.deepEqual(kinds("test('a', async () => {\n  await run(() => {\n    if (!existsSync(p)) { return; }\n  });\n  assert.ok(1);\n});"), ['3:guard']);
});

test('a bare return before the first assertion is reported, unless a skip is reported right before it', () => {
  assert.deepEqual(kinds("it('a', () => {\n  if (x) return;\n  assert.equal(1, 1);\n});"), ['2:early']);
  assert.deepEqual(kinds("test('a', (t) => {\n  if (x) { t.skip('why'); return; }\n  assert.equal(1, 1);\n});"), []);
});

test('returns of nested helpers and returns after an assertion are not the test\'s own', () => {
  assert.deepEqual(kinds("test('a', () => {\n  const f = (v) => {\n    if (!v) return;\n    return v;\n  };\n  assert.equal(f(1), 1);\n});"), []);
  assert.deepEqual(kinds("test('a', () => {\n  assert.ok(1);\n  if (x) return;\n});"), []);
  assert.deepEqual(kinds("const helper = () => {\n  if (x) return;\n};"), []);
});

test('comments and strings holding the patterns are not code', () => {
  assert.deepEqual(kinds("test('a', () => {\n  // if (!existsSync(p)) return;\n  const s = 'if (!existsSync(p)) return;';\n  assert.ok(s);\n});"), []);
});
