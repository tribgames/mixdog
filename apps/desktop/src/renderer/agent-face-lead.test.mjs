import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement'],
});
const { createRoot } = await import('react-dom/client');
const { ApprovalFace } = await import('./approval-prompt.tsx');
const { resetLeadAvatar } = await import('./lead-avatar-store.ts');
test.after(() => dom.window.close());

const CORGI = { kind: 'mascot', species: 'corgi', accessory: 'glasses', expression: 'happy', color: '#5b9bff' };
const BOT_FACE = { kind: 'mascot', species: 'husky', accessory: 'none', expression: 'calm', color: '#f06a5f' };

test('a non-bot agent wears the Lead face live; a bot keeps its own', async (t) => {
  resetLeadAvatar();
  t.after(resetLeadAvatar);
  let lead = null;
  const listeners = new Set();
  window.mixdogDesktop = {
    invokeCapability: async ({ capability }) => {
      if (capability === 'listAgents')
        return {
          value: [
            { id: 'reviewer', kind: 'agent', custom: true, label: 'Reviewer' },
            { id: 'rex', kind: 'bot', custom: true, label: 'Rex', avatar: BOT_FACE },
          ],
        };
      if (capability === 'getLeadAppearance') return { value: { avatar: lead } };
      return { value: null };
    },
    subscribeSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const html = (id) => host.querySelector(`[data-face="${id}"]`)?.innerHTML ?? '';
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        null,
        ...['reviewer', 'rex'].map((id) =>
          React.createElement('div', { key: id, 'data-face': id }, React.createElement(ApprovalFace, { agentId: id }))
        )
      )
    )
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(html('reviewer').includes('#9a9a9a'), 'the agent shows the grey Lead default');
  assert.ok(html('rex').includes('#f06a5f'), 'the bot keeps its own colour');
  lead = CORGI;
  await act(async () => {
    for (const listener of listeners) listener({ scope: 'desktop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(html('reviewer').includes('#5b9bff'), 'changing the Lead look restyles the agent');
  assert.ok(html('rex').includes('#f06a5f') && !html('rex').includes('#5b9bff'), 'the bot is unaffected');
});

test('only the latest read publishes; a write invalidates reads still pending', async (t) => {
  const { readLeadAvatar, setLeadAvatar, leadAvatar, resetLeadAvatar: reset } = await import('./lead-avatar-store.ts');
  reset();
  t.after(reset);
  const SHEPHERD = { kind: 'mascot', species: 'shepherd', accessory: 'none', expression: 'calm', color: '#f06a5f' };
  const pending = [];
  const api = {
    invokeCapability: ({ capability }) =>
      capability === 'getLeadAppearance'
        ? new Promise((resolve) => pending.push((avatar) => resolve({ value: { avatar } })))
        : Promise.resolve({ value: null }),
  };
  // Two overlapping reads resolving out of order: the older answer arrives last.
  const older = readLeadAvatar(api);
  const newer = readLeadAvatar(api);
  pending[1](CORGI);
  await newer;
  assert.equal(leadAvatar().species, 'corgi');
  pending[0](SHEPHERD);
  await older;
  assert.equal(leadAvatar().species, 'corgi', 'the stale read does not overwrite the newer look');
  // A write while a read is pending: the pending read is ignored.
  const read = readLeadAvatar(api);
  setLeadAvatar({ ...SHEPHERD, species: 'husky' });
  pending[2](CORGI);
  await read;
  assert.equal(leadAvatar().species, 'husky', 'the read that began before the write is dropped');
});
