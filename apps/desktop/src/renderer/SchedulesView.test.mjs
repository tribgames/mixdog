import { register } from 'node:module';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./settings/test-css-loader.mjs', import.meta.url));
const { SchedulesPane } = await import('./SchedulesView.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let dom;
let root;

function mount() {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    FormData: dom.window.FormData,
  });
  dom.window.HTMLElement.prototype.attachEvent ??= () => {};
  dom.window.HTMLElement.prototype.detachEvent ??= () => {};
  root = createRoot(document.getElementById('root'));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  dom?.window.close();
  root = undefined;
  dom = undefined;
});

function schedulesApi({ remote = false, schedules } = {}) {
  const calls = [];
  const setup = {
    provider: 'discord',
    channel: { discordChannelId: '111' },
    schedules: schedules || [{
      name: 'daily', description: 'Daily report', time: '0 9 * * *', whenCron: '0 9 * * *',
      route: 'channel:111', channel: '111', model: 'openai/gpt-old',
      enabled: true, instructions: 'Summarize the day.',
    }],
    webhooks: [],
  };
  const api = {
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'getChannelSetup') return { value: setup };
      if (capability === 'isRemoteEnabled') return { value: remote };
      // Provider setup drives configured-model filtering in the picker.
      if (capability === 'getProviderSetup') {
        return { value: { api: [{ id: 'openai', authenticated: true }] } };
      }
      calls.push([capability, args]);
      return { value: { ok: true } };
    },
    listProviderModels: async () => [{
      provider: 'openai', model: 'gpt-test', display: 'GPT Test',
      effortOptions: [], fastCapable: false, fastPreferred: false,
    }],
  };
  return { api, calls };
}

async function renderPane(api, props = {}) {
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api, ...props }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function submit(form) {
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openActions(name) {
  await act(async () => {
    document.querySelector(`[aria-label="Actions for ${name}"]`).click();
    await Promise.resolve();
  });
  return document.querySelector(`[role="menu"][aria-label="Actions for ${name} menu"]`);
}

test('schedules pane lists schedules, keeps pause available without remote, and creates schedules', async () => {
  mount();
  const { api, calls } = schedulesApi();
  await renderPane(api);
  // The pane no longer titles itself: the sidebar panel header names the view
  // and hosts the create action (standalone renders keep it inline).
  assert.equal(document.querySelector('[aria-label="New schedule"]') != null, true);
  assert.equal(document.querySelector('.schedules-page-header'), null);
  const row = document.querySelector('.schedules-row');
  assert.match(row.textContent, /daily/);
  // Automation is decoupled from the messaging runtime: pause works with the
  // remote/channel runtime off.
  const actions = await openActions('daily');
  assert.equal(Array.from(actions.querySelectorAll('button'))
    .find((button) => button.textContent === 'Pause').disabled, false);

  await act(async () => {
    document.querySelector('[aria-label="New schedule"]').click();
    await Promise.resolve();
  });
  const form = document.querySelector('.schedules-dialog form');
  form.querySelector('input[name="schedule-name"]').value = 'weekly';
  form.querySelector('input[name="schedule-clock"]').value = '10:30';
  form.querySelector('textarea[name="schedule-instructions"]').value = 'Weekly digest.';
  await act(async () => {
    document.querySelector('button[aria-label="Schedule model"]').click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes('GPT-Test')).click();
    await Promise.resolve();
  });
  await submit(form);
  assert.deepEqual(calls.filter(([name]) => name === 'saveSchedule').at(-1)[1][0], {
    name: 'weekly', description: '', time: '30 10 * * *', delivery: 'app', model: 'openai/gpt-test',
    workflow: 'default', instructions: 'Weekly digest.', enabled: true,
  });
  // Boolean form: a failed equality against a DOM node would make the test
  // reporter serialize the entire jsdom tree (observed as an OOM crash).
  assert.equal(document.querySelector('.schedules-dialog') === null, true,
    'the editor should close after a successful save');
});

test('schedule row spins only while its automation session is working', async () => {
  mount();
  const { api } = schedulesApi();
  await renderPane(api, { runningNames: new Set(['daily']) });
  const status = document.querySelector('.schedules-row-status');
  assert.equal(status.getAttribute('aria-label'), 'daily is running');
  assert.ok(status.querySelector('.schedules-row-spinner'));
  assert.equal(status.querySelector('.schedules-row-dot'), null);

  await renderPane(api, { runningNames: new Set() });
  assert.ok(document.querySelector('.schedules-row-status .schedules-row-dot.on'));
  assert.equal(document.querySelector('.schedules-row-spinner'), null);
});

test('cold schedules keep a stable panel shell without replaying a loading spinner', async () => {
  mount();
  let resolveSetup;
  const setupPending = new Promise((resolve) => { resolveSetup = resolve; });
  const { api } = schedulesApi();
  api.invokeCapability = async ({ capability }) => capability === 'getChannelSetup'
    ? { value: await setupPending }
    : { value: [] };
  await renderPane(api);
  const pane = document.querySelector('.schedules-pane');
  assert.equal(pane?.querySelector('.pane-surface-gate'), null);
  assert.equal(pane?.querySelector('.desktop-loading-spinner'), null);
  assert.ok(pane?.querySelector('.schedules-search'));
  assert.equal(pane?.querySelector('.schedules-empty'), null,
    'the empty state must wait for the initial snapshot');

  await act(async () => {
    resolveSetup({ channel: {}, schedules: [], webhooks: [] });
    await setupPending;
  });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
  assert.ok(pane?.querySelector('.schedules-empty'));
  assert.equal(pane?.querySelector('.desktop-loading-spinner'), null);
});

test('editing a schedule prefills the form, locks the name, and saves with overwrite', async () => {
  mount();
  const { api, calls } = schedulesApi();
  await renderPane(api);
  const actions = await openActions('daily');
  await act(async () => {
    Array.from(actions.querySelectorAll('button'))
      .find((button) => button.textContent === 'Edit').click();
    await Promise.resolve();
  });
  const form = document.querySelector('.schedules-dialog form');
  const nameInput = form.querySelector('input[name="schedule-name"]');
  assert.equal(nameInput.value, 'daily');
  assert.equal(nameInput.disabled, true);
  assert.equal(form.querySelector('input[name="schedule-clock"]').value, '09:00');
  const instructions = form.querySelector('textarea[name="schedule-instructions"]');
  assert.equal(instructions.value, 'Summarize the day.');
  instructions.value = 'Summarize yesterday.';
  await submit(form);
  const edited = calls.filter(([name]) => name === 'saveSchedule').at(-1)[1][0];
  assert.equal(edited.name, 'daily');
  assert.equal(edited.overwrite, true);
  assert.equal(edited.time, '0 9 * * *');
  assert.equal(edited.delivery, 'app');
  assert.equal(edited.model, 'openai/gpt-old');
  assert.equal(edited.instructions, 'Summarize yesterday.');
});

test('pause toggles through the capability and delete requires a two-step confirm', async () => {
  mount();
  const { api, calls } = schedulesApi({ remote: true });
  await renderPane(api);
  let actions = await openActions('daily');
  const pause = Array.from(actions.querySelectorAll('button'))
    .find((button) => button.textContent === 'Pause');
  assert.equal(pause.disabled, false);
  await act(async () => {
    pause.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setScheduleEnabled'
    && args[0] === 'daily' && args[1] === false));

  actions = await openActions('daily');
  const deleteButton = () => Array.from(actions.querySelectorAll('button')).find((button) =>
    button.textContent === 'Delete' || button.textContent === 'Confirm delete');
  const initialDeleteButton = deleteButton();
  const initialPopupStyle = actions.getAttribute('style');
  assert.equal(actions.style.width, '148px',
    'the popup reserves enough width for the confirmation label before it appears');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
  });
  assert.equal(deleteButton().textContent, 'Confirm delete');
  assert.equal(deleteButton(), initialDeleteButton,
    'Delete and Confirm delete must share one stable action node');
  assert.equal(actions.getAttribute('style'), initialPopupStyle,
    'confirming deletion must not move or resize the open popup');
  assert.equal(calls.some(([name]) => name === 'deleteSchedule'), false,
    'the first delete click must not delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'deleteSchedule' && args[0] === 'daily'));
});

test('run-now completion uses the shared toast channel instead of the panel bottom', async () => {
  mount();
  const { api, calls } = schedulesApi();
  let toast;
  window.addEventListener('mixdog:desktop-toast', (event) => { toast = event.detail; }, { once: true });
  await renderPane(api);
  const actions = await openActions('daily');
  await act(async () => {
    Array.from(actions.querySelectorAll('button'))
      .find((button) => button.textContent === 'Run now').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'runScheduleNow' && args[0] === 'daily'));
  assert.deepEqual({ text: toast?.text, tone: toast?.tone }, {
    text: '"daily" ran — see Automations in the sidebar.',
    tone: 'success',
  });
  assert.equal(document.querySelector('.schedules-feedback-slot'), null);
});
