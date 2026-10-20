// At most one avatar moves: the highest claim wins (a bounce, then a typing
// bubble, then a working list row, then the header's idle blink); the rest
// show their still frame. Reduced motion keeps every avatar still, and a
// custom avatar's missing state falls back to its idle image.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'Event'],
});
const { createRoot } = await import('react-dom/client');
const { AgentAvatar, customAvatarSource } = await import('./agent-avatar.tsx');
test.after(() => dom.window.close());

const pup = { kind: 'mascot', species: 'labrador', accessory: 'none', expression: 'calm', color: '#e6e6e6' };

async function mount(t, faces) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = (list) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          list.map(([key, state, priority]) =>
            React.createElement(AgentAvatar, { key, agentId: key, avatar: pup, className: key, state, priority })
          )
        )
      )
    );
  await render(faces);
  const shown = () =>
    Object.fromEntries([...host.querySelectorAll('svg')].map((svg) => [svg.classList[1], svg.dataset.state]));
  return { render, shown };
}

test('one avatar moves at a time: the strongest, newest claim', async (t) => {
  const { render, shown } = await mount(t, [['header', 'idle']]);
  assert.deepEqual(shown(), { header: 'idle' }, 'alone, the header blinks');
  await render([
    ['header', 'idle'],
    ['row', 'typing', 2],
  ]);
  assert.deepEqual(shown(), { header: 'still', row: 'typing' }, 'a working row outranks the blink');
  await render([
    ['header', 'idle'],
    ['row', 'typing', 2],
    ['bubble', 'typing'],
  ]);
  assert.deepEqual(shown(), { header: 'still', row: 'still', bubble: 'typing' }, 'the chat bubble outranks the row');
  await render([
    ['header', 'idle'],
    ['row', 'message', 4],
    ['bubble', 'typing'],
  ]);
  assert.deepEqual(shown(), { header: 'still', row: 'message', bubble: 'still' }, 'a new message bounces once');
  await render([['header', 'idle']]);
  assert.deepEqual(shown(), { header: 'idle' }, 'the blink comes back');
});

test('reduced motion keeps every avatar on its still frame', async (t) => {
  const listeners = new Set();
  dom.window.matchMedia = () => ({
    matches: true,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  });
  t.after(() => delete dom.window.matchMedia);
  const { shown } = await mount(t, [
    ['header', 'idle'],
    ['bubble', 'typing'],
  ]);
  assert.deepEqual(shown(), { header: 'still', bubble: 'still' });
});

test('a custom face: the moving state animates, a missing state uses idle, still and reduced show first frames', () => {
  const images = {
    idle: { url: 'data:image/gif;base64,IDLE', poster: 'data:image/png;base64,IDLE0' },
    typing: { url: 'data:image/png;base64,TYPE', poster: '' },
  };
  const image = (state) => images[state] ?? images.idle;
  assert.equal(customAvatarSource(image, 'typing', 'typing', false), images.typing.url);
  assert.equal(customAvatarSource(image, 'message', 'message', false), images.idle.url, 'message falls back to idle');
  assert.equal(customAvatarSource(image, 'typing', 'still', false), images.idle.poster, 'not on stage: idle, still');
  assert.equal(customAvatarSource(image, 'idle', 'still', true), images.idle.poster, 'reduced motion: the first frame');
  assert.equal(customAvatarSource(image, 'typing', 'still', true), images.typing.url, 'a still image is its own frame');
});
