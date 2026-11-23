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
const { useTranscriptFollow, registerTranscriptScrollGeometry } = await import('./use-transcript-follow.ts');

test('a pane host moved to another slot puts its saved offset back as the app: a transcript pinned since stays followed', async (t) => {
  let now = 300_000;
  t.mock.method(Date, 'now', () => now);
  for (const id of ['slot-a', 'slot-b']) {
    const slot = document.createElement('div');
    slot.id = id;
    document.body.append(slot);
    t.after(() => slot.remove());
  }
  const geometry = { native: 1700, content: 2100 };
  let restores = 0;
  const scrollToEndRef = { current: () => (restores += 1) };
  let follow = null;
  function Transcript() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'moved-pane', scrollToEndRef });
    return React.createElement(
      'div',
      { ref: viewport, className: 'transcript' },
      React.createElement('div', { ref: content }, 'rows')
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = (targetId) =>
    act(async () =>
      root.render(
        React.createElement(PersistentPanePortal, { targetId, owner: 'moved' }, React.createElement(Transcript))
      )
    );
  await render('slot-a');
  const viewport = document.querySelector('#slot-a .transcript');
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => geometry.native,
    set: (top) => (geometry.native = top),
  });
  const release = registerTranscriptScrollGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => geometry.content,
    scrollTop: () => geometry.native,
    deviation: () => 0,
  });
  t.after(async () => {
    release();
    await act(async () => root.unmount());
    host.remove();
  });
  const scroll = () => act(async () => follow.handleScroll());
  await scroll();
  // The host saves the offset the transcript stood at; the rows grow and the end pin lands before it saves again.
  viewport.dispatchEvent(new window.Event('scrollend'));
  geometry.content = 2400;
  geometry.native = 2000;
  await scroll();
  now += 1_000;
  const before = restores;
  await render('slot-b');
  assert.equal(geometry.native, 1700, 'the move put the saved offset back');
  await scroll();
  assert.equal(follow.followingRef.current, true, 'the transcript still follows');
  assert.equal(restores, before + 1, 'and is put back at its end');
});

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
