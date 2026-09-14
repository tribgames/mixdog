import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 10, y: 500, top: 500, left: 10, right: 610, bottom: 600, width: 600, height: 100,
});
const { default: React, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerAddMenu } = await import('./ComposerAddMenu.tsx');

test('add menu selects without submitting, supports keyboard dismissal, and starts a goal only on confirmation', async () => {
  const selected = [];
  const goals = [];
  let acceptGoal = false;
  let attached = 0;
  window.mixdogDesktop = {
    readCapabilities: async requests => {
      assert.equal(requests[0].sessionId, 'menu-session');
      return [{ ok: true, value: { skills: [{ name: 'pdf', enabled: true }, { name: 'off', enabled: false }] } }];
    },
  };
  function Harness() {
    const anchor = useRef(null);
    return React.createElement('form', { ref: anchor },
      React.createElement(ComposerAddMenu, {
        anchor, disabled: false, goalDisabled: false, sessionId: 'menu-session',
        onAttach: () => { attached += 1; }, onSkill: name => selected.push(name),
        onGoal: async command => { goals.push(command); return acceptGoal; }, onMore() {},
      }));
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const click = async node => act(async () => node.click());
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const trigger = host.querySelector('button');
    await click(trigger);
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 4);
    assert.equal(goals.length, 0);
    const pdf = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'PDF');
    assert.ok(pdf.querySelector('svg'));
    await click(pdf);
    assert.deepEqual(selected, ['pdf']);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await click(trigger);
    await click(document.querySelector('[role="menuitem"]'));
    assert.equal(attached, 1);
    await click(trigger);
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
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
