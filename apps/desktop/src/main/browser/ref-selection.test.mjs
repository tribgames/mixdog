// The page-world functions of `select` and of the control-state reads (native/core/crates/mixdog-browser-engine/assets/page/:
// select-native.js, custom-control.js, open-custom.js, pick-custom.js, read-select-options.js, read-checked.js) run in JSDOM the
// way the engine runs them: declared with the editability check (and the shared custom-control head) spliced in, applied to the
// ref's element in the element's own realm. `selectRef` below is the engine's loop (refs/select.rs) over those functions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ASSETS = new URL('../../../../../native/core/crates/mixdog-browser-engine/assets/page/', import.meta.url);
const asset = (name) => fs.readFileSync(new URL(name, ASSETS), 'utf8');
const EDITABILITY = asset('editability.js');
const CUSTOM_CONTROL = asset('custom-control.js');

function apply(element, name, args = []) {
  const source = asset(name).split('__MIXDOG_CUSTOM_CONTROL__').join(CUSTOM_CONTROL).split('__MIXDOG_EDITABILITY__').join(EDITABILITY);
  return element.ownerDocument.defaultView.eval(`(${source})`).apply(element, args);
}

// A report is built in the element's realm: compare it by value.
const plain = (report) => JSON.parse(JSON.stringify(report));

const checked = (report) => {
  if (report?.error) throw new Error(report.error === 'stale' ? 'ref is stale' : report.error);
  return report ?? {};
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DROPDOWN_TIMEOUT_MS = 100;
const DROPDOWN_POLL_MS = 1;

async function selectCustom(element, values) {
  const [wanted, ...rest] = values;
  if (rest.length || !wanted?.trim()) throw new Error('custom dropdowns require exactly one non-empty value');
  checked(apply(element, 'open-custom.js'));
  const deadline = Date.now() + DROPDOWN_TIMEOUT_MS;
  for (;;) {
    const result = checked(apply(element, 'pick-custom.js', [wanted.trim()]));
    if (result.values) return result.values;
    if (!result.pending || Date.now() >= deadline) {
      throw new Error('no open option list was found for this control; take a fresh snapshot');
    }
    await sleep(DROPDOWN_POLL_MS);
  }
}

async function selectRef(element, values) {
  if (!values.length) throw new Error('select requires at least one value');
  const result = checked(apply(element, 'select-native.js', [values]));
  return result.custom ? selectCustom(element, values) : (result.values ?? []);
}

function fixture(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://fixture.example/' });
  const prepareRealm = (view) => {
    view.HTMLElement.prototype.scrollIntoView = () => {};
    view.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, left: 0, top: 0 });
  };
  prepareRealm(dom.window);
  return { dom, prepareRealm };
}

test('native selection validates all requested options without changing state on failure', async () => {
  const f = fixture(
    `<select multiple>
      <option value="a">Alpha</option><option value="b" selected>Beta</option>
      <option value="disabled" disabled>Disabled</option>
      <optgroup disabled><option value="group">Group</option></optgroup>
      <option value="one">Duplicate</option><option value="two">Duplicate</option>
    </select>`
  );
  try {
    const select = f.dom.window.document.querySelector('select');
    let events = 0;
    select.addEventListener('input', () => events++);
    select.addEventListener('change', () => events++);
    for (const values of [['missing'], ['a', 'missing'], ['disabled'], ['group'], ['Duplicate']]) {
      await assert.rejects(selectRef(select, values), /matched|disabled|ambiguous/);
      assert.deepEqual(
        Array.from(select.selectedOptions, (option) => option.value),
        ['b']
      );
      assert.equal(events, 0);
    }
    select.multiple = false;
    await assert.rejects(selectRef(select, ['a', 'b']), /exactly one/);
    assert.equal(select.value, 'b');
    assert.equal(events, 0);
    select.multiple = true;
    const result = await selectRef(select, ['a', 'Beta']);
    assert.deepEqual(Array.from(result), ['a', 'b']);
    assert.deepEqual(
      Array.from(select.selectedOptions, (option) => option.value),
      ['a', 'b']
    );
    assert.equal(events, 2);
  } finally {
    f.dom.window.close();
  }
});

test('custom selection ignores unrelated lists and accepts only a unique exact option', async () => {
  const f = fixture(
    `<div id="other" role="listbox"><div role="option">Busan</div></div>
      <button aria-haspopup="listbox" aria-controls="cities">City</button>
      <div id="cities" role="listbox"><div role="option" data-value="busan">Busan</div>
      <div role="option">Busan North</div><div role="option" aria-disabled="true">Closed</div></div>`
  );
  try {
    const doc = f.dom.window.document;
    const button = doc.querySelector('button');
    const selected = [];
    for (const option of doc.querySelectorAll('[role=option]')) {
      option.addEventListener('click', () => selected.push(`${option.parentElement.id}:${option.textContent}`));
    }
    await selectRef(button, ['Busan']);
    assert.deepEqual(selected, ['cities:Busan']);
    for (const values of [['Bus'], ['BUSAN'], ['Closed']]) {
      await assert.rejects(selectRef(button, values), /matched exactly|disabled/);
    }
    const duplicate = doc.createElement('div');
    duplicate.setAttribute('role', 'option');
    duplicate.textContent = 'Busan';
    doc.querySelector('#cities').append(duplicate);
    await assert.rejects(selectRef(button, ['Busan']), /ambiguous/);
    assert.deepEqual(selected, ['cities:Busan']);
  } finally {
    f.dom.window.close();
  }
});

test('custom selection remains in a child frame and its open shadow root', async () => {
  const f = fixture('<div id="cities" role="listbox"><div role="option">Busan</div></div><iframe></iframe>');
  try {
    const frame = f.dom.window.document.querySelector('iframe').contentWindow;
    f.prepareRealm(frame);
    const host = frame.document.createElement('div');
    frame.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<button role="combobox" aria-owns="cities">City</button><div role="listbox" id="cities"><div role="option">Busan</div></div>';
    let clicks = 0;
    let rootClicks = 0;
    root.querySelector('[role=option]').addEventListener('click', () => clicks++);
    f.dom.window.document.querySelector('[role=option]').addEventListener('click', () => rootClicks++);
    await selectRef(root.querySelector('button'), ['Busan']);
    assert.equal(clicks, 1);
    assert.equal(rootClicks, 0, 'a frame-bound control is not searched from the root page');
  } finally {
    f.dom.window.close();
  }
});

test('invalid custom requests do not open a control and an unassociated popup is never guessed', async () => {
  const f = fixture('<button role="combobox">City</button><div role="listbox"><div role="option">Busan</div></div>');
  try {
    const trigger = f.dom.window.document.querySelector('button');
    let opens = 0;
    trigger.addEventListener('click', () => opens++);
    for (const values of [[], [''], ['Busan', 'Seoul'], ['Busan']]) {
      await assert.rejects(selectRef(trigger, values), /requires|require|associated/);
    }
    assert.equal(opens, 0);
  } finally {
    f.dom.window.close();
  }
});

test('custom selection waits for its associated list to render without opening it again', async () => {
  const f = fixture('<button role="combobox" aria-controls="cities">City</button>');
  try {
    const doc = f.dom.window.document;
    const trigger = doc.querySelector('button');
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
    await selectRef(trigger, ['Busan']);
    assert.equal(opens, 1);
    assert.equal(clicks, 1);
  } finally {
    f.dom.window.close();
  }
});

test('a native selection miss names the options the control actually offers', async () => {
  const f = fixture('<select><option value="a">Alpha</option><option value="b">Beta</option></select>');
  try {
    await assert.rejects(selectRef(f.dom.window.document.querySelector('select'), ['Gamma']), /options include: Alpha \| Beta/);
  } finally {
    f.dom.window.close();
  }
});

test('the options a select lists carry their marks, a custom control is said to be custom, and a checkbox reads its state', () => {
  const f = fixture(
    '<select><option>One</option><option selected>Two</option><option disabled>Three</option></select><div role="combobox" id="c"></div>' +
      '<input type="checkbox" id="box" checked><input type="radio" id="radio"><input id="text">'
  );
  try {
    const document = f.dom.window.document;
    assert.deepEqual(
      plain(apply(document.querySelector('select'), 'read-select-options.js')),
      { options: ['One', 'Two [selected]', 'Three [disabled]'] }
    );
    assert.deepEqual({ ...apply(document.getElementById('c'), 'read-select-options.js') }, { custom: true });
    assert.deepEqual({ ...apply(document.getElementById('box'), 'read-checked.js') }, { checked: true, radio: false });
    assert.deepEqual({ ...apply(document.getElementById('radio'), 'read-checked.js') }, { checked: false, radio: true });
    assert.equal(apply(document.getElementById('text'), 'read-checked.js').error, 'element is not a checkbox or radio button');
    assert.equal(apply(document.createElement('select'), 'read-select-options.js').error, 'stale');
  } finally {
    f.dom.window.close();
  }
});
