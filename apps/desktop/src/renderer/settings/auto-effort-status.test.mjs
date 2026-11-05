import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';

const entry = (revision, value) => ({ section: 'toolModules', key: null, revision, value });

async function mountCard(t, entries) {
  const { window, root } = installTestDom(t, { rootId: 'root' });
  let push = () => {};
  const asked = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => (asked.push(request), { value: {} }),
    sections: {
      snapshot: async () => ({ status: 'ready', entries }),
      subscribe: (listener) => ((push = listener), () => {}),
    },
  };
  const { useAutoEffortStatus } = await import('./auto-effort-status.ts');
  const Card = () => React.createElement('p', null, JSON.stringify(useAutoEffortStatus()));
  await act(async () => root.render(React.createElement(Card)));
  await act(async () => {});
  return { asked, push: (e) => act(async () => push({ kind: 'sections', changes: [{ section: 'toolModules', key: null, entry: e }] })) };
}

test('the Auto reasoning card shows the section pushed with the app snapshot and follows its updates without asking', async (t) => {
  const card = await mountCard(t, [entry(1, { autoEffort: { installing: true } })]);
  assert.match(document.body.textContent, /"installing":true/);
  await card.push(entry(2, { autoEffort: { installing: false, installed: true } }));
  assert.match(document.body.textContent, /"installed":true/);
  assert.doesNotMatch(document.body.textContent, /"installing":true/);
  assert.deepEqual(card.asked, [], 'no status read goes out');
});

test('without the section the card has no state of its own', async (t) => {
  await mountCard(t, []);
  assert.equal(document.body.textContent, '{}');
});
