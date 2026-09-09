import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createBrowserRefActions } from './ref-actions.ts';

function editorFixture(ax) {
  const dom = new JSDOM('<div id="editor" contenteditable="true"><p>old draft</p></div>', {
    runScripts: 'outside-only', url: 'https://fixture.example/',
  });
  const { window } = dom;
  const editor = window.document.querySelector('#editor');
  Object.defineProperty(editor, 'isContentEditable', { value: true });
  editor.scrollIntoView = () => {};
  window.__mixdogAgentSnapshot = { refs: new Map([['ref', editor]]) };
  const inserted = [];
  const keys = [];
  let dropInsertedText = false;
  const actions = createBrowserRefActions({
    callAccessibilityRef: async (_guest, _ref, source, args) => (ax
      ? { handled: true, value: await window.eval(`(${source})`).apply(editor, args) }
      : { handled: false }),
    evaluate: async (_guest, source) => window.eval(source),
    cdp: {
      guestDebugger: async () => ({}),
      sendCdpInput: async (_guest, _debugger, method, params) => {
        inserted.push({ method, params, before: editor.textContent });
        if (method === 'Input.insertText' && !dropInsertedText) {
          // The selection covers the whole editor, so typed text replaces it.
          editor.textContent = params.text;
        }
      },
    },
    input: {
      pressKey: async (_guest, key) => {
        keys.push(key);
        if (key === 'Backspace') editor.textContent = '';
      },
    },
    pause: async () => {},
    dropdownTimeoutMs: 10, dropdownPollMs: 1,
  });
  return {
    dom, editor, actions, inserted, keys,
    dropInsertedText: () => { dropInsertedText = true; },
  };
}

for (const ax of [true, false]) {
  test(`contenteditable fill selects everything and inserts typed text (${ax ? 'AX' : 'DOM'})`, async () => {
    const f = editorFixture(ax);
    try {
      const result = await f.actions.fillRef({}, 'ref', 'new text');
      assert.equal(result, 'new text');
      assert.equal(f.inserted.length, 1);
      assert.equal(f.inserted[0].method, 'Input.insertText');
      assert.equal(f.inserted[0].before, 'old draft', 'the page script never overwrote the editor DOM');
      const selection = f.dom.window.getSelection();
      assert.equal(selection.rangeCount, 1);
      assert.equal(selection.getRangeAt(0).commonAncestorContainer, f.editor);
      assert.equal(await f.actions.fillRef({}, 'ref', ''), '');
      assert.deepEqual(f.keys, ['Backspace'], 'clearing deletes the selection instead of inserting nothing');
    } finally {
      f.dom.window.close();
    }
  });
}

test('an editor that drops the inserted text is reported instead of claimed filled', async () => {
  const f = editorFixture(true);
  try {
    f.dropInsertedText();
    f.editor.textContent = '';
    await assert.rejects(f.actions.fillRef({}, 'ref', 'lost'), /did not keep the inserted text/);
  } finally {
    f.dom.window.close();
  }
});