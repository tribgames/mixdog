// The room face: a cluster of round member faces in stored order; past four,
// three faces and a "+N" chip.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null);
after(restore);
const [{ renderToStaticMarkup }, { RoomAvatar }, { agentAvatar }] = await Promise.all([
  import('react-dom/server'),
  import('./agent-room-parts.tsx'),
  import('../../../../src/runtime/shared/agent-avatar.mjs'),
]);

const members = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    name: `M${index}`,
    avatar: agentAvatar(`m${index}`, null),
  }));

function layout(count) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(React.createElement(RoomAvatar, { members: members(count) }));
  const tile = host.querySelector('.agent-room-tile');
  return {
    count: tile.getAttribute('data-count'),
    faces: tile.querySelectorAll(':scope > .agent-room-face').length,
    more: tile.querySelector(':scope > .agent-room-more')?.textContent ?? null,
    last: tile.lastElementChild.className,
    label: tile.getAttribute('aria-label'),
  };
}

test('two to four members show every face; the layout follows the count', () => {
  for (const count of [2, 3, 4]) {
    const shown = layout(count);
    assert.equal(shown.count, String(count));
    assert.equal(shown.faces, count);
    assert.equal(shown.more, null);
  }
});

test('five and six members show three faces and a "+N" in the fourth corner', () => {
  for (const [count, more] of [
    [5, '+2'],
    [6, '+3'],
  ]) {
    const shown = layout(count);
    assert.equal(shown.count, '4');
    assert.equal(shown.faces, 3);
    assert.equal(shown.more, more);
    assert.equal(shown.last, 'agent-room-more');
    assert.match(shown.label, new RegExp(String(count)));
  }
});
