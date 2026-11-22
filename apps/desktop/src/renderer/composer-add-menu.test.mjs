import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'navigator', 'MutationObserver'],
  actEnvironment: false,
});
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 10,
  y: 500,
  top: 500,
  left: 10,
  right: 610,
  bottom: 600,
  width: 600,
  height: 100,
});
const { default: React, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerAddMenu } = await import('./ComposerAddMenu.tsx');
const { agentAvatar } = await import('../shared/core-src/runtime/shared/agent-avatar.mjs');

async function mountSkillMenu() {
  const selected = [];
  const goals = [];
  const attached = { count: 0 };
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      assert.deepEqual(request, { capability: 'skillsStatus', sessionId: 'menu-session', args: [{ scoped: true }] });
      return {
        value: {
          skills: [
            { name: 'pdf', state: 'inUse' },
            { name: 'off', state: 'off' },
            { name: 'elsewhere', state: 'inUse', scope: ['C:/other'], activeHere: false },
            { name: 'plugin-elsewhere', state: 'inUse', inheritedScope: ['C:/other'], activeHere: false },
          ],
        },
      };
    },
  };
  function Harness() {
    const anchor = useRef(null);
    return React.createElement(
      'form',
      { ref: anchor },
      React.createElement(ComposerAddMenu, {
        anchor,
        disabled: false,
        goalDisabled: false,
        sessionId: 'menu-session',
        projectPath: 'C:/project',
        onAttach: () => {
          attached.count += 1;
        },
        onSkill: (name) => selected.push(name),
        onGoal: async (command) => {
          goals.push(command);
          return false;
        },
        onMore() {},
      })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (node) => act(async () => node.click());
  await act(async () => root.render(React.createElement(Harness)));
  const trigger = host.querySelector('button');
  const items = () => [...document.querySelectorAll('[role="menuitem"]')];
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { selected, goals, attached, click, trigger, items, close };
}

test('add menu lists only the skills in scope here', async () => {
  const { goals, click, trigger, items, close } = await mountSkillMenu();
  try {
    await click(trigger);
    assert.equal(items().length, 4);
    for (const name of ['elsewhere', 'plugin-elsewhere']) {
      assert.ok(!items().some((node) => node.textContent === name), `${name} is out of scope here`);
    }
    assert.equal(goals.length, 0);
  } finally {
    await close();
  }
});

test('add menu selects a skill without submitting and closes', async () => {
  const { selected, click, trigger, items, close } = await mountSkillMenu();
  try {
    await click(trigger);
    const pdf = items().find((node) => node.textContent === 'PDF');
    assert.ok(pdf.querySelector('svg'));
    await click(pdf);
    assert.deepEqual(selected, ['pdf']);
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await close();
  }
});

test('add menu attaches files from its first item', async () => {
  const { attached, click, trigger, items, close } = await mountSkillMenu();
  try {
    await click(trigger);
    await click(items()[0]);
    assert.equal(attached.count, 1);
  } finally {
    await close();
  }
});

test('add menu closes on Escape', async () => {
  const { click, trigger, close } = await mountSkillMenu();
  try {
    await click(trigger);
    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally {
    await close();
  }
});

test('add menu hands the /goal command over and closes without opening a dialog', async () => {
  const { goals, click, trigger, items, close } = await mountSkillMenu();
  try {
    await click(trigger);
    await click(items()[1]);
    assert.deepEqual(goals, ['/goal']);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await close();
  }
});

test("a group room's add menu attaches files and calls a member", async () => {
  window.mixdogDesktop = { invokeCapability: async () => ({ value: { skills: [] } }) };
  let attached = 0;
  const asked = [];
  function Harness() {
    const anchor = useRef(null);
    return React.createElement(
      'form',
      { ref: anchor },
      React.createElement(ComposerAddMenu, {
        anchor,
        disabled: false,
        goalDisabled: false,
        sessionId: 'sess_room_abc123',
        simple: true,
        roomMembers: [{ id: 'gh', name: 'GitHub', avatar: agentAvatar('gh', null) }],
        onAskMember: (id) => asked.push(id),
        onAttach: () => {
          attached += 1;
        },
        onSkill() {},
        onGoal: async () => false,
        onMore() {},
      })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (node) => act(async () => node.click());
  const item = (name) =>
    [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes(name));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const trigger = host.querySelector('button');
    await click(trigger);
    assert.ok(item('Call a bot'));
    await click(item('Attach files'));
    assert.equal(attached, 1);
    await click(trigger);
    await click(item('Call a bot'));
    await click(item('GitHub'));
    assert.deepEqual(asked, ['gh']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a new-task draft's add menu lists the skills its selected Project sees", async () => {
  const reads = [];
  window.mixdogDesktop = {
    readCapabilities: async (requests) => {
      reads.push(requests);
      return [
        {
          ok: true,
          value: {
            skills: [
              { name: 'team-only', state: 'inUse', scope: ['C:/project'], activeHere: true },
              { name: 'elsewhere', state: 'inUse', scope: ['C:/other'], activeHere: false },
            ],
          },
        },
      ];
    },
  };
  function Harness() {
    const anchor = useRef(null);
    return React.createElement(
      'form',
      { ref: anchor },
      React.createElement(ComposerAddMenu, {
        anchor,
        disabled: false,
        goalDisabled: false,
        sessionId: '',
        projectPath: 'C:/project',
        onAttach() {},
        onSkill() {},
        onGoal: async () => false,
        onMore() {},
      })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => host.querySelector('button').click());
    assert.deepEqual(reads, [[{ capability: 'skillsStatus', args: [{ projectPath: 'C:/project' }] }]]);
    const names = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
    assert.ok(names.includes('team-only'));
    assert.ok(!names.includes('elsewhere'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
