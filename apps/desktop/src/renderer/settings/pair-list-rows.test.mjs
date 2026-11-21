import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event'] };
const { PairRows } = await import('./pair-list-rows.tsx');

async function mountRows(t, values, props = {}) {
  const dom = installTestDom(t, DOM);
  const changes = [];
  await act(async () =>
    dom.root.render(
      React.createElement(PairRows, {
        values,
        keyPlaceholder: 'Name',
        valuePlaceholder: 'Value',
        busy: false,
        onChange: (next) => changes.push(next),
        ...props,
      })
    )
  );
  const inputs = () => [...dom.document.querySelectorAll('input')];
  const type = (input, text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  return { ...dom, changes, inputs, type };
}

test('editing a name changes only that row and leaves the passed rows untouched', async (t) => {
  const values = [
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ];
  const { inputs, type, changes } = await mountRows(t, values);
  await type(inputs()[2], 'bb');
  assert.deepEqual(changes.at(-1), [
    { key: 'a', value: '1' },
    { key: 'bb', value: '2' },
  ]);
  assert.deepEqual(values, [
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ]);
});

test('editing a value changes only that row', async (t) => {
  const { inputs, type, changes } = await mountRows(t, [
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ]);
  await type(inputs()[1], '10');
  assert.deepEqual(changes.at(-1), [
    { key: 'a', value: '10' },
    { key: 'b', value: '2' },
  ]);
});

test('with no rows one empty row shows and typing into it yields one row', async (t) => {
  const { inputs, type, changes } = await mountRows(t, []);
  assert.equal(inputs().length, 2);
  await type(inputs()[0], 'token');
  assert.deepEqual(changes.at(-1), [{ key: 'token', value: '' }]);
});
