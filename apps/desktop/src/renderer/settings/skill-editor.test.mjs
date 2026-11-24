import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'FormData'],
  actEnvironment: false,
});
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
const { createRoot } = await import('react-dom/client');
const { SkillEditorDialog } = await import('./skill-editor.tsx');

test('a packaged skill can disconnect tools and restore declarations without editing instructions', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const saves = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(SkillEditorDialog, {
          skill: {
            key: 'plugin:office:pptx',
            name: 'pptx',
            description: 'Deck guide',
            toolDependencies: [{ type: 'tool', value: 'media' }],
            declaredToolDependencies: [{ type: 'tool', value: 'office' }],
          },
          instructions: '# Packaged instructions',
          disabled: false,
          busy: false,
          readOnly: true,
          onClose() {},
          onSave: (payload) => saves.push(payload),
        })
      )
    );
    assert.equal(document.querySelector('[name="skill-instructions"]').disabled, true);
    const remove = document.querySelector('.extensions-mcp-list-row button');
    await act(async () => remove.click());
    await act(async () =>
      document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    assert.deepEqual(saves.at(-1), {
      originalName: 'plugin:office:pptx',
      dependenciesOnly: true,
      toolDependencies: [],
    });
    const restore = [...document.querySelectorAll('button')].find((button) =>
      /Restore declared tools/.test(button.textContent)
    );
    await act(async () => restore.click());
    assert.equal(document.querySelector('.extensions-mcp-list-row input').value, 'office');
    await act(async () =>
      document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    assert.deepEqual(saves.at(-1), {
      originalName: 'plugin:office:pptx',
      dependenciesOnly: true,
      toolDependencies: null,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

async function mountToolEditor(t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const saves = [];
  const closed = { count: 0 };
  const tools = Array.from({ length: 80 }, (_, index) => ({
    name: `tool-${index}`,
    description: index === 63 ? 'Offline document processing' : 'General tool',
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1640 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 955 });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });
  await act(async () =>
    root.render(
      React.createElement(SkillEditorDialog, {
        skill: { name: 'test-skill', toolDependencies: [{ type: 'tool', value: 'tool-63' }] },
        instructions: '# Instructions',
        disabled: false,
        busy: false,
        readOnly: true,
        tools,
        onClose() {
          closed.count++;
        },
        onSave: (payload) => saves.push(payload),
      })
    )
  );
  const input = document.querySelector('input[role="combobox"]');
  const place = (rect) => {
    input.getBoundingClientRect = () => rect;
  };
  place({ left: 800, right: 1152, top: 603, bottom: 635, width: 352, height: 32 });
  const key = async (name) =>
    act(async () =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    );
  const type = async (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const submit = async () =>
    act(async () =>
      document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
  await act(async () => input.focus());
  return { input, saves, closed, place, key, type, submit };
}

const assertMenuContained = (left, top, width, height) => {
  const menu = document.querySelector('[role="listbox"]');
  const menuWidth = Number.parseFloat(menu.style.width);
  const menuHeight = Number.parseFloat(menu.style.maxHeight);
  const menuLeft = Number.parseFloat(menu.style.left);
  const menuTop = menu.style.top
    ? Number.parseFloat(menu.style.top)
    : window.innerHeight - Number.parseFloat(menu.style.bottom) - menuHeight;
  assert.ok(menuLeft >= left + 8);
  assert.ok(menuLeft + menuWidth <= left + width - 8);
  assert.ok(menuTop >= top + 8);
  assert.ok(menuTop + menuHeight <= top + height - 8);
  assert.ok(menuHeight <= 240);
  assert.equal(menu.style.overflowY, 'auto');
};

test('tool suggestions open with every tool and stay inside the window after a resize', async (t) => {
  const { input, place } = await mountToolEditor(t);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelectorAll('[role="option"]').length, 80);
  assertMenuContained(0, 0, 1640, 955);
  place({ left: 1510, right: 1862, top: 900, bottom: 932, width: 352, height: 32 });
  await act(async () => window.dispatchEvent(new window.Event('resize')));
  assertMenuContained(0, 0, 1640, 955);
});

test('tool suggestions stay inside the visual viewport and follow its resize', async (t) => {
  const { place, key } = await mountToolEditor(t);
  const viewport = new window.EventTarget();
  Object.assign(viewport, { width: 420, height: 300, offsetLeft: 100, offsetTop: 200 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  place({ left: 380, right: 732, top: 450, bottom: 482, width: 352, height: 32 });
  // Reopening attaches listeners to the newly supplied visual viewport.
  await key('Escape');
  await key('ArrowDown');
  assertMenuContained(100, 200, 420, 300);
  viewport.height = 260;
  await act(async () => viewport.dispatchEvent(new window.Event('resize')));
  assertMenuContained(100, 200, 420, 260);
});

test('typing searches tool descriptions and Enter picks a match without submitting the editor', async (t) => {
  const { input, saves, key, type } = await mountToolEditor(t);
  await type('offline');
  assert.deepEqual(
    [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent),
    ['tool-63']
  );
  await key('Enter');
  assert.equal(input.value, 'tool-63');
  assert.equal(document.querySelector('[role="listbox"]'), null);
  assert.equal(saves.length, 0, 'selecting a tool must not submit the editor');
});

test('arrow keys move through the tool suggestions and Enter picks the active one', async (t) => {
  const { input, key } = await mountToolEditor(t);
  await key('Escape');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  assert.equal(input.value, 'tool-64');
});

test('the first Escape closes only the tool suggestions and the next one closes the dialog', async (t) => {
  const { closed, key } = await mountToolEditor(t);
  await key('Escape');
  assert.equal(closed.count, 0, 'the first Escape closes only the suggestion list');
  await key('Escape');
  assert.equal(closed.count, 1, 'Escape returns to the dialog after the list closes');
});

test('a tool name typed freely is kept and saved', async (t) => {
  const { saves, type, submit } = await mountToolEditor(t);
  await type('custom-tool-name');
  assert.equal(document.querySelector('[role="listbox"]'), null);
  await submit();
  assert.deepEqual(saves.at(-1).toolDependencies, [{ type: 'tool', value: 'custom-tool-name' }]);
});
