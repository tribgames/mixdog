// The Agents pane's "새 에이전트" dialog: Create waits for a name, the save
// carries the picked mascot, "Advanced" reveals AGENT.md, and a created agent
// greets the user once through a hidden kickoff in its home thread.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event'],
});
const { createRoot } = await import('react-dom/client');
const { AgentCreateDialog, AgentCreateForm } = await import('./agent-create-dialog.tsx');
const { agentBodyFromBrief } = await import('./workflow-dialogs.tsx');
const { agentGreetingKickoff, greetNewAgent } = await import('./agent-greeting.ts');
const { isSessionPreviewNoise } = await import(
  '../../../../src/runtime/agent/orchestrator/runtime-core/session-text.mjs'
);
test.after(() => dom.window.close());

const models = [{ provider: 'openai', model: 'test-model', display: 'Test model', effortOptions: [] }];

function harness(t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return async (element) => act(async () => root.render(element));
}

async function type(input, value) {
  const proto =
    input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, value);
  await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
}

const dialog = () => document.querySelector('.agent-create-dialog');
const createButton = () => dialog().querySelector('button[type="submit"]');

test('Create stays off until a name is typed, and the save carries the avatar, model and job', async (t) => {
  const render = harness(t);
  const saved = [];
  await render(
    React.createElement(AgentCreateForm, {
      models,
      initialRoute: { provider: 'openai', model: 'test-model' },
      busy: false,
      onCancel() {},
      onSave: (payload) => saved.push(payload),
    })
  );
  assert.equal(createButton().disabled, true);
  // No permission field and no helper lines under the fields.
  assert.equal(dialog().querySelector('small'), null);
  assert.doesNotMatch(dialog().textContent, /Permission/i);
  await type(dialog().querySelector('.agent-create-name'), '   ');
  assert.equal(createButton().disabled, true, 'blank names do not count');
  await type(dialog().querySelector('.agent-create-name'), 'GitHub Watcher');
  assert.equal(createButton().disabled, false);

  // No tabs: the dog kinds, then accessory and colour rows.
  assert.equal(dialog().querySelector('.agent-avatar-tabs'), null);
  assert.deepEqual(
    [...dialog().querySelectorAll('[data-species]')].map((button) => button.dataset.species),
    ['labrador', 'shepherd', 'terrier', 'corgi', 'husky', 'shiba']
  );
  assert.equal(dialog().querySelectorAll('[data-accessory]').length, 6);
  await act(async () => dialog().querySelector('[data-species="shepherd"]').click());
  await act(async () => dialog().querySelector('[data-accessory="collar"]').click());
  assert.equal(dialog().querySelector('[data-expression]'), null, 'no expression row: motions carry it');
  await act(async () => dialog().querySelector('[data-color="#5b9bff"]').click());
  assert.equal(dialog().querySelector('[data-species="shepherd"]').getAttribute('aria-pressed'), 'true');
  assert.equal(dialog().querySelector('[data-signature]'), null, 'only the representative offers its own look');
  const preview = dialog().querySelector('.agent-create-preview');
  assert.equal(preview.dataset.look, 'shepherd-collar-calm', 'new picks keep the default expression');
  assert.equal(preview.dataset.color, '#5b9bff');
  await type(dialog().querySelector('input[name="agent-description"]'), 'Sum up new PRs');
  await act(async () =>
    dialog()
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].avatar, {
    kind: 'mascot',
    species: 'shepherd',
    accessory: 'collar',
    expression: 'calm',
    color: '#5b9bff',
  });
  assert.equal(saved[0].name, 'GitHub Watcher');
  assert.equal(saved[0].description, 'Sum up new PRs');
  assert.deepEqual(saved[0].route, { provider: 'openai', model: 'test-model' });
  assert.equal(
    saved[0].body,
    agentBodyFromBrief('GitHub Watcher', 'Sum up new PRs'),
    'an empty 일하는 방식 saves a body from the name and 하는 일'
  );
  assert.match(saved[0].body, /^# GitHub Watcher\n\nSum up new PRs\n\n- Help the user/);
});

test('the model picker names a custom provider by its registered name, not its generated id', async (t) => {
  const render = harness(t);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const custom = 'custom-c07a1b4c-4df1-4f8a-9c10-2e5b8d9f0117';
  await render(
    React.createElement(AgentCreateForm, {
      models: [{ provider: custom, model: 'gw-model', display: 'Gateway model', effortOptions: [] }],
      providerNames: { [custom]: 'Team Gateway' },
      initialRoute: { provider: custom, model: 'gw-model' },
      busy: false,
      onCancel() {},
      onSave() {},
    })
  );
  await act(async () => dialog().querySelector('.model-trigger').click());
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
  const sheet = document.querySelector('.route-sheet');
  await act(async () => sheet.querySelector('.route-sheet-row').click());
  // The dialog's picker is not a dropdown: the catalog opens as a flyout beside the sheet.
  const catalog = document.querySelector('.route-sheet-flyout');
  assert.match(catalog.textContent, /Team Gateway/);
  assert.doesNotMatch(catalog.textContent, /custom-c07a1b4c/);
});

test('내 이미지 takes one image per motion state: idle required, the rest optional, each resettable', async (t) => {
  const render = harness(t);
  const saved = [];
  const idle = { data: 'data:image/gif;base64,R0lGODlh', poster: 'data:image/png;base64,iVBORw0KGgo=' };
  const typing = { data: 'data:image/png;base64,iVBORw0KGgoT' };
  const uploads = [idle, typing];
  await render(
    React.createElement(AgentCreateForm, {
      models,
      initialRoute: { provider: 'openai', model: 'test-model' },
      busy: false,
      prepareImage: async () => uploads.shift(),
      onCancel() {},
      onSave: (payload) => saved.push(payload),
    })
  );
  const [basic, custom] = dialog().querySelectorAll('.agent-create-segments > button');
  assert.equal(basic.getAttribute('aria-pressed'), 'true');
  assert.ok(dialog().querySelector('.agent-avatar-picker'));
  await act(async () => custom.click());
  assert.equal(dialog().querySelector('.agent-avatar-picker'), null);
  const rows = () => [...dialog().querySelectorAll('.agent-avatar-state')];
  assert.deepEqual(
    rows().map((row) => row.dataset.state),
    ['idle', 'typing', 'message']
  );
  assert.doesNotMatch(dialog().textContent, /coming soon/, 'no later-states line');
  assert.match(dialog().textContent, /512px/, 'the format help');
  assert.equal(dialog().querySelector('.agent-avatar-starter'), null, 'no starter kit download');
  assert.equal(dialog().querySelectorAll('.agent-avatar-state-text > small').length, 1, 'only the idle row is tagged');
  assert.equal(dialog().querySelector('.agent-avatar-state[data-state="idle"] small').textContent, 'Required');
  await type(dialog().querySelector('.agent-create-name'), 'Painter');
  assert.equal(createButton().disabled, true, 'custom waits for an idle image');

  const input = (state) => dialog().querySelector(`.agent-avatar-state[data-state="${state}"] input[type="file"]`);
  assert.equal(input('idle').getAttribute('accept'), 'image/png,image/gif,image/webp,image/jpeg');
  const pick = async (state, file) => {
    Object.defineProperty(input(state), 'files', { configurable: true, value: [file] });
    await act(async () => input(state).dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  await pick('idle', { type: 'image/svg+xml', size: 10 });
  assert.match(dialog().textContent, /Only PNG, GIF, WebP or JPG/, 'no SVG');
  await pick('idle', { type: 'image/gif', size: 2 * 1024 * 1024 });
  assert.match(dialog().textContent, /1 MB or smaller/);
  await pick('idle', { type: 'image/gif', size: 100 });
  const preview = dialog().querySelector('img.agent-create-preview');
  assert.ok(preview, 'the idle image previews above');
  assert.equal(createButton().disabled, false);
  await pick('typing', { type: 'image/png', size: 100 });
  const typingRow = dialog().querySelector('.agent-avatar-state[data-state="typing"]');
  const reset = [...typingRow.querySelectorAll('button')].find((button) => button.textContent === 'Remove');
  assert.ok(reset, 'an own state image can be removed');
  assert.equal(
    typingRow.querySelector('.agent-avatar-state-thumb').dataset.fallback,
    undefined,
    'own image: not dimmed'
  );
  const messageRow = dialog().querySelector('.agent-avatar-state[data-state="message"]');
  assert.equal(messageRow.querySelector('.agent-avatar-state-thumb').dataset.fallback, 'true', 'fallback is marked');
  assert.ok(
    ![...messageRow.querySelectorAll('button')].some((b) => b.textContent === 'Remove'),
    'no remove without own image'
  );
  await act(async () => reset.click());
  assert.equal(typingRow.querySelector('.agent-avatar-state-thumb').dataset.fallback, 'true', 'removed → falls back');
  assert.ok(![...typingRow.querySelectorAll('button')].some((b) => b.textContent === 'Remove'));
  assert.equal(typingRow.querySelector('small'), null, 'a state row shows no sub-text');
  await act(async () =>
    dialog()
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.deepEqual(saved[0].avatar, { kind: 'custom', states: { idle } });

  // Back to 마스코트: the picker and a mascot preview again.
  await act(async () => basic.click());
  assert.ok(dialog().querySelector('svg.agent-create-preview'));

  // Removing the base image returns to 마스코트 and drops every state image.
  await act(async () => custom.click());
  await pick('typing', { type: 'image/png', size: 100 });
  const idleRemove = [...dialog().querySelectorAll('.agent-avatar-state[data-state="idle"] button')].find(
    (button) => button.textContent === 'Remove'
  );
  await act(async () => idleRemove.click());
  assert.equal(dialog().querySelector('.agent-avatar-states'), null);
  assert.ok(dialog().querySelector('.agent-avatar-picker'), 'mascot picker again');
  await act(async () => custom.click());
  assert.equal(
    dialog().querySelector('.agent-avatar-state[data-state="typing"] .agent-avatar-state-thumb img'),
    null,
    'state images are gone'
  );
});

test('"성격과 일하는 방식" expands to PERSONA.md (empty) and AGENT.md (default body); files load into the right editor', async (t) => {
  const render = harness(t);
  const saved = [];
  await render(
    React.createElement(AgentCreateForm, {
      models,
      initialRoute: { provider: 'openai', model: 'test-model' },
      busy: false,
      onCancel() {},
      onSave: (payload) => saved.push(payload),
    })
  );
  assert.equal(dialog().querySelector('h3'), null, 'no "기본" heading above the fields');
  assert.equal(dialog().querySelector('.agent-create-advanced'), null, 'no folded row');
  assert.ok(
    [...dialog().querySelectorAll('.agent-avatar-row-label')].some((el) => el.textContent === 'Instruction settings'),
    '지침 설정 label'
  );
  const persona = dialog().querySelector('textarea[aria-label="PERSONA.md"]');
  const body = dialog().querySelector('textarea[aria-label="AGENT.md"]');
  assert.equal(persona.value, '');
  assert.match(persona.getAttribute('placeholder'), /tone/);
  assert.equal(body.value, '', '일하는 방식 starts empty too');
  assert.match(body.getAttribute('placeholder'), /filled from the name/);

  const pick = async (kind, file) => {
    const input = dialog().querySelector(`.agent-instruction-editor[data-kind="${kind}"] input[type="file"]`);
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const textFile = (name, text, size = text.length) => ({ name, size, text: async () => text });
  await pick('persona', textFile('me.md', '반말로 친근하게'));
  assert.equal(dialog().querySelector('textarea[aria-label="PERSONA.md"]').value, '반말로 친근하게');
  assert.equal(dialog().querySelector('textarea[aria-label="AGENT.md"]').value, '', 'the other editor is untouched');
  await pick('agent', textFile('role.txt', '# Role\nShip releases.'));
  assert.equal(dialog().querySelector('textarea[aria-label="AGENT.md"]').value, '# Role\nShip releases.');
  await pick('agent', textFile('big.md', 'x', 300 * 1024));
  assert.match(dialog().textContent, /256 KB/);
  await pick('agent', textFile('image.png', 'x'));
  assert.equal(dialog().querySelector('textarea[aria-label="AGENT.md"]').value, '# Role\nShip releases.');

  await type(dialog().querySelector('.agent-create-name'), 'Buddy');
  await act(async () =>
    dialog()
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.equal(saved[0].persona, '반말로 친근하게');
  assert.equal(saved[0].body, '# Role\nShip releases.');
});

test('the greeting kickoff is a hidden runtime turn that never previews or titles the thread', async () => {
  const kickoff = agentGreetingKickoff({ name: 'ddd', description: 'Watch PRs', language: 'ko' });
  assert.match(kickoff, /^\[mixdog-runtime\]/);
  assert.match(kickoff, /"ddd"/);
  assert.match(kickoff, /Watch PRs/);
  assert.doesNotMatch(kickoff, /mixdog:suggestions/, 'the greeting asks for no reply suggestions');
  assert.match(kickoff, /how you will work/);
  assert.equal(isSessionPreviewNoise(kickoff), true);
  const calls = [];
  const sessionId = await greetNewAgent(
    {
      openAgentHome: async (id) => {
        calls.push(['open', id]);
        return { sessionId: `sess_home_${id}` };
      },
      submitToSession: async (...args) => {
        calls.push(['submit', ...args]);
        return true;
      },
    },
    { id: 'ddd', name: 'ddd', description: '' }
  );
  assert.equal(sessionId, 'sess_home_ddd');
  assert.deepEqual(calls[0], ['open', 'ddd']);
  assert.equal(calls[1][1], 'sess_home_ddd');
  assert.deepEqual(calls[1][3], { kickoff: true });
});

test('creating from the dialog greets once and opens the home thread', async (t) => {
  const render = harness(t);
  const calls = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      calls.push(['capability', capability]);
      // A dialog-made agent is a bot: the explicit marker, never "unmarked = bot".
      if (capability === 'saveAgentDefinition') assert.equal(args[0].kind, 'bot');
      if (capability === 'saveAgentDefinition') return { value: { id: 'github-watcher', name: args[0].name } };
      return { value: null };
    },
    listProviderModels: async () => models,
    openAgentHome: async (id) => {
      calls.push(['open', id]);
      return { sessionId: `sess_home_${id}` };
    },
    submitToSession: async (sessionId, _prompt, options) => {
      calls.push(['submit', sessionId, options]);
      return true;
    },
  };
  t.after(() => delete dom.window.mixdogDesktop);
  const opened = [];
  let closed = 0;
  await render(
    React.createElement(AgentCreateDialog, {
      initialRoute: { provider: 'openai', model: 'test-model' },
      onClose: () => (closed += 1),
      onCreated: (sessionId, name) => opened.push([sessionId, name]),
    })
  );
  await type(dialog().querySelector('.agent-create-name'), 'GitHub Watcher');
  await act(async () =>
    dialog()
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(closed, 1);
  assert.deepEqual(
    calls.filter(([kind]) => kind !== 'capability'),
    [
      ['open', 'github-watcher'],
      ['submit', 'sess_home_github-watcher', { kickoff: true }],
    ]
  );
  assert.deepEqual(opened, [['sess_home_github-watcher', 'GitHub Watcher']]);
});

test('with models to choose from, Create waits for a model too; without any it saves model-less', async (t) => {
  const render = harness(t);
  const saved = [];
  await render(
    React.createElement(AgentCreateForm, {
      models,
      busy: false,
      onCancel() {},
      onSave: (payload) => saved.push(payload),
    })
  );
  await type(dialog().querySelector('.agent-create-name'), 'Buddy');
  assert.equal(createButton().disabled, true, 'a named bot still needs a model');
  await render(
    React.createElement(AgentCreateForm, {
      models: [],
      busy: false,
      onCancel() {},
      onSave: (payload) => saved.push(payload),
    })
  );
  await type(dialog().querySelector('.agent-create-name'), 'Buddy');
  assert.equal(createButton().disabled, false, 'no model exists to choose: signing in comes first');
  await act(async () =>
    dialog()
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.equal(saved[0].route, undefined);
});

test('an agent created without a model opens its thread without the failing greeting turn', async () => {
  const calls = [];
  const sessionId = await greetNewAgent(
    {
      openAgentHome: async (id) => {
        calls.push(['open', id]);
        return { sessionId: `sess_home_${id}` };
      },
      submitToSession: async () => {
        calls.push(['submit']);
        return true;
      },
    },
    { id: 'ddd', name: 'ddd', description: '', greet: false }
  );
  assert.equal(sessionId, 'sess_home_ddd');
  assert.deepEqual(calls, [['open', 'ddd']]);
});
