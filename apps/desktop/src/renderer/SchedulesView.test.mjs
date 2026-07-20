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
    backend: 'discord',
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

async function renderPane(api) {
  await act(async () => {
    root.render(React.createElement(SchedulesPane, { api }));
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

test('schedules pane lists schedules, gates pause on remote, and creates schedules', async () => {
  mount();
  const { api, calls } = schedulesApi();
  await renderPane(api);
  assert.match(document.querySelector('.schedules-page-header h1').textContent, /Scheduled tasks/);
  const row = document.querySelector('.schedules-row');
  assert.match(row.textContent, /daily/);
  assert.equal(Array.from(row.querySelectorAll('button'))
    .find((button) => button.textContent === 'Pause').disabled, true);

  await act(async () => {
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.includes('New schedule')).click();
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
    name: 'weekly', description: '', time: '30 10 * * *', channel: '111', model: 'openai/gpt-test',
    instructions: 'Weekly digest.', enabled: true,
  });
  assert.equal(document.querySelector('.schedules-dialog'), null,
    'the editor should close after a successful save');
});

test('editing a schedule prefills the form, locks the name, and saves with overwrite', async () => {
  mount();
  const { api, calls } = schedulesApi();
  await renderPane(api);
  await act(async () => {
    Array.from(document.querySelector('.schedules-row').querySelectorAll('button'))
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
  assert.equal(edited.channel, '111');
  assert.equal(edited.model, 'openai/gpt-old');
  assert.equal(edited.instructions, 'Summarize yesterday.');
});

test('pause toggles through the capability and delete requires a two-step confirm', async () => {
  mount();
  const { api, calls } = schedulesApi({ remote: true });
  await renderPane(api);
  const buttons = () => Array.from(document.querySelector('.schedules-row').querySelectorAll('button'));
  const pause = buttons().find((button) => button.textContent === 'Pause');
  assert.equal(pause.disabled, false);
  await act(async () => {
    pause.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setScheduleEnabled'
    && args[0] === 'daily' && args[1] === false));

  const deleteButton = () => buttons().find((button) =>
    button.textContent === 'Delete' || button.textContent === 'Confirm delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
  });
  assert.equal(deleteButton().textContent, 'Confirm delete');
  assert.equal(calls.some(([name]) => name === 'deleteSchedule'), false,
    'the first delete click must not delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'deleteSchedule' && args[0] === 'daily'));
});
