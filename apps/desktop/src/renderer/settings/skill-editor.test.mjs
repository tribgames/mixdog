import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.FormData = dom.window.FormData;
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
    await act(async () => root.render(React.createElement(SkillEditorDialog, {
      skill: { name: 'pptx', description: 'Deck guide', toolDependencies: [{ type: 'tool', value: 'media' }],
        declaredToolDependencies: [{ type: 'tool', value: 'office' }] },
      instructions: '# Packaged instructions', disabled: false, busy: false, readOnly: true,
      onClose() {}, onSave: (payload) => saves.push(payload),
    })));
    assert.equal(document.querySelector('[name="skill-instructions"]').disabled, true);
    const remove = document.querySelector('.extensions-mcp-list-row button');
    await act(async () => remove.click());
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(saves.at(-1), { originalName: 'pptx', dependenciesOnly: true, toolDependencies: [] });
    const restore = [...document.querySelectorAll('button')].find((button) => /Restore declared tools/.test(button.textContent));
    await act(async () => restore.click());
    assert.equal(document.querySelector('.extensions-mcp-list-row input').value, 'office');
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(saves.at(-1), { originalName: 'pptx', dependenciesOnly: true, toolDependencies: null });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('tool suggestions stay inside the viewport and search, keyboard selection and free text preserve editor behavior', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const saves = [];
  let closed = 0;
  const tools = Array.from({ length: 80 }, (_, index) => ({
    name: `tool-${index}`, description: index === 63 ? 'Offline document processing' : 'General tool',
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1640 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 955 });
  try {
    await act(async () => root.render(React.createElement(SkillEditorDialog, {
      skill: { name: 'test-skill', toolDependencies: [{ type: 'tool', value: 'tool-63' }] },
      instructions: '# Instructions', disabled: false, busy: false, readOnly: true, tools,
      onClose() { closed++; }, onSave: payload => saves.push(payload),
    })));
    const input = document.querySelector('input[role="combobox"]');
    let rect = { left: 800, right: 1152, top: 603, bottom: 635, width: 352, height: 32 };
    input.getBoundingClientRect = () => rect;
    const key = async name => act(async () => input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
    const type = async value => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => input.focus());
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelectorAll('[role="option"]').length, 80);
    const assertContained = (left, top, width, height) => {
      const menu = document.querySelector('[role="listbox"]');
      const menuWidth = Number.parseFloat(menu.style.width);
      const menuHeight = Number.parseFloat(menu.style.maxHeight);
      const menuLeft = Number.parseFloat(menu.style.left);
      const menuTop = menu.style.top ? Number.parseFloat(menu.style.top)
        : window.innerHeight - Number.parseFloat(menu.style.bottom) - menuHeight;
      assert.ok(menuLeft >= left + 8);
      assert.ok(menuLeft + menuWidth <= left + width - 8);
      assert.ok(menuTop >= top + 8);
      assert.ok(menuTop + menuHeight <= top + height - 8);
      assert.ok(menuHeight <= 240);
      assert.equal(menu.style.overflowY, 'auto');
    };
    assertContained(0, 0, 1640, 955);
    rect = { left: 1510, right: 1862, top: 900, bottom: 932, width: 352, height: 32 };
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    assertContained(0, 0, 1640, 955);
    const viewport = new window.EventTarget();
    Object.assign(viewport, { width: 420, height: 300, offsetLeft: 100, offsetTop: 200 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    rect = { left: 380, right: 732, top: 450, bottom: 482, width: 352, height: 32 };
    // Reopening attaches listeners to the newly supplied visual viewport.
    await key('Escape');
    await key('ArrowDown');
    assertContained(100, 200, 420, 300);
    viewport.height = 260;
    await act(async () => viewport.dispatchEvent(new window.Event('resize')));
    assertContained(100, 200, 420, 260);
    await type('offline');
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(node => node.textContent), ['tool-63']);
    await key('Enter');
    assert.equal(input.value, 'tool-63');
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(saves.length, 0, 'selecting a tool must not submit the editor');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    assert.equal(input.value, 'tool-64');
    await key('ArrowDown');
    await key('Escape');
    assert.equal(closed, 0, 'the first Escape closes only the suggestion list');
    await type('custom-tool-name');
    assert.equal(document.querySelector('[role="listbox"]'), null);
    await act(async () => document.querySelector('form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(saves.at(-1).toolDependencies, [{ type: 'tool', value: 'custom-tool-name' }]);
    await key('Escape');
    await key('Escape');
    assert.equal(closed, 1, 'Escape returns to the dialog after the list closes');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  }
});
