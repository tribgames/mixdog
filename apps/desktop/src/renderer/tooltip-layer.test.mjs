import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Element', 'Node'],
});
const { TooltipLayer } = await import('./TooltipLayer.tsx');

// The layer schedules through window.setTimeout/setInterval; route those to
// node's mock timers so the hover delays advance by tick() instead of real waits.
dom.window.setTimeout = (...args) => globalThis.setTimeout(...args);
dom.window.clearTimeout = (...args) => globalThis.clearTimeout(...args);
dom.window.setInterval = (...args) => globalThis.setInterval(...args);
dom.window.clearInterval = (...args) => globalThis.clearInterval(...args);
const wait = (ms) => mock.timers.tick(ms);

async function mount(html, t) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const host = document.createElement('main');
  host.innerHTML = html;
  document.body.append(host);
  const layer = document.createElement('div');
  document.body.append(layer);
  const root = createRoot(layer);
  await act(async () => root.render(React.createElement(TooltipLayer)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    layer.remove();
  });
  return host;
}

async function hover(target) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
    target.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    wait(620);
  });
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

function key(type, name, init = {}) {
  document.dispatchEvent(new window.KeyboardEvent(type, { key: name, bubbles: true, ...init }));
}

async function leave(target) {
  await act(async () => target.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true })));
}

test('icon-only buttons and links receive hover hints from their accessible name without per-screen wiring', async (t) => {
  const host = await mount(
    `
    <button aria-label="Close panel"><svg><path d="M0 0h1"/></svg></button>
    <a href="#settings" aria-label="Settings"><svg><path d="M0 0h1"/></svg></a>
    <div role="button" aria-label="Open panel"></div>
  `,
    t
  );
  for (const control of host.children) {
    const target = control.querySelector('path') || control;
    assert.equal(await hover(target), control.getAttribute('aria-label'));
    await leave(target);
  }
});

test('controls that already show text, form fields and other labelled widgets stay silent unless a screen opts in', async (t) => {
  const host = await mount(
    `
    <button aria-label="Edit mixdog"><b>mixdog</b><small>C:/Project/sample</small></button>
    <a href="#settings" aria-label="Settings">Settings</a>
    <div role="button" aria-label="Open panel">Panel</div>
    <input aria-label="Search files">
    <textarea aria-label="Message"></textarea>
    <select aria-label="Project"><option>mixdog</option></select>
    <div role="combobox" aria-label="Workflow"></div>
    <div role="switch" aria-label="Notifications"></div>
    <div role="tab" aria-label="Terminal">Terminal</div>
    <div role="checkbox" aria-label="Stage file"></div>
    <div role="radio" aria-label="Weekly"></div>
    <div role="slider" aria-label="Volume"></div>
  `,
    t
  );
  for (const control of host.children) {
    const target = control.querySelector('b') || control;
    assert.equal(await hover(target), null, control.outerHTML);
    await leave(target);
  }
  const tab = host.querySelector('[role="tab"]');
  tab.dataset.tooltip = 'Terminal pane';
  assert.equal(await hover(tab), 'Terminal pane');
});

test('explicit short copy takes precedence, including over nested SVG icons and labelled controls', async (t) => {
  const host = await mount(
    `
    <span data-tooltip="Maximum delegation">
      <button aria-label="Assign independent work to all available agents">
        <svg aria-hidden="true"><path d="M0 0h1"/></svg>
      </button>
    </span>
  `,
    t
  );
  assert.equal(await hover(host.querySelector('path')), 'Maximum delegation');
});

test('empty hints, native titles, non-controls and inactive surfaces do not acquire duplicate tooltips', async (t) => {
  const host = await mount(
    `
    <button data-tooltip="" aria-label="Suppressed"></button>
    <button title="Native hint" aria-label="Native"></button>
    <label title="Native setting help"><input aria-label="Setting"></label>
    <section aria-label="Sidebar"></section>
    <div role="listbox" aria-label="Options"></div>
    <div inert><button aria-label="Inactive"></button></div>
    <div aria-hidden="true"><button aria-label="Closing tab"></button></div>
    <input type="hidden" aria-label="Stored value">
  `,
    t
  );
  for (const target of host.querySelectorAll('[aria-label]')) {
    assert.equal(await hover(target), null, target.outerHTML);
    await leave(target);
  }
});

test('keyboard focus shows help and Escape or activation dismisses it', async (t) => {
  const host = await mount('<button aria-label="Open settings"><svg><path d="M0 0h1"/></svg></button>', t);
  const button = host.firstElementChild;
  await act(async () => {
    key('keydown', 'Tab');
    button.focus();
    key('keyup', 'Tab');
    wait(170);
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Open settings');
  await act(async () => button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  assert.equal(await hover(button), 'Open settings');
  await act(async () => button.click());
  assert.equal(document.querySelector('[role="tooltip"]'), null);
});

test('a control that slides under a resting pointer stays silent until the pointer moves', async (t) => {
  // Streaming rows, scrolls and click re-renders move content under a still
  // pointer: the browser fires pointerover, but no pointermove.
  const host = await mount('<button aria-label="Copy message"><svg><path d="M0 0h1"/></svg></button>', t);
  const button = host.firstElementChild;
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
    wait(620);
  });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
    wait(620);
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Copy message');
});

test('focus that script moves shows no help: a re-activated window, a trigger regaining focus, a shortcut', async (t) => {
  const host = await mount(
    `
    <button aria-label="Open settings"><svg><path d="M0 0h1"/></svg></button>
    <button aria-label="Model menu"><svg><path d="M0 0h1"/></svg></button>
    <button aria-label="Sessions"><svg><path d="M0 0h1"/></svg></button>
  `,
    t
  );
  const [plain, trigger, shortcut] = host.children;
  const settle = () => wait(170);
  await act(async () => {
    plain.focus();
    await settle();
  });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  await act(async () => {
    key('keydown', 'Escape');
    trigger.focus();
    key('keyup', 'Escape');
    await settle();
  });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  await act(async () => {
    key('keydown', 'Tab', { ctrlKey: true });
    shortcut.focus();
    key('keyup', 'Tab', { ctrlKey: true });
    await settle();
  });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
});

test('shortcuts stay readable and technical content is never automatically truncated', async (t) => {
  const host = await mount('<button data-tooltip="Send · Ctrl+Enter"></button><span></span>', t);
  const button = host.firstElementChild;
  await hover(button);
  assert.equal(document.querySelector('.mx-tooltip-label').textContent, 'Send');
  assert.deepEqual(
    [...document.querySelectorAll('kbd')].map((key) => key.textContent),
    ['Ctrl', 'Enter']
  );
  await leave(button);
  const details = 'Permission denied: C:/Project/a-long-project-name/src/a-long-module-name/important-file.ts';
  host.lastElementChild.dataset.tooltip = details;
  assert.equal(await hover(host.lastElementChild), details);
});
