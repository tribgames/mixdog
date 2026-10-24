// The bot page's contact menu is built when it opens, from the notification
// store as it is then: mute → reopen → "Unmute notifications".
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const { AgentActivityPane } = await import('./AgentActivityPane.tsx');

const AGENTS = [{ id: 'translator', custom: true, kind: 'bot', label: 'Translator', route: { provider: 'openai', model: 'gpt-5' } }];

test('bot page menu: mute, then reopen offers Unmute; a scope change refreshes the wording', async (t) => {
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'navigator'],
    rootId: 'root',
  });
  const { window } = dom;
  const { document } = window;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = { overrides: [], scope: 'all', writes: [] };
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability }) => ({ value: capability === 'listAgents' ? AGENTS : null }),
    listConversationNotifications: async () => host.overrides,
    getNotificationPreferences: async () => ({
      devices: [],
      currentDeviceId: 'pc',
      preferences: { pc: { scope: host.scope } },
    }),
    setConversationNotification: async (target, setting) => {
      host.writes.push([target, setting]);
      host.overrides = setting.mode === 'inherit' ? [] : [{ target, setting }];
      return host.overrides;
    },
  };
  const render = () =>
    act(async () => root.render(React.createElement(AgentActivityPane, { active: true, sessions: [] })));
  await render();
  await render();
  const row = () => document.querySelector('[data-agent-contact="translator"]');
  const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim());
  const item = (text) => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(text));
  const open = () =>
    act(async () => row().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));

  await open();
  assert.ok(items().includes('Mute notifications'));
  await act(async () => item('Mute notifications').click());
  await act(async () => item('Until I turn it back on').click());
  assert.deepEqual(host.writes, [[{ kind: 'agent', id: 'translator' }, { mode: 'muted', until: null }]]);

  await open();
  assert.ok(items().includes('Unmute notifications'), items().join('|'));
  assert.ok(!items().includes('Mute notifications'));
  await act(async () => item('Unmute notifications').click());
  assert.deepEqual(host.writes[1], [{ kind: 'agent', id: 'translator' }, { mode: 'inherit' }]);

  // The device scope changes elsewhere: the next open reads it.
  host.scope = 'off';
  const { announceSetupChange } = await import('./setup-change-refresh.ts');
  await act(async () => announceSetupChange('settings_changed'));
  await open();
  assert.ok(items().includes('Get notifications'), items().join('|'));
});
