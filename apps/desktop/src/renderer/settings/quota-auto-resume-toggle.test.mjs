import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { QuotaAutoResumeToggle } from './quota-auto-resume-toggle.tsx';
import { t as translate } from '../i18n.ts';

function mount(t, api) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = api;
  return { root, document: dom.window.document };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('the toggle reads the setting, writes it optimistically and reverts a failed write', async (t) => {
  const writes = [];
  let failWrite = false;
  const { root, document } = mount(t, {
    getQuotaAutoResume: async () => true,
    setQuotaAutoResume: async (next) => {
      writes.push(next);
      if (failWrite) throw new Error('nope');
      return next;
    },
  });
  await act(async () => root.render(React.createElement(QuotaAutoResumeToggle)));
  await settle();
  assert.equal(document.querySelector('h3').textContent, translate('Usage limits'));
  const input = document.querySelector('input[type="checkbox"]');
  assert.equal(input.getAttribute('aria-label'), translate('Resume automatically when the limit resets'));
  assert.equal(input.checked, true, 'reads the stored value');

  await act(async () => input.click());
  assert.deepEqual(writes, [false]);
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false);

  failWrite = true;
  await act(async () => document.querySelector('input[type="checkbox"]').click());
  await settle();
  assert.deepEqual(writes, [false, true]);
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false, 'failed write reverts');
});

test('the group stays hidden until the setting has been read', async (t) => {
  const { root, document } = mount(t, {
    getQuotaAutoResume: () => new Promise(() => {}),
    setQuotaAutoResume: async () => true,
  });
  await act(async () => root.render(React.createElement(QuotaAutoResumeToggle)));
  assert.equal(document.querySelector('.settings-group'), null);
});
