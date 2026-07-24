import { register } from 'node:module';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./settings/test-css-loader.mjs', import.meta.url));
const { WebhooksPane } = await import('./WebhooksView.tsx');

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

function webhooksApi({ remote = false, publicUrl = 'https://relay.example/hook/device-1' } = {}) {
  const calls = [];
  const setup = {
    backend: 'discord',
    channel: { discordChannelId: '111' },
    webhook: { enabled: true, publicUrl },
    schedules: [],
    webhooks: [{
      name: 'gh-issues', description: 'GitHub issues', parser: 'github',
      route: 'session', enabled: true, secretSet: true,
      instructions: 'Summarize the issue.',
    }],
  };
  const api = {
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'getChannelSetup') return { value: setup };
      if (capability === 'isRemoteEnabled') return { value: remote };
      if (capability === 'listWorkflows') {
        return { value: [{ id: 'default', name: 'Solo' }, { id: 'squad', name: 'Squad' }] };
      }
      calls.push([capability, args]);
      if (capability === 'saveWebhook') {
        return { value: { name: args[0]?.name, secret: 'generated-secret' } };
      }
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
    root.render(React.createElement(WebhooksPane, { api }));
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

test('webhooks pane lists endpoints and creates webhooks with a pre-minted secret', async () => {
  mount();
  const { api, calls } = webhooksApi();
  await renderPane(api);
  assert.match(document.querySelector('.schedules-page-header h1').textContent, /Webhooks/);
  const row = document.querySelector('.schedules-row');
  assert.match(row.textContent, /gh-issues/);
  // No per-row Copy URL (user decision): the URL lives in the editor only.
  assert.equal(Array.from(row.querySelectorAll('button'))
    .some((button) => button.textContent.includes('Copy URL')), false);
  // Automation is decoupled from the messaging runtime: pause works with the
  // remote/channel runtime off.
  assert.equal(Array.from(row.querySelectorAll('button'))
    .find((button) => button.textContent === 'Pause').disabled, false);

  await act(async () => {
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.includes('New webhook')).click();
    await Promise.resolve();
  });
  const form = document.querySelector('.schedules-dialog form');
  // Connection details render inside the editor with copy affordances.
  assert.equal(document.querySelectorAll('.webhook-connection-row').length, 2);
  const mintedSecret = document.querySelectorAll('.webhook-connection-value code')[1].textContent;
  assert.match(mintedSecret, /^[0-9a-f]{48}$/, 'a new webhook pre-mints its signing secret');
  form.querySelector('input[name="webhook-name"]').value = 'stripe-events';
  form.querySelector('textarea[name="webhook-instructions"]').value = 'Handle the event.';
  await submit(form);
  // The displayed pre-minted secret is exactly what gets persisted.
  assert.deepEqual(calls.filter(([name]) => name === 'saveWebhook').at(-1)[1][0], {
    name: 'stripe-events', description: '', parser: 'github', secret: mintedSecret,
    instructions: 'Handle the event.', enabled: true,
  });
  // Boolean form: a failed equality against a DOM node would serialize jsdom.
  assert.equal(document.querySelector('.schedules-dialog') === null, true,
    'the editor should close after a successful save');
});

test('editing prefills and saves with overwrite; delete requires a two-step confirm', async () => {
  mount();
  const { api, calls } = webhooksApi({ remote: true });
  await renderPane(api);
  const buttons = () => Array.from(document.querySelector('.schedules-row').querySelectorAll('button'));
  await act(async () => {
    buttons().find((button) => button.textContent === 'Edit').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const form = document.querySelector('.schedules-dialog form');
  const nameInput = form.querySelector('input[name="webhook-name"]');
  assert.equal(nameInput.value, 'gh-issues');
  assert.equal(nameInput.disabled, true);
  // Connection block: the endpoint URL stays visible; the stored secret is
  // never revealed — rotation happens behind an explicit Regenerate.
  const connection = form.querySelector('.webhook-connection');
  assert.match(connection.textContent, /https:\/\/relay\.example\/hook\/device-1\/webhook\/gh-issues/);
  assert.equal(connection.textContent.includes('stored-secret'), false);
  assert.ok(Array.from(connection.querySelectorAll('button'))
    .some((button) => button.textContent === 'Regenerate secret'));
  const instructions = form.querySelector('textarea[name="webhook-instructions"]');
  assert.equal(instructions.value, 'Summarize the issue.');
  instructions.value = 'Triage the issue.';
  await submit(form);
  const edited = calls.filter(([name]) => name === 'saveWebhook').at(-1)[1][0];
  assert.equal(edited.name, 'gh-issues');
  assert.equal(edited.overwrite, true);
  assert.equal(edited.instructions, 'Triage the issue.');
  assert.equal('secret' in edited, false,
    'editing without a replacement must not send a secret (the store preserves it)');

  // Rotation: reopen, regenerate, and save — the minted secret persists.
  await act(async () => {
    buttons().find((button) => button.textContent === 'Edit').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const reopened = document.querySelector('.schedules-dialog form');
  await act(async () => {
    Array.from(reopened.querySelectorAll('button'))
      .find((button) => button.textContent === 'Regenerate secret').click();
    await Promise.resolve();
  });
  const rotatedSecret = reopened.querySelectorAll('.webhook-connection-value code')[1].textContent;
  assert.match(rotatedSecret, /^[0-9a-f]{48}$/, 'regenerate mints a fresh signing secret');
  await submit(reopened);
  assert.equal(calls.filter(([name]) => name === 'saveWebhook').at(-1)[1][0].secret, rotatedSecret);

  const pause = buttons().find((button) => button.textContent === 'Pause');
  assert.equal(pause.disabled, false);
  await act(async () => {
    pause.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setWebhookEnabled'
    && args[0] === 'gh-issues' && args[1] === false));

  const deleteButton = () => buttons().find((button) =>
    button.textContent === 'Delete' || button.textContent === 'Confirm delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
  });
  assert.equal(deleteButton().textContent, 'Confirm delete');
  assert.equal(calls.some(([name]) => name === 'deleteWebhook'), false,
    'the first delete click must not delete');
  await act(async () => {
    deleteButton().click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'deleteWebhook' && args[0] === 'gh-issues'));
});
