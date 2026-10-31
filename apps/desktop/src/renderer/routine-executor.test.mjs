// A schedule or webhook can name an executor sub-agent (executorAgentId): the
// editors offer only the delegatable workflow agents (no bot, shared service or
// switched-off agent), "None" is the default and clears it (null), the saved
// value round-trips through the save call, and the list row shows who runs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
globalThis.FormData = window.FormData;
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: `${window.navigator.userAgent} Electron/38.0.0`,
});

const { resetSidebarReferenceCache, updateSidebarReference } = await import('./sidebar-reference-cache.ts');
const { SchedulesPane } = await import('./SchedulesView.tsx');
const { WebhooksPane } = await import('./WebhooksView.tsx');

const AGENTS = [
  { id: 'worker', label: 'Worker', custom: false },
  { id: 'reviewer', label: 'Reviewer', disabled: true },
  { id: 'explore', label: 'Explore' },
  { id: 'github-watcher', label: 'GitHub Watcher', custom: true, kind: 'bot' },
];
const NONE = 'The bot itself';

/** Mount `Pane` over a channel setup; resolves every save and records it. */
async function mount(t, Pane, setup, saveCapability) {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', setup);
  updateSidebarReference('projects', []);
  updateSidebarReference('agents', AGENTS);
  const saves = [];
  const api = {
    getTaskWorkspace: () => Promise.resolve(''),
    invokeCapability(request) {
      if (request.capability === 'getLeadStatus') return Promise.resolve({ value: { created: true } });
      if (request.capability === saveCapability) {
        saves.push(request.args[0]);
        return Promise.resolve({ value: {} });
      }
      return new Promise(() => {});
    },
  };
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    resetSidebarReferenceCache();
  });
  await act(async () => root.render(React.createElement(Pane, { api, active: true })));
  return saves;
}

const picker = (label) => document.querySelector(`[aria-label="${label}"]`);
const shown = (label) => picker(label).querySelector('.mx-select-value').textContent;
const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent.trim());
const pick = async (label, name) => {
  await act(async () => picker(label).click());
  const option = [...document.querySelectorAll('[role="option"]')].find((entry) => entry.textContent.trim() === name);
  await act(async () => option.click());
};
const save = () =>
  act(async () =>
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  );

test('a new schedule defaults to no executor, offers only workflow sub-agents, and saves the pick', async (t) => {
  const saves = await mount(t, SchedulesPane, { schedules: [], webhooks: [] }, 'saveSchedule');
  await act(async () => document.querySelector('.schedules-add').click());
  assert.equal(shown('Schedule executor'), NONE);
  await act(async () => picker('Schedule executor').click());
  assert.deepEqual(options(), [NONE, 'Worker']);
  await act(async () => document.querySelector('[role="option"]:nth-child(2)').click());
  await save();
  assert.equal(saves[0].executorAgentId, 'worker');
});

test('a new schedule left on None saves a null executor', async (t) => {
  const saves = await mount(t, SchedulesPane, { schedules: [], webhooks: [] }, 'saveSchedule');
  await act(async () => document.querySelector('.schedules-add').click());
  await save();
  assert.equal(saves[0].executorAgentId, null);
});

test('a schedule shows its executor on the row and writes it back untouched', async (t) => {
  const saves = await mount(
    t,
    SchedulesPane,
    {
      schedules: [
        {
          name: 'daily',
          whenCron: '0 9 * * *',
          instructions: 'Report',
          enabled: true,
          owner: 'lead',
          executorAgentId: 'worker',
        },
      ],
      webhooks: [],
    },
    'saveSchedule'
  );
  assert.match(document.querySelector('.routines-sub').textContent, / · Worker · /);
  await act(async () => document.querySelector('.routines-open').click());
  assert.equal(shown('Schedule executor'), 'Worker');
  await save();
  assert.equal(saves[0].executorAgentId, 'worker', 'an untouched draft writes the executor back');
});

test('a schedule clears its executor by picking None', async (t) => {
  const saves = await mount(
    t,
    SchedulesPane,
    {
      schedules: [
        {
          name: 'daily',
          whenCron: '0 9 * * *',
          instructions: 'Report',
          enabled: true,
          owner: 'lead',
          executorAgentId: 'worker',
        },
      ],
      webhooks: [],
    },
    'saveSchedule'
  );
  await act(async () => document.querySelector('.routines-open').click());
  await pick('Schedule executor', NONE);
  await save();
  assert.equal(saves[0].executorAgentId, null);
});

const HOOK = { name: 'issues', instructions: 'Triage', enabled: true, secretSet: true, parser: 'github' };
const hookSetup = (hook) => ({ webhook: { publicUrl: 'https://hooks.mixdog.test' }, webhooks: [hook] });

test('a webhook sets its executor from the editor', async (t) => {
  const saves = await mount(t, WebhooksPane, hookSetup(HOOK), 'saveWebhook');
  assert.doesNotMatch(document.querySelector('.routines-sub').textContent, /Worker/);
  await act(async () => document.querySelector('.routines-open').click());
  assert.equal(shown('Webhook executor'), NONE);
  await act(async () => picker('Webhook executor').click());
  assert.deepEqual(options(), [NONE, 'Worker']);
  await act(async () => document.querySelector('[role="option"]:nth-child(2)').click());
  await save();
  assert.equal(saves[0].executorAgentId, 'worker');
});

test('a webhook lists its executor and clears it by picking None', async (t) => {
  const saves = await mount(t, WebhooksPane, hookSetup({ ...HOOK, executorAgentId: 'worker' }), 'saveWebhook');
  assert.match(document.querySelector('.routines-sub').textContent, /\bWorker\b/);
  await act(async () => document.querySelector('.routines-open').click());
  assert.equal(shown('Webhook executor'), 'Worker');
  await pick('Webhook executor', NONE);
  await save();
  assert.equal(saves[0].executorAgentId, null);
});
