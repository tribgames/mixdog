// Settings → Display → Composer: hovering a style redraws only the preview,
// pressing it applies the style, like Settings → Theme.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'PointerEvent', 'navigator'],
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { ComposerStyleGroup } = await import('./composer-style-preview.tsx');
const { getComposerStyle, setComposerStyle } = await import('../composer-style-preference.ts');

test('composer style: hover previews a style, a press applies it', async () => {
  setComposerStyle('basic');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ComposerStyleGroup, { pending: null })));
  const preview = () => host.querySelector('.csp');
  const button = (value) => host.querySelector(`.skin-seg button[data-value="${value}"]`);
  assert.equal(preview().dataset.style, 'basic');

  await act(async () => button('detail').dispatchEvent(new window.Event('pointerover', { bubbles: true })));
  await act(async () => button('detail').focus());
  assert.equal(preview().dataset.style, 'detail', 'the preview follows the focused style');
  assert.equal(getComposerStyle(), 'basic', 'nothing applied yet');
  assert.ok(host.querySelector('.csp-route'), 'detail shows the workflow and delegation sample');

  await act(async () => button('detail').blur());
  assert.equal(preview().dataset.style, 'basic', 'leaving restores the applied style');

  await act(async () => button('simple').click());
  assert.equal(getComposerStyle(), 'simple');
  assert.equal(preview().dataset.style, 'simple');
  assert.equal(host.querySelector('.csp-bar'), null, 'simple draws the PC as the two-row card');
  assert.equal(host.querySelector('.csp-under'), null, 'and nothing under the card');
  await act(async () => root.unmount());
  setComposerStyle('basic');
});
