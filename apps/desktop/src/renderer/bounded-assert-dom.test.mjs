// A failing comparison between rendered JSDOM elements must fail with a short
// message, fast and without allocating the inspected document/React graph.
// Unbounded, node:assert inspects and diffs both operands at depth 1000 — the
// 16 GB failure of `assert.equal(document.activeElement, high)`. The bounded
// comparisons come from the desktop test preload (scripts/test-env.mjs).
import assert, { AssertionError } from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement'],
});
after(restore);

const { createRoot } = await import('react-dom/client');

const MAX_MESSAGE_CHARS = 2_000;
const MAX_OPERAND_CHARS = 600;

test('failing comparisons between rendered JSDOM elements stay bounded', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  // A sizeable React tree, so each element links to a large fiber/DOM graph.
  const rows = Array.from({ length: 500 }, (_, index) =>
    React.createElement('li', { key: index, className: 'row' }, `Row ${index}`)
  );
  await act(async () => root.render(React.createElement('ul', null, rows)));
  const [low, high] = document.querySelectorAll('li.row');
  assert.ok(low && high && low !== high);

  const cases = [
    ['equal', 'strictEqual', () => assert.equal(low, high)],
    ['deepStrictEqual', 'deepStrictEqual', () => assert.deepStrictEqual(low, high)],
  ];
  for (const [label, operator, compare] of cases) {
    let failure;
    try {
      compare();
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof AssertionError, `${label}: expected an AssertionError`);
    assert.equal(failure.operator, operator);
    assert.ok(failure.message.length <= MAX_MESSAGE_CHARS, `${label}: message ${failure.message.length} chars`);
    // node:test inspects actual/expected again for its report: they must be
    // bounded summaries, not the live elements.
    for (const field of ['actual', 'expected']) {
      assert.equal(typeof failure[field], 'string', `${label}: ${field} is a summary`);
      assert.ok(failure[field].length <= MAX_OPERAND_CHARS, `${label}: ${field} ${failure[field].length} chars`);
    }
  }
});
