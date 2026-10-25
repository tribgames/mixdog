// The agent panel: 프로필 · 루틴 tabs, the profile's inline edit (face,
// persona, model) saved through the existing paths, Mixy's name and face
// (agents/lead/agent.json), "대화 새로 시작" behind a confirmation, and the contact row's menu.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent'],
});
// jsdom has no layout: the model catalog scrolls its pick into view.
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { AgentProfilePane, AgentProfileForm } = await import('./AgentProfilePane.tsx');
const { AgentPanel } = await import('./RoutinesPane.tsx');
const { useDockPanelActions } = await import('./dock-panel-actions.ts');
const { BOT_DELETED_EVENT, agentContactMenuItems, resetConversation } = await import('./agent-profile-actions.ts');
const { publishAgentModeSessions } = await import('./agent-chat-mode.ts');
const { agentPanelTab, openAgentProfile, setAgentPanelTab, OPEN_AGENT_PANEL_EVENT } = await import(
  './agent-panel-tab.ts'
);
test.after(() => dom.window.close());

const models = [
  { provider: 'openai', model: 'test-model', display: 'Test model', effortOptions: [] },
  { provider: 'anthropic', model: 'second-model', display: 'Second model', effortOptions: [] },
];

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

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

// 외형 (the face editor) is folded until its row is opened.
const lookToggle = () => document.querySelector('.agent-profile .agent-create-advanced[aria-expanded]');
const openLook = () => act(async () => lookToggle().click());

async function type(input, value) {
  const proto =
    input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, value);
  await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
}

async function pickModel(display) {
  await act(async () => document.querySelector('.agent-profile .model-trigger').click());
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
  await act(async () => document.querySelector('.route-sheet .route-sheet-row').click());
  const option = [...document.querySelectorAll('.route-sheet[data-drilled] button')].find((button) =>
    button.textContent.includes(display)
  );
  assert.ok(option, `the catalog lists ${display}`);
  await act(async () => option.click());
}

const button = (label) =>
  [...document.querySelectorAll('.agent-profile button')].find((node) => node.textContent.trim() === label);

/** An api over one agent definition; every call is recorded. */
function fakeApi(definition) {
  const calls = [];
  return {
    calls,
    api: {
      invokeCapability: async ({ capability, args }) => {
        calls.push([capability, ...args]);
        if (capability === 'getAgentDefinition') return { value: definition };
        if (capability === 'getLeadPersona') return { value: '반말로 답합니다.' };
        if (capability === 'getLeadAgentBody') return { value: '일정을 먼저 챙깁니다.' };
        if (capability === 'getLeadStatus') return { value: { created: true, name: '', avatar: null } };
        if (capability === 'saveLeadIdentity') return { value: { created: true, avatar: null, ...args[0] } };
        if (capability === 'getChannelSetup') return { value: { schedules: [], webhooks: [] } };
        return { value: true };
      },
      setModelRoute: async (...args) => {
        calls.push(['setModelRoute', ...args]);
        return null;
      },
    },
  };
}

const WATCHER = {
  id: 'github-watcher',
  name: 'GitHub 감시',
  description: '새 이슈를 요약합니다',
  body: 'Work.',
  avatar: { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' },
  route: { provider: 'openai', model: 'test-model' },
  persona: '',
  disabled: false,
};

test('the profile edit saves the face, persona and model through saveAgentDefinition, with Save only once changed', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(WATCHER);
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models })
  );
  await settle();
  const hero = document.querySelector('.agent-profile-hero');
  assert.match(hero.textContent, /GitHub 감시/);
  assert.match(hero.textContent, /새 이슈를 요약합니다/);
  assert.equal(document.querySelector('.agent-profile-footer'), null, 'no Save or Cancel before a change');
  // 외형 sits under the hero, folded by default, and opens and closes in place.
  assert.equal(lookToggle().textContent, 'Appearance');
  assert.equal(lookToggle().getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.agent-profile-face-editor'), null, 'collapsed: no rows');
  assert.equal(
    hero.compareDocumentPosition(lookToggle()) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'right after the hero'
  );
  assert.ok(
    lookToggle().compareDocumentPosition(document.querySelector('input[name="agent-name"]')) &
      document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'above the basic fields'
  );
  await openLook();
  assert.equal(lookToggle().getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('.agent-profile-face-editor [data-species]'), 'expanded: the rows');
  await openLook();
  assert.equal(document.querySelector('.agent-profile-face-editor'), null, 'folds again');
  await openLook();

  await act(async () => document.querySelector('[data-color="#f2c94c"]').click());
  assert.ok(document.querySelector('.agent-profile-footer'), 'a change shows Save and Cancel');
  assert.equal(
    document.querySelector('.agent-profile-footer-note').textContent,
    'Applies from the next message.',
    'the bar says when the change takes effect'
  );
  await act(async () => button('Cancel').click());
  assert.equal(document.querySelector('.agent-profile-footer'), null, 'Cancel puts the stored profile back');

  await act(async () => document.querySelector('[data-color="#f2c94c"]').click());
  await act(async () => document.querySelector('[data-species="corgi"]').click());
  assert.equal(document.querySelector('.agent-profile-avatar').dataset.look, 'corgi-collar-calm');
  await type(document.querySelector('textarea[aria-label="PERSONA.md"]'), '반말로 친근하게');
  await pickModel('Second model');
  await act(async () =>
    document
      .querySelector('.agent-profile-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  const save = calls.find(([capability]) => capability === 'saveAgentDefinition');
  assert.ok(save, 'saved through the agent editor');
  const payload = save[1];
  assert.equal(payload.id, 'github-watcher');
  assert.equal(payload.name, 'GitHub 감시');
  assert.deepEqual(payload.avatar, {
    kind: 'mascot',
    species: 'corgi',
    accessory: 'collar',
    expression: 'calm',
    color: '#f2c94c',
  });
  assert.equal(payload.persona, '반말로 친근하게');
  assert.equal(payload.route.provider, 'anthropic');
  assert.equal(payload.route.model, 'second-model');
  assert.equal(payload.body, 'Work.', 'the AGENT.md body is kept');
  assert.equal(
    calls.filter(([capability]) => capability === 'getAgentDefinition').length,
    2,
    'the profile re-reads after the save'
  );
});

const contextModel = {
  provider: 'cursor-oauth',
  model: 'claude-opus-5-5',
  display: 'Claude Opus 5.5',
  effortOptions: [{ value: 'high', label: 'High' }],
  fastCapable: true,
  fastEfforts: ['high'],
  contextWindow: 300_000,
  maxContextWindow: 1_000_000,
  defaultModelParameters: { context: '300k' },
  modelParameterOptions: [
    {
      id: 'context',
      label: 'Context',
      options: [
        { value: '300k', label: '300K' },
        { value: '1m', label: '1M' },
      ],
    },
  ],
};
const contextRoute = {
  provider: contextModel.provider,
  model: contextModel.model,
  effort: 'high',
  fast: false,
  // Keep all other stored options stable so they cannot mask a context-only edit.
  modelParameters: { context: '300k' },
  contextPercent: 30,
};

async function openProfileContext(fallback) {
  const trigger = document.querySelectorAll('.model-trigger')[fallback ? 1 : 0];
  await act(async () => trigger.click());
  const context = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((row) =>
    row.textContent.startsWith('Context')
  );
  assert.ok(context);
  await act(async () => context.click());
}

async function commitProfileContext(slider, percent) {
  await type(slider, String(percent));
  await act(async () =>
    slider.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  );
}

for (const fallback of [false, true]) {
  const label = fallback ? 'fallback' : 'primary';
  const chain = (route) => (fallback ? { ...WATCHER.route, fallbacks: [route] } : route);
  const editedRoute = (route) => (fallback ? route.fallbacks[0] : route);

  test(`a ${label} context-only profile edit enables Apply and saves the selected percentage`, async (t) => {
    const render = harness(t);
    const id = `context-percent-${label}`;
    const definition = { ...WATCHER, id, route: chain(contextRoute) };
    const { api, calls } = fakeApi(definition);
    const invoke = api.invokeCapability;
    api.invokeCapability = async (request) => {
      if (request.capability === 'saveAgentDefinition') definition.route = structuredClone(request.args[0].route);
      return invoke(request);
    };
    await render(
      React.createElement(AgentProfilePane, {
        sessionId: `sess_home_${id}`,
        active: true,
        api,
        models: [...models, contextModel],
      })
    );
    await settle();
    assert.equal(document.querySelector('.agent-profile-footer'), null);
    await openProfileContext(fallback);
    const slider = document.querySelector('input[type="range"][aria-label="Context"]');
    assert.ok(slider);
    await commitProfileContext(slider, 100);
    const apply = document.querySelector('.agent-profile-footer button[type="submit"]');
    assert.ok(apply, 'the context-only change is dirty');
    assert.equal(apply.disabled, false);
    await commitProfileContext(slider, 30);
    assert.equal(document.querySelector('.agent-profile-footer'), null, 'returning to the saved context is clean');
    await commitProfileContext(slider, 100);
    await act(async () => button('Cancel').click());
    assert.equal(document.querySelector('.agent-profile-footer'), null, 'Cancel restores the saved context');
    assert.equal(Number(slider.value), 30);
    await commitProfileContext(slider, 100);
    await act(async () => document.querySelector('.agent-profile-footer button[type="submit"]').click());
    await settle();
    const saved = calls.find(([capability]) => capability === 'saveAgentDefinition');
    assert.ok(saved);
    assert.equal(editedRoute(saved[1].route).contextPercent, 100);
    assert.deepEqual(editedRoute(saved[1].route).modelParameters, contextRoute.modelParameters);
    assert.deepEqual(calls.find(([name]) => name === 'setModelRoute').slice(1), [saved[1].route, `sess_home_${id}`]);
    assert.equal(document.querySelector('.agent-profile-footer'), null, 'the saved profile reloads clean');
    await openProfileContext(fallback);
    assert.equal(Number(document.querySelector('input[type="range"][aria-label="Context"]').value), 100);
  });

  for (const [kind, selection, sliderPercent, displayedTokens] of [
    ['percentage', { contextPercent: 80 }, 80, 800],
    ['exact', { contextPercent: 80, contextTokens: 750_000 }, 75, 750],
  ]) {
    test(`the profile loads the saved ${label} ${kind} context instead of the catalog default`, async (t) => {
      const render = harness(t);
      const id = `context-load-${label}-${kind}`;
      const { api } = fakeApi({
        ...WATCHER,
        id,
        route: chain({ ...contextRoute, ...selection }),
      });
      await render(
        React.createElement(AgentProfilePane, {
          sessionId: `sess_home_${id}`,
          active: true,
          api,
          models: [...models, contextModel],
        })
      );
      await settle();
      await openProfileContext(fallback);
      const slider = document.querySelector('input[type="range"][aria-label="Context"]');
      assert.equal(Number(slider.value), sliderPercent);
      assert.ok(document.querySelector('.route-context-head').textContent.includes(String(displayedTokens)));
      assert.equal(document.querySelector('.agent-profile-footer'), null, 'loading does not dirty the profile');
    });
  }

  test(`a ${label} exact-token edit is dirty even when its rounded percentage stays the same`, async (t) => {
    const render = harness(t);
    const changes = [];
    await render(
      React.createElement(AgentProfileForm, {
        agentId: `context-tokens-${label}`,
        profile: {
          ...WATCHER,
          route: chain({ ...contextRoute, contextPercent: 80, contextTokens: 750_000 }),
        },
        models: [...models, contextModel],
        busy: false,
        error: '',
        onSave: (next) => changes.push(next),
      })
    );
    await openProfileContext(fallback);
    await act(async () => document.querySelector('button[aria-label="Edit context size"]').click());
    const input = document.querySelector('input[aria-label="Context size"]');
    await type(input, '790');
    await act(async () =>
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    const apply = document.querySelector('.agent-profile-footer button[type="submit"]');
    assert.ok(apply, 'the exact-token-only change is dirty');
    await act(async () => apply.click());
    assert.equal(changes.length, 1);
    assert.equal(editedRoute(changes[0].route).contextPercent, 80);
    assert.equal(editedRoute(changes[0].route).contextTokens, 790_000);
  });
}

test('사용할 커넥터 lists every installed connector with an on/off switch that saves at once', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(WATCHER);
  let rows = [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: true },
  ];
  const base = api.invokeCapability;
  api.invokeCapability = async (request) => {
    if (request.capability === 'getAgentConnectors') return { value: rows };
    if (request.capability === 'setAgentConnectorEnabled') {
      calls.push([request.capability, ...request.args]);
      const [, id, enabled] = request.args;
      rows = rows.map((row) => (row.id === id ? { ...row, enabled } : row));
      return { value: rows };
    }
    return base(request);
  };
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models })
  );
  await settle();
  const list = document.querySelector('[data-connector-switches="agent"]');
  assert.ok(list);
  assert.match(document.querySelector('.agent-profile-connectors').textContent, /Connectors/);
  const inputs = [...list.querySelectorAll('input[type="checkbox"]')];
  assert.equal(inputs.length, 2);
  assert.deepEqual(
    inputs.map((input) => input.checked),
    [true, true],
    'new connectors show on'
  );
  await act(async () => inputs[1].click());
  await settle();
  assert.deepEqual(calls.at(-1), ['setAgentConnectorEnabled', 'github-watcher', 'notion', false]);
  assert.equal(list.querySelectorAll('input[type="checkbox"]')[1].checked, false);
  assert.equal(
    calls.some(([capability]) => capability === 'setAgentConnectorToolPermission'),
    false,
    'no per-tool asks'
  );
});

test('a save over an agent changed elsewhere is refused; the edits stay until "다시 불러오기"', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi({ ...WATCHER, revision: 'rev-1' });
  const save = api.invokeCapability;
  api.invokeCapability = async (request) => {
    if (request.capability !== 'saveAgentDefinition') return save(request);
    calls.push([request.capability, ...request.args]);
    throw new Error('AGENT_DEFINITION_CONFLICT: agent "github-watcher" changed since it was loaded');
  };
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models })
  );
  await settle();
  const persona = () => document.querySelector('textarea[aria-label="PERSONA.md"]');
  await type(persona(), '내 편집');
  await act(async () =>
    document
      .querySelector('.agent-profile-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  const sent = calls.find(([name]) => name === 'saveAgentDefinition')[1];
  assert.equal(sent.expectedRevision, 'rev-1', 'the profile sends back the revision it loaded');
  const notice = document.querySelector('.agent-profile-conflict');
  assert.ok(notice, 'the conflict is shown');
  assert.match(notice.textContent, /Changed elsewhere · Load again/);
  assert.equal(persona().value, '내 편집', 'the unsaved edit stays visible');
  assert.ok(document.querySelector('.agent-profile-footer'), 'still dirty: Save and Cancel stay');
  const loads = () => calls.filter(([name]) => name === 'getAgentDefinition').length;
  assert.equal(loads(), 1, 'nothing reloads by itself');
  await act(async () => notice.querySelector('button').click());
  await settle();
  assert.equal(loads(), 2);
  assert.equal(document.querySelector('.agent-profile-conflict'), null);
  assert.equal(persona().value, '', 'the reload shows the stored profile');
});

test("Mixy's name and face are editable; its model is its own (never the Lead route), the rest its own files", async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(null);
  await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_lead', active: true, api, models }));
  await settle();
  const profile = document.querySelector('.agent-profile');
  assert.match(profile.querySelector('.agent-profile-name').textContent, /Mixy/);
  const name = profile.querySelector('input[name="agent-name"]');
  assert.equal(name.value, 'Mixy', 'the default name, editable');
  assert.equal(profile.querySelector('.agent-create-segments'), null, 'the face editor is folded');
  await openLook();
  assert.ok(profile.querySelector('.agent-create-segments'), 'the face editor');
  assert.ok(profile.querySelector('.agent-profile-face .agent-contact-badge'), 'the star stays');
  const body = profile.querySelector('textarea[aria-label="AGENT.md"]');
  assert.equal(body.value, '일정을 먼저 챙깁니다.', 'read from agents/lead/AGENT.md');
  assert.equal(body.placeholder, 'Write how the representative bot works. Left empty, it works the default way.');
  assert.equal(button('Turn off'), undefined, 'never switched off');
  assert.equal(button('Delete'), undefined, 'never deleted');
  assert.equal(document.querySelector('.agent-profile-actions'), null, 'no button footer');
  const persona = profile.querySelector('textarea[aria-label="PERSONA.md"]');
  assert.equal(persona.value, '반말로 답합니다.', 'read from agents/lead/PERSONA.md');

  await type(persona, '존댓말로 답합니다.');
  await type(body, '메일부터 확인합니다.');
  await type(name, 'Navi');
  // Mixy starts on its own look and gets the same full picker.
  const signature = profile.querySelector('[data-signature]');
  assert.equal(signature.textContent, 'Default');
  assert.equal(signature.closest('.agent-avatar-row').querySelector('button'), signature, 'first of the Kind row');
  assert.equal(signature.getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'mixy-none-calm');
  // On the signature look: accessory and colour dress it and keep the species.
  assert.equal(profile.querySelector('[data-expression]'), null);
  await act(async () => document.querySelector('[data-accessory="scarf"]').click());
  await act(async () => document.querySelector('[data-color="#5b9bff"]').click());
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'mixy-scarf-calm');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.color, '#5b9bff');
  assert.equal(signature.getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('[data-accessory="scarf"]').getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('button[data-color="#5b9bff"]').getAttribute('aria-pressed'), 'true');
  await act(async () => document.querySelector('[data-species="corgi"]').click());
  assert.equal(profile.querySelector('[data-expression]'), null, 'no expression row for a dog either');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'corgi-scarf-calm');
  await act(async () => document.querySelector('[data-accessory="beanie"]').click());
  await act(async () => document.querySelector('[data-color="#f2c94c"]').click());
  assert.equal(signature.getAttribute('aria-pressed'), 'false');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'corgi-beanie-calm');
  assert.ok(profile.querySelector('.agent-profile-face .agent-contact-badge'), 'the star stays on any look');
  await pickModel('Second model');
  await act(async () =>
    profile.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  // Mixy's own route first — never the Lead's Main route — then its thread.
  const own = calls.filter(([name]) => name === 'setAgentRoute');
  assert.equal(own.length, 1);
  assert.equal(own[0][1], 'lead');
  assert.equal(own[0][2].model, 'second-model');
  const routes = calls.filter(([name]) => name === 'setModelRoute');
  assert.equal(routes.length, 1, 'the Lead Main route is never written');
  assert.equal(routes[0][2], 'sess_home_lead', 'only its own thread');
  assert.ok(calls.some(([name, text]) => name === 'saveLeadPersona' && text === '존댓말로 답합니다.'));
  assert.ok(calls.some(([name, text]) => name === 'saveLeadAgentBody' && text === '메일부터 확인합니다.'));
  const identity = calls.find(([call]) => call === 'saveLeadIdentity');
  assert.equal(identity[1].name, 'Navi', 'agents/lead/agent.json name');
  assert.deepEqual(identity[1].avatar, {
    kind: 'mascot',
    species: 'corgi',
    accessory: 'beanie',
    expression: 'calm',
    color: '#f2c94c',
  });
  // Every surface follows the new name, the AGENT.md placeholder too.
  await settle();
  assert.equal(
    document.querySelector('textarea[aria-label="AGENT.md"]').placeholder,
    'Write how the representative bot works. Left empty, it works the default way.'
  );
  assert.ok(!calls.some(([call]) => call === 'saveAgentDefinition'), 'Mixy has no agent definition to write');
});

test('Mixy dressed in an accessory and colour is saved as species mixy, not as the first dog', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(null);
  const dressed = { kind: 'mascot', species: 'mixy', accessory: 'scarf', expression: 'calm', color: '#5b9bff' };
  const base = api.invokeCapability;
  api.invokeCapability = async (request) =>
    request.capability === 'getLeadStatus' ? { value: { created: true, name: '', avatar: dressed } } : base(request);
  await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_lead', active: true, api, models }));
  await settle();
  const profile = document.querySelector('.agent-profile');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'mixy-scarf-calm', 'the saved look loads');
  await openLook();
  assert.equal(profile.querySelector('[data-signature]').getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('[data-accessory="scarf"]').getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('button[data-color="#5b9bff"]').getAttribute('aria-pressed'), 'true');
  // Saving a change keeps the species mixy plus the accessory and colour.
  await act(async () => profile.querySelector('[data-accessory="bow"]').click());
  await act(async () =>
    profile.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  const saved = JSON.stringify(calls);
  assert.match(saved, /"species":"mixy"/);
  assert.match(saved, /"accessory":"bow"/);
  assert.match(saved, /"color":"#5b9bff"/);
});

test('기본 keeps the chosen accessory and colour: a scarfed yellow dog becomes the scarfed yellow signature', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(null);
  const dog = { kind: 'mascot', species: 'corgi', accessory: 'scarf', expression: 'calm', color: '#f2c94c' };
  const base = api.invokeCapability;
  api.invokeCapability = async (request) =>
    request.capability === 'getLeadStatus' ? { value: { created: true, name: '', avatar: dog } } : base(request);
  await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_lead', active: true, api, models }));
  await settle();
  const profile = document.querySelector('.agent-profile');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'corgi-scarf-calm');
  await openLook();
  await act(async () => profile.querySelector('[data-signature]').click());
  const preview = profile.querySelector('.agent-profile-avatar');
  assert.equal(preview.dataset.look, 'mixy-scarf-calm');
  assert.equal(preview.dataset.color, '#f2c94c');
  assert.equal(profile.querySelector('[data-signature]').getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('[data-accessory="scarf"]').getAttribute('aria-pressed'), 'true');
  assert.equal(profile.querySelector('button[data-color="#f2c94c"]').getAttribute('aria-pressed'), 'true');
  await act(async () =>
    profile.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  assert.deepEqual(calls.find(([call]) => call === 'saveLeadIdentity')[1].avatar, {
    kind: 'mascot',
    species: 'mixy',
    accessory: 'scarf',
    expression: 'calm',
    color: '#f2c94c',
  });
});

for (const [removed, expected] of [
  ['typing', { kind: 'custom', states: { idle: 'avatar-0123456789ab.png' } }],
  ['idle', { kind: 'mascot', species: 'labrador', accessory: 'collar', expression: 'calm', color: '#5b9bff' }],
]) {
  test(`removing the ${removed} image persists through the save path`, async (t) => {
    const render = harness(t);
    const { api, calls } = fakeApi(null);
    const custom = { kind: 'custom', states: { idle: 'avatar-0123456789ab.png', typing: 'typing-0123456789ab.png' } };
    const base = api.invokeCapability;
    api.invokeCapability = async (request) =>
      request.capability === 'getLeadStatus' ? { value: { created: true, name: '', avatar: custom } } : base(request);
    await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_lead', active: true, api, models }));
    await settle();
    const profile = document.querySelector('.agent-profile');
    await openLook();
    const imageMode = [...profile.querySelectorAll('.agent-create-segments button')][1];
    assert.equal(imageMode.getAttribute('aria-pressed'), 'true');
    const remove = [...profile.querySelectorAll(`.agent-avatar-state[data-state="${removed}"] button`)].find(
      (button) => button.textContent === 'Remove'
    );
    await act(async () => remove.click());
    if (removed === 'idle') assert.equal(imageMode.getAttribute('aria-pressed'), 'false', 'back to 마스코트');
    await act(async () =>
      profile.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle();
    assert.deepEqual(calls.find(([call]) => call === 'saveLeadIdentity')[1].avatar, expected);
  });
}

test('기본 Mixy 모습 takes Mixy back to its own look: saved as no avatar', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(null);
  const corgi = { kind: 'mascot', species: 'corgi', accessory: 'none', expression: 'calm', color: '#e6e6e6' };
  const base = api.invokeCapability;
  api.invokeCapability = async (request) =>
    request.capability === 'getLeadStatus' ? { value: { created: true, name: '', avatar: corgi } } : base(request);
  await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_lead', active: true, api, models }));
  await settle();
  const profile = document.querySelector('.agent-profile');
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'corgi-none-calm', 'its saved pick shows');
  await openLook();
  assert.equal(profile.querySelector('[data-signature]').getAttribute('aria-pressed'), 'false');
  await act(async () => profile.querySelector('[data-signature]').click());
  assert.equal(profile.querySelector('.agent-profile-avatar').dataset.look, 'mixy-none-calm');
  await act(async () =>
    profile.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  assert.equal(calls.find(([call]) => call === 'saveLeadIdentity')[1].avatar, null);
});

test('the dock header ⋯ actions: 끄기, then 삭제 after a separator (confirmed); none for Mixy', async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(WATCHER);
  const answers = [false, true];
  const asked = [];
  let actions = [];
  const Probe = () => {
    actions = useDockPanelActions('leaf-1');
    return null;
  };
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Probe),
      React.createElement(AgentProfilePane, {
        sessionId: 'sess_home_github-watcher',
        active: true,
        api,
        models,
        leafId: 'leaf-1',
        confirm: (message) => {
          asked.push(message);
          return answers.shift();
        },
      })
    )
  );
  await settle();
  assert.deepEqual(
    actions.map((action) => [action.label, Boolean(action.separatorBefore), Boolean(action.danger)]),
    [
      ['Reset conversation', false, false],
      ['Turn off', false, false],
      ['Delete', true, true],
    ]
  );
  await act(async () => actions[2].onSelect());
  await settle();
  assert.equal(
    calls.filter(([name]) => name === 'deleteAgentDefinition').length,
    0,
    'a declined confirm deletes nothing'
  );
  const closed = [];
  const onDeleted = (event) => closed.push(event.detail.sessionId);
  window.addEventListener(BOT_DELETED_EVENT, onDeleted);
  t.after(() => window.removeEventListener(BOT_DELETED_EVENT, onDeleted));
  await act(async () => actions[2].onSelect());
  await settle();
  assert.deepEqual(
    calls.filter(([name]) => name === 'deleteAgentDefinition'),
    [['deleteAgentDefinition', 'github-watcher']]
  );
  assert.match(asked[0], /GitHub 감시/);
  assert.deepEqual(actions, [], 'a deleted agent leaves no menu');
  assert.deepEqual(closed, ['sess_home_github-watcher'], "the bot's chat tabs are told to close");
});

test("a deleted bot's profile says so: no load, no raw not-found error", async (t) => {
  const render = harness(t);
  const { api, calls } = fakeApi(WATCHER);
  publishAgentModeSessions([{ id: 'sess_home_github-watcher', agentDeleted: true }]);
  t.after(() => publishAgentModeSessions([]));
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models })
  );
  await settle();
  assert.equal(document.querySelector('.utility-dock-empty')?.textContent, 'This bot was deleted.');
  assert.equal(document.querySelector('.agent-profile'), null);
  assert.deepEqual(
    calls.filter(([name]) => name === 'getAgentDefinition'),
    [],
    'the gone definition is never read'
  );
});

test('Mixy publishes only 대화 초기화: asked first, refused while replying, then reset on the host', async (t) => {
  const render = harness(t);
  const { api } = fakeApi(null);
  const resets = [];
  api.resetAgentHome = async (agentId) => {
    resets.push(agentId);
    return { sessionId: 'sess_home_lead', archivedSessionId: 'sess_old' };
  };
  const answers = [false, true];
  const asked = [];
  let actions = ['unset'];
  const Probe = () => {
    actions = useDockPanelActions('leaf-2');
    return null;
  };
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Probe),
      React.createElement(AgentProfilePane, {
        sessionId: 'sess_home_lead',
        active: true,
        api,
        models,
        leafId: 'leaf-2',
        confirm: (message) => {
          asked.push(message);
          return answers.shift();
        },
      })
    )
  );
  await settle();
  assert.deepEqual(
    actions.map((action) => action.label),
    ['Reset conversation']
  );
  const select = async () => {
    await act(async () => actions[0].onSelect());
    await settle();
  };
  await select();
  assert.deepEqual(resets, [], 'a declined confirm resets nothing');
  assert.match(asked[0], /memory, routines and settings stay/);
  await select();
  assert.deepEqual(resets, ['lead']);
});

test('resetConversation is refused while the chat replies: no question, no reset', async () => {
  const asked = [];
  let called = 0;
  const done = await resetConversation(
    { confirm: (message) => asked.push(message) },
    { scope: 's', running: true, reset: async () => called++ }
  );
  assert.equal(done, false);
  assert.deepEqual(asked, []);
  assert.equal(called, 0);
});

test('a contact row menu: profile, off, delete, and no open in tab; Mixy has no off or delete', () => {
  const handlers = { onOpen() {}, onProfile() {} };
  const ids = (contact) => agentContactMenuItems(contact, handlers).map((item) => item.id);
  assert.deepEqual(ids({ agentId: 'github-watcher', name: 'GitHub 감시', mixy: false }), [
    'agent-profile',
    'agent-rename',
    'agent-turn-off',
    'agent-delete',
  ]);
  assert.deepEqual(ids({ agentId: 'lead', name: 'Mixy', mixy: true }), ['agent-profile', 'agent-rename']);
  const opened = [];
  const [profile] = agentContactMenuItems(
    { agentId: 'lead', name: 'Mixy', mixy: true },
    {
      onOpen() {},
      onProfile: (contact) => opened.push(contact.agentId),
    }
  );
  profile.onSelect();
  assert.deepEqual(opened, ['lead']);
});

test('the dock panel switches 프로필 · 루틴, remembers the tab, and "프로필 보기" brings 프로필 back', async (t) => {
  const render = harness(t);
  const { api } = fakeApi(WATCHER);
  setAgentPanelTab('profile');
  await render(React.createElement(AgentPanel, { sessionId: 'sess_home_github-watcher', active: true, api }));
  await settle();
  const tabs = () => [...document.querySelectorAll('.agent-panel-tabs > [role="tab"]')];
  assert.deepEqual(
    tabs().map((tab) => tab.textContent),
    ['Profile', 'Routines']
  );
  assert.ok(document.querySelector('.agent-profile'));
  await act(async () => tabs()[1].click());
  await settle();
  const view = (selector) => document.querySelector(selector).closest('.agent-panel-view');
  assert.ok(view('.agent-profile').hidden, 'the profile stays mounted, hidden');
  assert.equal(view('.routines-pane').hidden, false);
  assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
  assert.equal(agentPanelTab(), 'routines', 'the last-used tab is kept for the dock toggle');
  assert.equal(dom.window.localStorage.getItem('mixdog.desktop.agent-panel-tab.v1'), 'routines');

  const requests = [];
  const listen = (event) => requests.push(event.detail.sessionId);
  dom.window.addEventListener(OPEN_AGENT_PANEL_EVENT, listen);
  t.after(() => dom.window.removeEventListener(OPEN_AGENT_PANEL_EVENT, listen));
  await act(async () => openAgentProfile('sess_home_github-watcher'));
  await settle();
  assert.deepEqual(requests, ['sess_home_github-watcher'], 'the pane surfaces open that thread’s panel');
  assert.equal(view('.agent-profile').hidden, false, 'on 프로필');
  assert.ok(view('.routines-pane').hidden);
});

test('the bot profile model picker names a custom provider by its setup name, like the composer picker', async (t) => {
  const render = harness(t);
  const providerId = 'custom-a367f0c2-1111-4222-8333-944455556666';
  const custom = { provider: providerId, model: 'fake-1', display: 'fake-1', effortOptions: [] };
  const { api: base } = fakeApi({ ...WATCHER, route: { provider: providerId, model: 'fake-1' } });
  const api = {
    ...base,
    listProviderModels: async () => [custom],
    invokeCapability: async (request) =>
      request.capability === 'getProviderSetup'
        ? { value: { api: [{ id: providerId, name: 'Fake', custom: true, auth: 'none', enabled: true }] } }
        : base.invokeCapability(request),
  };
  await render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api }));
  await settle();
  await settle();
  await act(async () => document.querySelector('.agent-profile .model-trigger').click());
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
  await act(async () => document.querySelector('.route-sheet .route-sheet-row').click());
  const catalog = document.querySelector('.route-sheet[data-drilled]').textContent;
  assert.match(catalog, /fake-1/, 'the catalog lists the custom model');
  assert.match(catalog, /Fake/);
  assert.doesNotMatch(catalog, /custom-a367/, 'never the generated provider id');
});

test('the profile model row opens the shared picker as a dropdown under its chip; the pick lands in that entry', async (t) => {
  const render = harness(t);
  const tuned = models.map((entry) => ({
    ...entry,
    effortOptions: ['low', 'high'].map((value) => ({ value, label: value })),
  }));
  const { api, calls } = fakeApi(WATCHER);
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models: tuned })
  );
  await settle();
  const chip = document.querySelector('.agent-profile .route-chain-row .model-trigger');
  const rect = { left: 600, right: 860, top: 300, bottom: 332, width: 260, height: 32, x: 600, y: 300 };
  chip.getBoundingClientRect = () => rect;
  const open = async () => {
    if (chip.getAttribute('aria-expanded') !== 'true') await act(async () => chip.click());
    await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
    return document.querySelector('.route-sheet');
  };
  const sheetRow = (label) =>
    [...document.querySelectorAll('.route-sheet .route-sheet-row')].find((node) => node.textContent.startsWith(label));
  const assertUnderChip = (sheet) => {
    assert.ok(sheet.hasAttribute('data-dropdown'), 'the composer picker in its dropdown layout');
    assert.equal(sheet.dataset.placement, 'below');
    assert.equal(parseFloat(sheet.style.left), rect.left, 'left edge on the chip');
    assert.equal(parseFloat(sheet.style.width), rect.width, 'the chip row width');
    assert.ok(parseFloat(sheet.style.top) >= rect.bottom, 'directly under the chip');
  };

  let sheet = await open();
  assertUnderChip(sheet);
  assert.equal(chip.style.width, '', 'the chip keeps its width (no pill morph)');
  await act(async () => sheetRow('Model').click());
  sheet = document.querySelector('.route-sheet');
  assert.ok(sheet.hasAttribute('data-drilled'), 'the catalog opens inside the same box');
  assertUnderChip(sheet);
  assert.equal(document.querySelector('.route-sheet-flyout'), null, 'no flyout beside it');
  assert.ok(sheet.querySelector('input'), 'the shared catalog with its search field');
  const second = [...sheet.querySelectorAll('button')].find((node) => node.textContent.includes('Second model'));
  await act(async () => second.click());

  sheet = await open();
  await act(async () => sheetRow('Reasoning effort').click());
  sheet = document.querySelector('.route-sheet');
  assertUnderChip(sheet);
  const high = [...sheet.querySelectorAll('[role="menuitemradio"]')].find((node) => node.textContent === 'high');
  await act(async () => high.click());

  await act(async () =>
    document
      .querySelector('.agent-profile-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  const save = calls.find(([capability]) => capability === 'saveAgentDefinition');
  assert.equal(save[1].route.provider, 'anthropic');
  assert.equal(save[1].route.model, 'second-model');
  assert.equal(save[1].route.effort, 'high');
});

test('a bot profile shows and saves its fallback models; a route without any stays untouched', async (t) => {
  const render = harness(t);
  const second = { provider: 'anthropic', model: 'second-model' };
  const { api, calls } = fakeApi({ ...WATCHER, route: { ...WATCHER.route, fallbacks: [second] } });
  await render(
    React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api, models })
  );
  await settle();
  assert.equal(document.querySelectorAll('.agent-profile .route-chain-row').length, 2);
  assert.ok(document.querySelector('.agent-profile [aria-label="Add fallback model"]'));
  assert.equal(document.querySelector('.agent-profile-footer'), null, 'loading the chain is not a change');
  await act(async () => document.querySelector('.agent-profile [aria-label="Remove model 2"]').click());
  await act(async () =>
    document
      .querySelector('.agent-profile-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  await settle();
  const save = calls.find(([capability]) => capability === 'saveAgentDefinition');
  assert.deepEqual(save[1].route.fallbacks, [], 'an emptied chain is saved explicitly');
  const thread = calls.find(([name]) => name === 'setModelRoute');
  assert.equal(thread[2], 'sess_home_github-watcher', 'the open thread follows from its next turn');
});
