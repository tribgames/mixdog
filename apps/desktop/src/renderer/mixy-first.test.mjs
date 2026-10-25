// "대표 에이전트 먼저": a profile without Mixy sees an empty Agents pane, the
// new-agent dialog opens in 대표 에이전트 mode — never behind another dialog —
// with the name "Mixy" and Mixy's pup prefilled but editable (and "+" opens it
// until Mixy exists); creating it writes agents/lead/ (name, face, persona,
// AGENT.md), the Main route and the created flag, then it greets once with
// the welcome guide. Every surface uses the name the user chose.
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const { AgentActivityPane } = await import('./AgentActivityPane.tsx');
const { resetMixyStatus } = await import('./mixy-identity.ts');

const AGENTS = [{ id: 'maintainer', label: 'Maintainer', locked: true }];
const MODELS = [{ provider: 'openai', model: 'test-model', display: 'Test model', effortOptions: [] }];

async function settle() {
  await act(async () => {
    // setImmediate, not setTimeout: this must also flush while timers are faked.
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  });
}

/** Fake timers installed BEFORE the pane renders, so any delayed auto-open the
 *  product schedules lands on this clock. `advance` moves it inside act();
 *  `release` restores real timers before a step that waits on them. */
function fakeTimers(t) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  return {
    advance: (ms) =>
      act(async () => {
        mock.timers.tick(ms);
      }),
    release: () => mock.timers.reset(),
  };
}

const PAST_ANY_AUTO_OPEN_MS = 5_000;

/** The dialog is lazy: its first import takes longer than a few ticks. */
async function waitFor(find) {
  for (let index = 0; index < 200; index += 1) {
    const found = find();
    if (found) return found;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  return null;
}

function mount(t, { created, name = '' }) {
  resetMixyStatus();
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: [
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'Element',
      'Node',
      'Event',
      'KeyboardEvent',
      'MouseEvent',
      'navigator',
    ],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const calls = [];
  let mixyCreated = created;
  let lead = { name, avatar: null };
  const status = () => ({ value: { created: mixyCreated, ...lead } });
  dom.window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
    listProviderModels: async () => MODELS,
    listProjects: async () => [{ path: 'C:/work' }, { path: 'C:/docs' }],
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, ...(args ?? [])]);
      if (capability === 'getLeadStatus') return status();
      if (capability === 'saveLeadIdentity') {
        lead = { name: args[0].name ?? lead.name, avatar: args[0].avatar ?? lead.avatar };
        return status();
      }
      if (capability === 'setLeadCreated') {
        mixyCreated = args[0];
        return status();
      }
      if (capability === 'listAgents') return { value: AGENTS };
      return { value: null };
    },
    setModelRoute: async (route) => {
      calls.push(['setModelRoute', route]);
    },
    openAgentHome: async (agentId) => {
      calls.push(['openAgentHome', agentId]);
      return { sessionId: `sess_home_${agentId}` };
    },
    submitToSession: async (sessionId, prompt, options) => {
      calls.push(['submit', sessionId, prompt, options]);
      return true;
    },
  };
  const opened = [];
  const render = async () => {
    await act(async () =>
      root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [],
          // The page focus a caller once handed over (a coding session in use,
          // no home tab): showing the pane must never act on it.
          agentsPageFocus: {
            focused: { kind: 'session', id: 'work-1' },
            focusedTabCount: 1,
            openSessionIds: ['work-1'],
          },
          readComposerModel: () => ({ provider: 'openai', model: 'test-model' }),
          onOpenSession: (id, title) => opened.push([id, title]),
        })
      )
    );
    await settle();
  };
  const document = dom.window.document;
  const type = async (input, value) => {
    const proto =
      input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, value);
    await act(async () => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  };
  const submit = async () => {
    await act(async () =>
      document
        .querySelector('.agent-create-dialog form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle();
  };
  return { document, calls, opened, render, type, submit };
}

const dialog = (document) => document.querySelector('.agent-create-dialog');
const plus = (document) =>
  document.querySelector(
    '.agent-group-toolbar button[aria-label="Create representative bot"], .agent-group-toolbar button[aria-label="New bot or group room"]'
  );
const menuLabels = (document) =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim());

/** The dialog never opens by itself: open it from the empty-state button. */
async function openFromEmptyState(document) {
  await act(async () => document.querySelector('.mixy-empty button').click());
  return waitFor(() => dialog(document));
}

test('no Mixy: the pane is empty, the dialog does not auto-open, and on request it opens with "Mixy" and its pup prefilled, both editable', async (t) => {
  const { document, calls, render } = mount(t, { created: false });
  const clock = fakeTimers(t);
  await render();
  assert.equal(document.querySelector('[data-agent-contact="lead"]'), null, 'no Mixy row');
  assert.match(document.querySelector('.mixy-empty').textContent, /No bots\./);
  await clock.advance(PAST_ANY_AUTO_OPEN_MS);
  await settle();
  assert.equal(dialog(document), null, 'the dialog does not open on its own');
  clock.release();
  const shown = await openFromEmptyState(document);
  assert.ok(shown, 'the dialog opened on request');
  assert.equal(shown.querySelector('h2').textContent, 'Create representative bot');
  const name = shown.querySelector('.agent-create-name');
  assert.equal(name.value, 'Mixy');
  assert.equal(name.disabled, false, 'the name is editable');
  assert.ok(shown.querySelector('.agent-create-segments'), 'the face is editable');
  assert.equal(shown.querySelector('.agent-create-preview').dataset.look, 'mixy-none-calm', "Mixy's own look");
  assert.ok(shown.querySelector('.mixy-create-face .agent-contact-badge'), 'the face carries the star');
  assert.doesNotMatch(shown.textContent, /fixed/);
  assert.equal(shown.querySelector('input[name="agent-description"]').value, 'Primary assistant');
  assert.equal(
    calls.some(([call]) => call === 'openAgentHome'),
    false,
    'nothing opens (or creates) its thread before it exists'
  );
});

test('the dialog does not auto-open behind another dialog, nor after it closes', async (t) => {
  const { document, render } = mount(t, { created: false });
  const clock = fakeTimers(t);
  const onboarding = document.createElement('section');
  onboarding.setAttribute('role', 'dialog');
  onboarding.setAttribute('aria-modal', 'true');
  document.body.append(onboarding);
  await render();
  await clock.advance(PAST_ANY_AUTO_OPEN_MS);
  await settle();
  assert.equal(dialog(document), null);
  onboarding.remove();
  await clock.advance(PAST_ANY_AUTO_OPEN_MS);
  await settle();
  assert.equal(dialog(document), null, 'closing the other dialog does not open it');
});

test('closing leaves one 대표 에이전트 action; it and "+" both reopen the dialog', async (t) => {
  const { document, render } = mount(t, { created: false });
  await render();
  assert.ok(await openFromEmptyState(document));
  await act(async () => dialog(document).querySelector('button[aria-label="Close"]').click());
  await settle();
  assert.equal(dialog(document), null);
  const actions = document.querySelectorAll('.mixy-empty button');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].textContent, 'Create representative bot');
  await act(async () => actions[0].click());
  await settle();
  assert.equal(dialog(document).querySelector('h2').textContent, 'Create representative bot');
  await act(async () => dialog(document).querySelector('button[aria-label="Close"]').click());
  await settle();
  // "+" opens the same mode directly: no 새 에이전트 / 새 대화방 menu.
  assert.equal(plus(document).getAttribute('aria-label'), 'Create representative bot');
  await act(async () => plus(document).click());
  await settle();
  assert.deepEqual(menuLabels(document), []);
  assert.equal(dialog(document).querySelector('h2').textContent, 'Create representative bot');
});

test('creating a renamed representative saves its name and face, then it greets once with the welcome guide', async (t) => {
  const { document, calls, opened, render, type, submit } = mount(t, { created: false });
  await render();
  assert.ok(await openFromEmptyState(document));
  await type(dialog(document).querySelector('.agent-create-name'), 'Navi');
  await act(async () => dialog(document).querySelector('[data-color="#5b9bff"]').click());
  await type(dialog(document).querySelector('textarea[aria-label="PERSONA.md"]'), '존댓말로 짧게');
  await type(dialog(document).querySelector('textarea[aria-label="AGENT.md"]'), '# Navi\n\nHelp first.');
  await submit();
  const saves = calls
    .filter(([call]) =>
      [
        'saveLeadIdentity',
        'saveLeadPersona',
        'saveLeadAgentBody',
        'setModelRoute',
        'setAgentRoute',
        'setLeadCreated',
      ].includes(call)
    )
    .map((call) => call.slice(0, 3));
  assert.deepEqual(saves, [
    [
      'saveLeadIdentity',
      {
        name: 'Navi',
        // A colour picked on Mixy's own look stays on it.
        avatar: { kind: 'mascot', species: 'mixy', accessory: 'none', expression: 'calm', color: '#5b9bff' },
      },
    ],
    ['saveLeadPersona', '존댓말로 짧게'],
    ['saveLeadAgentBody', '# Navi\n\nHelp first.'],
    // Mixy's own model: the Lead's Main route is never set.
    ['setAgentRoute', 'lead', { provider: 'openai', model: 'test-model' }],
    ['setLeadCreated', true, 'Primary assistant'],
  ]);
  assert.equal(
    calls.some(([call]) => call === 'saveAgentDefinition'),
    false,
    'the representative is not a custom agent'
  );
  const greetings = calls.filter(([call]) => call === 'submit');
  assert.equal(greetings.length, 1);
  const [, sessionId, kickoff, options] = greetings[0];
  assert.equal(sessionId, 'sess_home_lead');
  assert.deepEqual(options, { kickoff: true });
  assert.match(kickoff, /^\[mixdog-runtime\] The user just created you as their primary agent named "Navi"/);
  assert.match(kickoff, /Mixdog에 오신 걸 환영합니다/);
  assert.match(kickoff, /하나씩 안내하겠습니다/);
  assert.match(kickoff, /setup-guide skill/);
  assert.match(kickoff, /필수 기능인데 설치할까요\?/);
  // The facts block: what is already set up, so the guide skips it.
  assert.match(kickoff, /Setup state \(facts from the app\):\n- Model provider: not connected\n- Projects added: 2\n/);
  assert.match(kickoff, /- Other agents: 0/);
  assert.doesNotMatch(kickoff, /mixdog:suggestions/);
  assert.ok(
    opened.some(([id, title]) => id === 'sess_home_lead' && title === 'Navi'),
    'the thread opens as Navi'
  );
  assert.equal(dialog(document), null);
  // The list shows the chosen name and face, with the star.
  const row = await waitFor(() => document.querySelector('[data-agent-contact="lead"]'));
  assert.equal(row.querySelector('.agent-chat-title').textContent, 'Navi');
  assert.ok(row.querySelector('.agent-contact-badge'));
  // Reopening the pane does not greet again.
  await render();
  await render();
  assert.equal(calls.filter(([call]) => call === 'submit').length, 1);
  assert.equal(plus(document).getAttribute('aria-label'), 'New bot or group room');
  await act(async () => plus(document).click());
  await settle();
  assert.deepEqual(menuLabels(document), ['New bot', 'New group room']);
});

test('a profile with a renamed representative never sees the empty state and lists it by its name', async (t) => {
  const { document, render } = mount(t, { created: true, name: 'Momo' });
  await render();
  assert.equal(document.querySelector('.mixy-empty'), null);
  assert.equal(dialog(document), null);
  const row = await waitFor(() => document.querySelector('[data-agent-contact="lead"] .agent-chat-title'));
  assert.equal(row.textContent, 'Momo');
  await act(async () => plus(document).click());
  await settle();
  assert.deepEqual(menuLabels(document), ['New bot', 'New group room']);
});

test('showing the Bots page opens no tab: with Mixy created, only a row click opens its thread', async (t) => {
  // User: going from Sessions to Bots jumped the main area to a bot chat.
  const { document, calls, opened, render } = mount(t, { created: true, name: 'Momo' });
  const clock = fakeTimers(t);
  await render();
  await render();
  await clock.advance(PAST_ANY_AUTO_OPEN_MS);
  await settle();
  assert.deepEqual(opened, [], 'no tab opened or activated by showing the page');
  assert.equal(
    calls.some(([call]) => call === 'openAgentHome'),
    false
  );
  clock.release();
  const row = await waitFor(() => document.querySelector('[data-agent-contact="lead"]'));
  await act(async () => row.querySelector('button, [role="button"]').click());
  await settle();
  assert.deepEqual(opened, [['sess_home_lead', 'Momo']], 'a row click opens it');
});
