import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { SessionRetentionSettings } from './session-retention-settings.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'CustomEvent'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));
const combo = (document, label) => document.querySelector(`button[role="combobox"][aria-label="${label}"]`);

async function mount(t, api) {
  const dom = installTestDom(t, DOM);
  dom.window.mixdogDesktop = api;
  await act(async () => dom.root.render(React.createElement(SessionRetentionSettings, { pending: '' })));
  await settle();
  return dom.window.document;
}

test('Settings → General → Sessions shows the 7-day archive and 90-day delete defaults with the undo warning', async (t) => {
  const document = await mount(t, {
    readSettings: async () => ({ sessionAutoArchiveDays: 7, sessionAutoDeleteDays: 90 }),
    setSessionRetention: async () => ({}),
  });
  assert.equal(document.querySelector('.settings-group h3').textContent, 'Sessions');
  assert.match(combo(document, 'Auto-archive inactive sessions').textContent, /7 days/);
  assert.match(combo(document, 'Delete archived sessions after').textContent, /90 days/);
  assert.equal(
    document.querySelector('.session-retention-warning').textContent,
    'Deleted sessions cannot be restored.'
  );
  assert.match(document.querySelector('.session-retention-note').textContent, /never archived/);
});

test('the Sessions group is absent where the host cannot save it', async (t) => {
  const document = await mount(t, {
    readSettings: async () => ({ sessionAutoArchiveDays: 7, sessionAutoDeleteDays: 90 }),
  });
  assert.equal(document.querySelector('.settings-group'), null);
});
