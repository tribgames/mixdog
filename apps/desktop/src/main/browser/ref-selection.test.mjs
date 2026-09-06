import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserRefActions } from './ref-actions.ts';

function fixture(html, ax = true) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://fixture.example/' });
  const refs = new Map();
  const guest = {};
  const calls = [];
  const prepareRealm = view => {
    view.HTMLElement.prototype.scrollIntoView = function () {};
    view.HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 20, height: 20, left: 0, top: 0 };
    };
  };
  prepareRealm(dom.window);
  dom.window.__mixdogAgentSnapshot = { refs };
  const actions = createBrowserRefActions({
    callAccessibilityRef: async (_guest, ref, source, args) => {
      if (!ax) return { handled: false };
      const element = refs.get(ref);
      const view = element.ownerDocument.defaultView;
      return { handled: true, value: await view.eval(`(${source})`).apply(element, args) };
    },
    evaluate: async (_guest, source) => { calls.push('root evaluation'); return dom.window.eval(source); },
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
    dropdownTimeoutMs: 100, dropdownPollMs: 1,
  });
  return { dom, refs, guest, actions, calls, prepareRealm };
}

for (const ax of [true, false]) {
  test(`native selection validates all requested options without changing state on failure (${ax ? 'AX' : 'DOM'})`, async () => {
    const f = fixture(`<select multiple>
      <option value="a">Alpha</option><option value="b" selected>Beta</option>
      <option value="disabled" disabled>Disabled</option>
      <optgroup disabled><option value="group">Group</option></optgroup>
      <option value="one">Duplicate</option><option value="two">Duplicate</option>
    </select>`, ax);
    try {
      const select = f.dom.window.document.querySelector('select');
      f.refs.set('ref', select);
      let events = 0;
      select.addEventListener('input', () => events++);
      select.addEventListener('change', () => events++);
      for (const values of [['missing'], ['a', 'missing'], ['disabled'], ['group'], ['Duplicate']]) {
        await assert.rejects(f.actions.selectRef(f.guest, 'ref', values), /matched|disabled|ambiguous/);
        assert.deepEqual(Array.from(select.selectedOptions, option => option.value), ['b']);
        assert.equal(events, 0);
      }
      select.multiple = false;
      await assert.rejects(f.actions.selectRef(f.guest, 'ref', ['a', 'b']), /exactly one/);
      assert.equal(select.value, 'b');
      assert.equal(events, 0);
      select.multiple = true;
      const result = await f.actions.selectRef(f.guest, 'ref', ['a', 'Beta']);
      assert.deepEqual(Array.from(result), ['a', 'b']);
      assert.deepEqual(Array.from(select.selectedOptions, option => option.value), ['a', 'b']);
      assert.equal(events, 2);
    } finally { f.dom.window.close(); }
  });

  test(`custom selection ignores unrelated lists and accepts only a unique exact option (${ax ? 'AX' : 'DOM'})`, async () => {
    const f = fixture(`<div id="other" role="listbox"><div role="option">Busan</div></div>
      <button aria-haspopup="listbox" aria-controls="cities">City</button>
      <div id="cities" role="listbox"><div role="option" data-value="busan">Busan</div>
      <div role="option">Busan North</div><div role="option" aria-disabled="true">Closed</div></div>`, ax);
    try {
      const doc = f.dom.window.document;
      f.refs.set('ref', doc.querySelector('button'));
      const selected = [];
      for (const option of doc.querySelectorAll('[role=option]')) {
        option.addEventListener('click', () => selected.push(`${option.parentElement.id}:${option.textContent}`));
      }
      await f.actions.selectRef(f.guest, 'ref', ['Busan']);
      assert.deepEqual(selected, ['cities:Busan']);
      for (const values of [['Bus'], ['BUSAN'], ['Closed']]) {
        await assert.rejects(f.actions.selectRef(f.guest, 'ref', values), /matched exactly|disabled/);
      }
      const duplicate = doc.createElement('div');
      duplicate.setAttribute('role', 'option');
      duplicate.textContent = 'Busan';
      doc.querySelector('#cities').append(duplicate);
      await assert.rejects(f.actions.selectRef(f.guest, 'ref', ['Busan']), /ambiguous/);
      assert.deepEqual(selected, ['cities:Busan']);
    } finally { f.dom.window.close(); }
  });
}

test('custom selection remains in a child frame and its open shadow root', async () => {
  const f = fixture('<div id="cities" role="listbox"><div role="option">Busan</div></div><iframe></iframe>');
  try {
    const frame = f.dom.window.document.querySelector('iframe').contentWindow;
    f.prepareRealm(frame);
    const host = frame.document.createElement('div');
    frame.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button role="combobox" aria-owns="cities">City</button><div role="listbox" id="cities"><div role="option">Busan</div></div>';
    f.refs.set('frame-ref', root.querySelector('button'));
    let clicks = 0;
    root.querySelector('[role=option]').addEventListener('click', () => clicks++);
    await f.actions.selectRef(f.guest, 'frame-ref', ['Busan']);
    assert.equal(clicks, 1);
    assert.deepEqual(f.calls, [], 'a frame-bound control must not be searched from the root page');
  } finally { f.dom.window.close(); }
});

test('invalid custom requests do not open a control and an unassociated popup is never guessed', async () => {
  const f = fixture('<button role="combobox">City</button><div role="listbox"><div role="option">Busan</div></div>');
  try {
    const trigger = f.dom.window.document.querySelector('button');
    f.refs.set('ref', trigger);
    let opens = 0;
    trigger.addEventListener('click', () => opens++);
    for (const values of [[], [''], ['Busan', 'Seoul'], ['Busan']]) {
      await assert.rejects(f.actions.selectRef(f.guest, 'ref', values), /requires|require|associated/);
    }
    assert.equal(opens, 0);
  } finally { f.dom.window.close(); }
});

test('custom selection waits for its associated list to render without opening it again', async () => {
  const f = fixture('<button role="combobox" aria-controls="cities">City</button>');
  try {
    const doc = f.dom.window.document;
    const trigger = doc.querySelector('button');
    f.refs.set('ref', trigger);
    let opens = 0;
    let clicks = 0;
    trigger.addEventListener('click', () => {
      opens++;
      setTimeout(() => {
        const list = doc.createElement('div');
        list.id = 'cities';
        list.setAttribute('role', 'listbox');
        list.innerHTML = '<div role="option">Busan</div>';
        list.firstElementChild.addEventListener('click', () => clicks++);
        doc.body.append(list);
      }, 5);
    });
    await f.actions.selectRef(f.guest, 'ref', ['Busan']);
    assert.equal(opens, 1);
    assert.equal(clicks, 1);
  } finally { f.dom.window.close(); }
});
