import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionRailMotion } from './session-rail-motion.ts';

const h = React.createElement;

/** A panel of `cards` for `session`, with the browser's animations stood in for: each is recorded and ends on demand. */
async function mountPanel(t) {
  const view = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Event'], rootId: 'root' });
  view.window.CSS = { supports: () => true };
  const animations = [];
  view.window.HTMLElement.prototype.animate = function animate(frames) {
    const animation = {
      card: this.dataset.category,
      frames,
      currentTime: 0,
      backward: false,
      cancelled: false,
      onfinish: null,
      reverse() {
        this.backward = !this.backward;
      },
      cancel() {
        this.cancelled = true;
      },
      end() {
        this.onfinish?.();
      },
    };
    animations.push(animation);
    return animation;
  };
  /** A card that shows or hides by itself, as the Git card does on a status refresh. */
  const own = {};
  function OwnCard() {
    const [shown, setShown] = useState(false);
    own.show = setShown;
    return shown ? h('section', { className: 'session-rail-sec', 'data-category': 'git' }) : null;
  }
  function Panel({ session, cards }) {
    const content = useRef(null);
    useSessionRailMotion(content, session);
    return h(
      'div',
      { ref: content, className: 'session-rail-content' },
      cards.map((category) =>
        category === 'git'
          ? h(OwnCard, { key: category })
          : h('section', { key: category, className: 'session-rail-sec', 'data-category': category })
      )
    );
  }
  const render = (session, cards) => act(async () => view.root.render(h(Panel, { session, cards })));
  const shown = () =>
    [...view.document.querySelectorAll('.session-rail-sec')].map(
      (card) => `${card.dataset.category}${card.hasAttribute('data-leaving') ? ' (leaving)' : ''}`
    );
  const running = () => animations.filter((animation) => !animation.cancelled);
  return { animations, running, render, shown, showOwn: (value) => act(async () => own.show(value)) };
}

test('a card that arrives while the panel is shown opens from nothing to its own height; the cards drawn with the panel stand at once', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'context']);
  assert.deepEqual(panel.animations, [], 'nothing moves at the first draw');
  await panel.render('s1', ['info', 'todo', 'context']);
  assert.deepEqual(
    panel.animations.map((animation) => `${animation.card}${animation.backward ? ' backward' : ''}`),
    ['todo']
  );
  const [from, to] = panel.animations[0].frames;
  assert.equal(from.height, '0px');
  assert.equal(from.opacity, 0);
  assert.equal(to.height, 'auto', 'the height it has by then, not the one it had as it arrived');
  assert.equal(to.opacity, 1);
});

test('a card that leaves closes in its place and is gone once closed', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'todo', 'context']);
  await panel.render('s1', ['info', 'context']);
  assert.deepEqual(panel.shown(), ['info', 'todo (leaving)', 'context'], 'it stands where it was while it closes');
  assert.equal(panel.animations.at(-1).backward, true);
  // Another commit meanwhile leaves the closing card alone.
  await panel.render('s1', ['info', 'context']);
  assert.equal(panel.animations.length, 1);
  await act(async () => panel.animations[0].end());
  assert.deepEqual(panel.shown(), ['info', 'context']);
});

test('a card that shows and hides by itself, with no render of the panel, opens and closes once', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'git', 'context']);
  await panel.showOwn(true);
  assert.deepEqual(panel.shown(), ['info', 'git', 'context']);
  assert.equal(panel.animations.length, 1, 'it opens as it appears');
  await act(async () => panel.animations[0].end());
  await panel.render('s1', ['info', 'git', 'context']);
  assert.equal(panel.animations.length, 1, 'the panel’s next render opens nothing again');
  await panel.showOwn(false);
  assert.deepEqual(panel.shown(), ['info', 'git (leaving)', 'context']);
  await panel.render('s1', ['info', 'git', 'context']);
  assert.equal(panel.running().length, 1, 'and closes nothing twice');
});

test('a card turned round mid-way goes back from where it stands, on the one fold it has', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'context']);
  await panel.render('s1', ['info', 'todo', 'context']);
  await panel.render('s1', ['info', 'context']);
  assert.equal(panel.animations.length, 1, 'the opening fold is turned round, no second one starts');
  assert.equal(panel.animations[0].backward, true);
  // Back again before it has closed: one card of the category, going on from where the closing one stood.
  panel.animations[0].currentTime = 80;
  await panel.render('s1', ['info', 'todo', 'context']);
  assert.deepEqual(panel.shown(), ['info', 'todo', 'context']);
  assert.equal(panel.animations.at(-1).currentTime, 80);
  assert.equal(panel.animations.at(-1).backward, false);
});

test('two cards leaving one after the other each close where they stood', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['agents', 'shells', 'changes']);
  await panel.render('s1', ['agents', 'changes']);
  await panel.render('s1', ['changes']);
  assert.deepEqual(panel.shown(), ['agents (leaving)', 'shells (leaving)', 'changes']);
  // Both at once keep their order too.
  await panel.render('s2', ['agents', 'shells', 'changes']);
  await panel.render('s2', ['changes']);
  assert.deepEqual(panel.shown(), ['agents (leaving)', 'shells (leaving)', 'changes']);
});

test('a card moved in the order neither opens nor closes', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'todo', 'context']);
  await panel.render('s1', ['todo', 'info', 'context']);
  assert.deepEqual(panel.animations, []);
  assert.deepEqual(panel.shown(), ['todo', 'info', 'context']);
});

test('another session’s cards stand at once: nothing opens or closes across a switch, and a card still closing is gone', async (t) => {
  const panel = await mountPanel(t);
  await panel.render('s1', ['info', 'todo', 'shells']);
  await panel.render('s1', ['info', 'todo']);
  assert.deepEqual(panel.shown(), ['info', 'todo', 'shells (leaving)']);
  await panel.render('s2', ['info', 'context', 'agents']);
  assert.deepEqual(panel.running(), []);
  assert.deepEqual(panel.shown(), ['info', 'context', 'agents']);
});
