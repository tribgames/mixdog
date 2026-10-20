// One host per conversation owner in a pane slot: a host an earlier mount of
// the same owner left behind is removed, so two transcripts never paint over
// each other (one scrolled past its end showed the other conversation).
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="slot"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PersistentPanePortal } = await import('./PaneSurfaceGate.tsx');

test('a pane slot keeps one host per owner; other owners (a handoff) stay', async (t) => {
  const slot = document.getElementById('slot');
  const stale = document.createElement('div');
  stale.className = 'persistent-pane-surface';
  stale.dataset.owner = 'owner-1';
  const handoff = document.createElement('div');
  handoff.className = 'persistent-pane-surface';
  handoff.dataset.owner = 'owner-2';
  slot.append(stale, handoff);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(
        PersistentPanePortal,
        { targetId: 'slot', owner: 'owner-1' },
        React.createElement('p', null, 'chat')
      )
    )
  );
  const hosts = [...slot.children];
  assert.equal(hosts.length, 2);
  assert.ok(!hosts.includes(stale));
  assert.ok(hosts.includes(handoff));
  assert.equal(slot.querySelectorAll('p').length, 1);
});
