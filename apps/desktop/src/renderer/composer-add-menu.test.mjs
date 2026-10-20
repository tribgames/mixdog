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
const { agentAvatar } = await import('../../../../src/runtime/shared/agent-avatar.mjs');

test('add menu selects without submitting, supports keyboard dismissal, and starts a goal only on confirmation', async () => {
  const selected = [];
  const goals = [];
  const acceptGoal = false;
  let attached = 0;
  window.mixdogDesktop = {
    // The session answers for its own project, so scope is decided there (a
    // session ignores the draft-only projectPath).
    invokeCapability: async (request) => {
      assert.deepEqual(request, { capability: 'skillsStatus', sessionId: 'menu-session' });
      return {
        value: {
          skills: [
            { name: 'pdf', enabled: true },
            { name: 'off', enabled: false },
            { name: 'elsewhere', enabled: true, scope: ['C:/other'], activeHere: false },
            { name: 'plugin-elsewhere', enabled: true, inheritedScope: ['C:/other'], activeHere: false },
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
          attached += 1;
        },
        onSkill: (name) => selected.push(name),
        onGoal: async (command) => {
          goals.push(command);
          return acceptGoal;
        },
        onMore() {},
      })
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (node) => act(async () => node.click());
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const trigger = host.querySelector('button');
    await click(trigger);
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 4);
    for (const name of ['elsewhere', 'plugin-elsewhere']) {
      assert.ok(
        ![...document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent === name),
        `${name} is out of scope here`
      );
    }
    assert.equal(goals.length, 0);
    const pdf = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === 'PDF');
    assert.ok(pdf.querySelector('svg'));
    await click(pdf);
    assert.deepEqual(selected, ['pdf']);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await click(trigger);
    await click(document.querySelector('[role="menuitem"]'));
    assert.equal(attached, 1);
    await click(trigger);
    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    await click(document.querySelectorAll('[role="menuitem"]')[1]);
    // The goal dialog is pane-scoped and lives in the composer
    // (composer-goal-dialog.slow.test.mjs); the menu only hands over the
    // /goal command and closes.
    assert.deepEqual(goals, ['/goal']);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
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
              { name: 'team-only', enabled: true, scope: ['C:/project'], activeHere: true },
              { name: 'elsewhere', enabled: true, scope: ['C:/other'], activeHere: false },
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
