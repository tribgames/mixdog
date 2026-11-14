// The page-world functions of `fill` and `type` (native/core/crates/mixdog-browser-engine/assets/page/fill-ref.js and focus-ref.js)
// run in JSDOM the way the engine runs them: declared with the editability check spliced in, applied to the ref's element. What
// the engine does around them (typed insertion into an editor, reading it back) is covered by its own Rust tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ASSETS = new URL('../../../../../native/core/crates/mixdog-browser-engine/assets/page/', import.meta.url);
const asset = (name) => fs.readFileSync(new URL(name, ASSETS), 'utf8');
const EDITABILITY = asset('editability.js');

/** The function as the engine sends it to the element, applied to `element` with `args`. */
function apply(element, name, args = []) {
  const source = asset(name).split('__MIXDOG_EDITABILITY__').join(EDITABILITY);
  return element.ownerDocument.defaultView.eval(`(${source})`).apply(element, args);
}

function fixture(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://fixture.example/' });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

test('a contenteditable element is selected whole and its DOM is left for typed input', () => {
  const dom = fixture('<div id="editor" contenteditable="true"><p>old draft</p></div>');
  try {
    const editor = dom.window.document.querySelector('#editor');
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    assert.deepEqual({ ...apply(editor, 'fill-ref.js', ['new text']) }, { contentEditable: true });
    assert.equal(editor.textContent, 'old draft', 'the page script never overwrote the editor DOM');
    const selection = dom.window.getSelection();
    assert.equal(selection.rangeCount, 1);
    assert.equal(selection.getRangeAt(0).commonAncestorContainer, editor);
    assert.deepEqual({ ...apply(editor, 'fill-ref.js', ['']) }, { contentEditable: true }, 'clearing selects it too');
  } finally {
    dom.window.close();
  }
});

test('an input takes the value through the native setter with the events a form library listens for', () => {
  const dom = fixture('<input id="name" value="old"><textarea id="note"></textarea><input id="pw" type="password">');
  try {
    const document = dom.window.document;
    const events = [];
    for (const id of ['name', 'note', 'pw']) {
      for (const type of ['input', 'change']) {
        document.getElementById(id).addEventListener(type, () => events.push(`${id}:${type}`));
      }
    }
    assert.deepEqual({ ...apply(document.getElementById('name'), 'fill-ref.js', ['Ada']) }, { value: 'Ada', sensitive: false });
    assert.equal(document.getElementById('name').value, 'Ada');
    assert.deepEqual({ ...apply(document.getElementById('note'), 'fill-ref.js', ['a\nb']) }, { value: 'a\nb', sensitive: false });
    // A password answers no value and is marked sensitive, so the engine registers it as a secret.
    assert.deepEqual({ ...apply(document.getElementById('pw'), 'fill-ref.js', ['hunter2']) }, { value: '', sensitive: true });
    assert.equal(document.getElementById('pw').value, 'hunter2');
    assert.deepEqual(events, ['name:input', 'name:change', 'note:input', 'note:change', 'pw:input', 'pw:change']);
  } finally {
    dom.window.close();
  }
});

test('a file input, a disabled field, a read-only field and a non-editable element are refused with the reason', () => {
  const dom = fixture(
    '<input id="file" type="file"><input id="off" disabled><input id="ro" readonly><p id="text">x</p><div inert><input id="inert"></div>'
  );
  try {
    const document = dom.window.document;
    const error = (id) => apply(document.getElementById(id), 'fill-ref.js', ['v']).error;
    assert.equal(error('file'), 'file inputs require upload');
    assert.equal(error('off'), 'element is disabled');
    assert.equal(error('ro'), 'element is readonly');
    assert.equal(error('text'), 'element is not editable');
    assert.equal(error('inert'), 'element is disabled');
    assert.equal(apply(document.createElement('input'), 'fill-ref.js', ['v']).error, 'stale', 'a detached element is stale');
  } finally {
    dom.window.close();
  }
});

test('focus for typing refuses what is not editable and marks a password', () => {
  const dom = fixture('<input id="pw" type="password"><input id="plain"><p id="text">x</p>');
  try {
    const document = dom.window.document;
    assert.deepEqual({ ...apply(document.getElementById('pw'), 'focus-ref.js') }, { sensitive: true });
    assert.deepEqual({ ...apply(document.getElementById('plain'), 'focus-ref.js') }, { sensitive: false });
    assert.equal(document.activeElement, document.getElementById('plain'));
    assert.equal(apply(document.getElementById('text'), 'focus-ref.js').error, 'element is not editable');
  } finally {
    dom.window.close();
  }
});
