import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionRailMotion } from './session-rail-motion.ts';

const h = React.createElement;

/** A panel of `cards` for `session`, with the browser's animations stood in for: each is recorded and ends on demand. */
async function mountPanel(t) {
  const view = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Event'], rootId: 'root' });
  const animations = [];
  view.window.HTMLElement.prototype.animate = function animate(frames) {
    const ended = Promise.withResolvers();
    animations.push({ card: this.dataset.category, frames, end: () => ended.resolve() });
    return { finished: ended.promise, cancel() {} };
  };
  function Panel({ session, cards }) {
    const content = useRef(null);
    useSessionRailMotion(content, session);
    return h(
      'div',
      { ref: content, className: 'session-rail-content' },
      cards.map((category) => h('section', { key: category, className: 'session-rail-sec', 'data-category': category }))
    );
  }
  const render = (session, cards) => act(async () => view.root.render(h(Panel, { session, cards })));
  const shown = () =>
    [...view.document.querySelectorAll('.session-rail-sec')].map(
      (card) => `${card.dataset.category}${card.hasAttribute('data-leaving') ? ' (leaving)' : ''}`
    );
  return { animations, render, shown };
}

test('a card that arrives while the panel is shown opens from nothing; the cards drawn with the panel stand at once', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'context']);
  assert.deepEqual(panel.animations, [], 'nothing moves at the first draw');
  await panel.render('s1', ['info', 'todo', 'context']);
  assert.deepEqual(
    panel.animations.map((animation) => animation.card),
    ['todo']
  );
  const [from, to] = panel.animations[0].frames;
  assert.equal(from.height, '0px');
  assert.equal(from.opacity, 0);
  assert.equal(to.opacity, 1);
});

test('a card that leaves closes in its place and is gone once closed', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'todo', 'context']);
  await panel.render('s1', ['info', 'context']);
  assert.deepEqual(panel.shown(), ['info', 'todo (leaving)', 'context'], 'it stands where it was while it closes');
  assert.equal(panel.animations.at(-1).frames[1].height, '0px');
  // Another commit meanwhile leaves the closing card alone.
  await panel.render('s1', ['info', 'context']);
  assert.equal(panel.animations.length, 1);
  await act(async () => panel.animations[0].end());
  assert.deepEqual(panel.shown(), ['info', 'context']);
});

test('another session’s cards stand at once: nothing opens or closes across a switch', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'todo']);
  await panel.render('s2', ['info', 'context', 'agents']);
  assert.deepEqual(panel.animations, []);
  assert.deepEqual(panel.shown(), ['info', 'context', 'agents']);
});