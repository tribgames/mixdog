import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  MAX_VISUALIZE_MASKS,
  VISUALIZE_FEEDBACK_TAG,
  visualizeFeedbackPageMessage,
  visualizeFeedbackScriptFor,
  withVisualizeFeedbackScript,
} from './visualize-feedback.ts';

const LONG_TOKEN = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';
const OPENAI_KEY = 'sk-proj1234567890abcdefXYZ';
const tag = { [VISUALIZE_FEEDBACK_TAG]: 1 };

/** A page with the feedback script installed, posting to a recorder. The
 *  overlay's shadow root is opened (test only) so its marks can be read. */
function page(t, body, url = undefined) {
  const dom = new JSDOM(`<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    ...(url ? { url } : {}),
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const sent = [];
  window.__panel = { postMessage: (message) => sent.push(JSON.parse(JSON.stringify(message))) };
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, { ...init, mode: 'open' });
    window.__overlay = root;
    return root;
  };
  assert.equal(window.eval(visualizeFeedbackScriptFor('window.__panel')), true);
  // A second injection (a re-attach on the same page) is a no-op.
  assert.equal(window.eval(visualizeFeedbackScriptFor('window.__panel')), true);
  const api = window.__mixdogVisualizeFeedback;
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const frames = () => new Promise((resolve) => setTimeout(resolve, 80));
  /** The element the page reports under a point. */
  const at = (node) => {
    window.document.elementFromPoint = () => node;
  };
  return { window, document: window.document, sent, api, click, frames, at, overlay: () => window.__overlay };
}

const box = (left, top, width, height) => () => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test('the page script announces itself and stays out of a top-level window', async (t) => {
  const { sent, document, frames } = page(t, '<p>hi</p>');
  await frames();
  assert.deepEqual(sent, [
    { type: 'ready', ...tag },
    { type: 'tweaks', raw: null, ...tag },
  ]);
  // The default selected style is the first (lowest-priority) sheet, zero specificity.
  const style = document.head.firstElementChild;
  assert.equal(style.getAttribute('data-mixdog-visualize'), '');
  assert.match(style.textContent, /:where\(\[data-choice\]\[data-choice-selected\]\)/);

  const top = new JSDOM('<p>x</p>', { runScripts: 'outside-only' });
  t.after(() => top.window.close());
  assert.equal(top.window.eval(visualizeFeedbackScriptFor('window')), false);
});

test('a press on the page focuses its frame, also when the page cancels the press', (t) => {
  const { window, document } = page(t, '<canvas id="game"></canvas>');
  const game = document.getElementById('game');
  // A game cancels the press (no selection, no drag): the browser's own focus move goes with it.
  game.addEventListener('pointerdown', (event) => event.preventDefault());
  let focused = false;
  let calls = 0;
  window.document.hasFocus = () => focused;
  window.focus = () => {
    calls += 1;
    focused = true;
  };
  const press = () => game.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(press(), false, 'the page still cancels its own press');
  assert.equal(calls, 1, 'the frame takes the keyboard');
  press();
  assert.equal(calls, 1, 'a frame that has the keyboard is left alone');
});

test('a web link the frame may not show is handed to the panel instead of navigating the pane', async (t) => {
  const { document, sent, api, frames } = page(
    t,
    `<a id="web" href="https://example.com/">web</a>
     <a id="blank" href="next.html" target="_blank">new window</a>
     <a id="own" href="next.html">own page</a>
     <a id="mail" href="mailto:a@example.com">mail</a>
     <a id="handled" href="https://example.org/">handled</a>`,
    'http://127.0.0.1:5000/tok/index.html'
  );
  await frames();
  sent.length = 0;
  document.getElementById('handled').addEventListener('click', (event) => event.preventDefault());
  const press = (id, init = {}) =>
    document
      .getElementById(id)
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  assert.equal(press('web'), false, 'the navigation is cancelled');
  assert.equal(press('blank', { ctrlKey: true }), false);
  assert.equal(press('own'), true, 'its own pages still navigate in place');
  assert.equal(press('mail'), true);
  press('handled');
  assert.deepEqual(sent, [
    { type: 'link', url: 'https://example.com/', external: false, ...tag },
    { type: 'link', url: 'http://127.0.0.1:5000/tok/next.html', external: true, ...tag },
  ]);
  sent.length = 0;
  api.apply({ type: 'state', comment: true, markers: [] });
  assert.equal(press('web'), true, 'Comment mode leaves the click to the pin layer');
  assert.deepEqual(sent, []);

  assert.deepEqual(visualizeFeedbackPageMessage({ type: 'link', url: 'https://example.com/a', external: 1, ...tag }), {
    type: 'link',
    url: 'https://example.com/a',
    external: false,
  });
  assert.equal(visualizeFeedbackPageMessage({ type: 'link', url: 'javascript:alert(1)', ...tag }), null);
  assert.equal(visualizeFeedbackPageMessage({ type: 'link', url: 'file:///C:/secret.txt', ...tag }), null);
});

test('the page never makes a pin: it only describes the element under a pick point, redacted', async (t) => {
  const { document, sent, api, click, frames, at, overlay } = page(
    t,
    `<main><div class="toolbar">
      <button class="rename primary" id="go">Rename ${OPENAI_KEY}</button>
      <form class="login">
        <input type="password" name="pw" value="hunter2">
        <input name="api_token" value="tok-plain-value">
        <input name="city" value="Seoul">
        <span>${LONG_TOKEN}</span>
        <img src="data:image/png;base64,${'A'.repeat(200)}">
        ${'<i>filler</i>'.repeat(80)}
      </form>
    </div></main>`
  );
  await frames();
  sent.length = 0;
  const form = document.querySelector('form.login');
  const password = form.querySelector('input[type=password]');
  password.getBoundingClientRect = box(5, 6, 50, 10);

  api.apply({ type: 'state', comment: true, markers: [{ n: 1, selector: '#go' }] });
  click(form);
  assert.deepEqual(sent, [], 'a click inside the page posts nothing in Comment mode');

  // Hover is drawn from the panel's point, not from page events.
  at(form);
  form.getBoundingClientRect = box(0, 0, 200, 100);
  api.apply({ type: 'hover', x: 10, y: 10 });
  await frames();
  assert.equal(overlay().querySelectorAll('.box.hover').length, 1);

  api.apply({ type: 'pick', id: 'req-1', x: 10, y: 10 });
  const message = sent.at(-1);
  assert.equal(message.type, 'picked');
  assert.equal(message.id, 'req-1');
  const { pick } = message;
  assert.deepEqual(Object.keys(pick).sort(), [
    'box',
    'child',
    'html',
    'masks',
    'masksOverflow',
    'name',
    'path',
    'role',
    'selector',
    'styles',
    'view',
  ]);
  assert.equal(pick.selector, 'body > main > div > form');
  assert.equal(document.querySelector(pick.selector), form);
  assert.equal(pick.role, 'form');
  assert.doesNotMatch(pick.name, /hunter2|tok-plain-value/);
  assert.deepEqual(pick.path, [
    { selector: 'body > main', role: 'section', name: pick.path[0].name },
    { selector: 'body > main > div', role: 'box', name: pick.path[1].name },
  ]);
  assert.doesNotMatch(JSON.stringify(pick.path), new RegExp(`${OPENAI_KEY}|${LONG_TOKEN}`), 'names are redacted');
  assert.ok(pick.html.length <= 600);
  assert.match(pick.html, /^<form class="login">/);
  assert.doesNotMatch(pick.html, /hunter2|tok-plain-value/);
  assert.doesNotMatch(pick.html, new RegExp(LONG_TOKEN));
  assert.doesNotMatch(pick.html, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
  assert.match(pick.html, /type="password" name="pw" value="\[redacted\]"/);
  assert.match(pick.html, /name="api_token" value="\[redacted\]"/);
  assert.match(pick.html, /name="city" value="Seoul"/, 'ordinary values stay');
  assert.deepEqual(pick.masks, [{ x: 5, y: 6, width: 50, height: 10 }]);
  assert.equal(pick.masksOverflow, false);
  assert.equal(typeof pick.styles.display, 'string');
  assert.deepEqual(pick.view, { x: 0, y: 0, width: 200, height: 100 });

  // A unique id is used; known key shapes are redacted.
  at(document.getElementById('go'));
  api.apply({ type: 'pick', id: 'req-2', x: 1, y: 1 });
  assert.equal(sent.at(-1).pick.selector, '#go');
  assert.equal(sent.at(-1).pick.role, 'button');
  assert.equal(sent.at(-1).pick.name, 'Rename [redacted]');
  assert.match(sent.at(-1).pick.html, /Rename \[redacted\]/);

  // Nothing under the point (or the overlay itself): no answer.
  at(null);
  const count = sent.length;
  api.apply({ type: 'pick', id: 'req-3', x: 1, y: 1 });
  assert.equal(sent.length, count);

  // Esc inside the page leaves Comment mode through the panel.
  document.body.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(sent.at(-1).type, 'exit-comment');
});

test('names and the inside path never carry what a secret field holds', async (t) => {
  const { document, sent, api, frames, at } = page(
    t,
    `<main><form class="notes"><label>Notes</label><textarea name="api_token">s3cr3t-note-value</textarea><button id="save">Save</button></form></main>`
  );
  await frames();
  api.apply({ type: 'state', comment: true, markers: [] });
  at(document.getElementById('save'));
  api.apply({ type: 'pick', id: 'r1', x: 1, y: 1 });
  const { pick } = sent.at(-1);
  assert.equal(pick.name, 'Save');
  assert.equal(pick.path.at(-1).role, 'form');
  assert.equal(pick.path.at(-1).name, 'NotesSave', 'the form keeps its own text');
  assert.doesNotMatch(JSON.stringify(pick.path), /s3cr3t/);

  at(document.querySelector('form'));
  api.apply({ type: 'pick', id: 'r2', x: 1, y: 1 });
  assert.doesNotMatch(sent.at(-1).pick.name, /s3cr3t/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).pick.path), /s3cr3t/);
  assert.match(sent.at(-1).pick.html, /\[redacted\]/);
});

test('hover shows a human label; Alt+Up/Down move the target, and a pick takes it', async (t) => {
  const { document, sent, api, frames, at, overlay } = page(
    t,
    '<section id="card"><div class="foot"><button id="save"><span id="label">Save</span></button></div></section>'
  );
  const label = document.getElementById('label');
  const button = document.getElementById('save');
  const foot = button.parentElement;
  label.getBoundingClientRect = box(10, 10, 30, 12);
  button.getBoundingClientRect = box(5, 5, 60, 24);
  foot.getBoundingClientRect = box(0, 0, 200, 40);
  api.apply({ type: 'state', comment: true, markers: [], nouns: { button: '버튼', text: '글자', box: '상자' } });
  at(label);
  api.apply({ type: 'hover', x: 12, y: 12 });
  await frames();
  assert.equal(overlay().querySelector('.tag').textContent, '글자 · Save30×12');

  api.apply({ type: 'hover-step', dir: 'up' });
  await frames();
  assert.equal(overlay().querySelector('.tag').textContent, '버튼 · Save60×24', 'Alt+Up: the button');
  api.apply({ type: 'pick', id: 'r1', x: 12, y: 12 });
  const pick = sent.at(-1).pick;
  assert.equal(pick.selector, '#save', 'the pick takes the lifted target, not the span under the point');
  assert.deepEqual(
    pick.path.map((node) => [node.selector, node.role]),
    [
      ['#card', 'section'],
      ['#card > div', 'box'],
    ]
  );
  assert.deepEqual(pick.child, { selector: '#label', role: 'text', name: 'Save' });

  api.apply({ type: 'hover-step', dir: 'up' });
  api.apply({ type: 'hover-step', dir: 'down' });
  await frames();
  assert.match(overlay().querySelector('.tag').textContent, /^버튼/, 'Alt+Down walks back toward the point');
  api.apply({ type: 'hover-step', dir: 'down' });
  await frames();
  assert.match(overlay().querySelector('.tag').textContent, /^글자/);

  // The element a comment is written for is outlined as selected, without a hover label.
  api.apply({ type: 'select', selector: '#save' });
  await frames();
  assert.equal(overlay().querySelectorAll('.box.sel').length, 1);
  assert.equal(overlay().querySelector('.tag'), null);

  // A click on a pin's number picks that pin's element.
  api.apply({ type: 'select', selector: null });
  api.apply({ type: 'state', comment: true, markers: [{ n: 1, selector: '#card > div' }] });
  await frames();
  at(label);
  api.apply({ type: 'pick', id: 'r2', x: 5, y: 5 });
  assert.equal(sent.at(-1).pick.selector, '#card > div');
});

test('measure counts the outermost elements inside an area and masks the secret fields it touches', (t) => {
  const { document, sent, api } = page(
    t,
    '<div id="a"><p id="p1">One</p></div><div id="b"><input type="password" id="pw"></div><div id="c">Out</div>'
  );
  const boxes = {
    a: box(0, 0, 100, 20),
    p1: box(0, 0, 50, 10),
    b: box(0, 20, 100, 20),
    pw: box(10, 25, 50, 10),
    c: box(0, 200, 100, 20),
  };
  for (const [id, rect] of Object.entries(boxes)) document.getElementById(id).getBoundingClientRect = rect;
  document.body.getBoundingClientRect = box(0, 0, 300, 300);
  api.apply({ type: 'measure', id: 'm1', rect: { x: 0, y: 0, width: 120, height: 50 } });
  assert.deepEqual(sent.at(-1), {
    type: 'measured',
    id: 'm1',
    count: 2,
    masks: [{ x: 10, y: 25, width: 50, height: 10 }],
    masksOverflow: false,
    // Only the body holds the whole area.
    anchor: { selector: 'body', rect: { x: 0, y: 0, width: 0.4, height: 0.1667 }, path: [] },
    ...tag,
  });
  const count = sent.length;
  api.apply({ type: 'measure', id: 'm2', rect: { x: 'no' } });
  assert.equal(sent.length, count, 'a malformed area gets no answer');

  const parsed = visualizeFeedbackPageMessage({ ...tag, type: 'measured', id: 'm', count: 1e9, masks: 'x' });
  assert.deepEqual(parsed, { type: 'measured', id: 'm', count: 10_000, masks: [], masksOverflow: true, anchor: null });
  const anchored = (anchor) =>
    visualizeFeedbackPageMessage({ ...tag, type: 'measured', id: 'm', count: 1, masks: [], anchor }).anchor;
  assert.deepEqual(
    anchored({
      selector: '#card',
      rect: { x: 0.123456, y: -0.25, width: 2, height: 0.75 },
      path: [{ selector: '#card' }],
    }),
    {
      selector: '#card',
      rect: { x: 0.1235, y: 0, width: 0.8765, height: 0.5 },
      path: [{ selector: '#card', role: 'box', name: '' }],
    },
    'fractions are clamped into the element'
  );
  for (const broken of [
    { selector: '', rect: { x: 0, y: 0, width: 1, height: 1 } },
    { selector: '#a', rect: { x: 0, y: 0, width: 'wide', height: 1 } },
    { selector: '#a', rect: { x: 1, y: 0, width: 1, height: 1 } },
    'body',
  ]) {
    assert.equal(anchored(broken), null);
  }
});

test('a dragged area is anchored to the smallest element holding it; the page draws it from that element now', async (t) => {
  const { document, window, sent, api, frames, overlay } = page(
    t,
    '<main id="main"><section id="card"><p id="txt">Hello</p></section></main>'
  );
  const card = document.getElementById('card');
  document.documentElement.getBoundingClientRect = box(0, 0, 800, 2000);
  document.body.getBoundingClientRect = box(0, 0, 800, 2000);
  document.getElementById('main').getBoundingClientRect = box(0, 0, 800, 1000);
  card.getBoundingClientRect = box(100, 100, 400, 300);
  document.getElementById('txt').getBoundingClientRect = box(110, 110, 100, 20);
  api.apply({ type: 'measure', id: 'm1', rect: { x: 150, y: 175, width: 200, height: 150 } });
  const { anchor } = sent.at(-1);
  assert.equal(anchor.selector, '#card');
  assert.deepEqual(anchor.rect, { x: 0.125, y: 0.25, width: 0.5, height: 0.5 });
  assert.deepEqual(
    anchor.path.map((node) => node.selector),
    ['#main', '#card'],
    'its human path: ancestors, then itself'
  );

  // The page draws the region and its number from the element's live box.
  api.apply({
    type: 'state',
    comment: true,
    markers: [{ n: 2, selector: '#card', region: { pin: 'p5', rect: anchor.rect } }],
  });
  await frames();
  const drawn = () => {
    const pin = overlay().querySelector('.box.pin');
    const number = overlay().querySelector('.num');
    return [
      pin.style.left,
      pin.style.top,
      pin.style.width,
      pin.style.height,
      number.textContent,
      number.style.left,
      number.style.top,
    ];
  };
  assert.deepEqual(drawn(), ['150px', '175px', '200px', '150px', '2', '140px', '165px']);

  // A scroll or reflow moves the element: the region follows it.
  card.getBoundingClientRect = box(20, -50, 200, 300);
  window.dispatchEvent(new window.Event('resize'));
  await frames();
  assert.deepEqual(drawn(), ['45px', '25px', '100px', '150px', '2', '35px', '15px']);

  // Its number reopens that pin; the element named is its anchor.
  api.apply({ type: 'pick', id: 'r1', x: 40, y: 20 });
  assert.equal(sent.at(-1).pin, 'p5');
  assert.equal(sent.at(-1).pick.selector, '#card');
  assert.equal(visualizeFeedbackPageMessage(sent.at(-1)).pin, 'p5');

  // Written for: outlined as selected instead.
  api.apply({ type: 'select', selector: null, pin: 'p5' });
  await frames();
  assert.equal(overlay().querySelectorAll('.box.sel').length, 1);
  assert.equal(overlay().querySelectorAll('.box.pin').length, 0);
});

test('saved pins are outlined in the full pin colour with a light halo', (t) => {
  const { overlay } = page(t, '<p>x</p>');
  // jsdom has no constructed sheets: the overlay falls back to a <style>.
  const css = [...overlay().querySelectorAll('style')].map((sheet) => sheet.textContent).join('\n');
  assert.match(css, /\.pin\{outline:1\.5px solid #ff3b6b;[^}]*box-shadow:0 0 0 1px rgba\(255,255,255,\.55\)\}/);
  assert.match(css, /\.hover\{outline:2px solid #ff3b6b;/, 'hover stays stronger than a saved pin');
});

test('a describe request re-reads the pinned element now: its current box and secret fields', (t) => {
  const { document, sent, api } = page(t, '<form id="f"><input name="city"></form>');
  const form = document.getElementById('f');
  form.getBoundingClientRect = box(0, 0, 200, 60);
  api.apply({ type: 'describe', id: 'd1', selector: '#f' });
  assert.deepEqual(sent.at(-1).pick.masks, []);
  assert.equal(sent.at(-1).id, 'd1');

  // A password field appears and the form moves after the pick.
  const secret = document.createElement('input');
  secret.type = 'password';
  secret.getBoundingClientRect = box(4, 34, 90, 12);
  form.append(secret);
  form.getBoundingClientRect = box(0, 30, 200, 60);
  api.apply({ type: 'describe', id: 'd2', selector: '#f' });
  assert.equal(sent.at(-1).id, 'd2');
  assert.deepEqual(sent.at(-1).pick.masks, [{ x: 4, y: 34, width: 90, height: 12 }]);
  assert.deepEqual(sent.at(-1).pick.view, { x: 0, y: 30, width: 200, height: 60 });

  // Gone (or a bad selector): no answer at all.
  const count = sent.length;
  api.apply({ type: 'describe', id: 'd3', selector: '#missing' });
  api.apply({ type: 'describe', id: 'd4', selector: '[[bad' });
  assert.equal(sent.length, count);
});

test('more secret fields than masks: the page reports none and flags the overflow', (t) => {
  const fields = Array.from({ length: MAX_VISUALIZE_MASKS + 1 }, (_, i) => `<input type="password" name="p${i}">`).join(
    ''
  );
  const { document, sent, api, at } = page(t, `<form id="many">${fields}</form>`);
  const form = document.getElementById('many');
  for (const [i, input] of [...form.querySelectorAll('input')].entries())
    input.getBoundingClientRect = box(0, i * 12, 80, 10);
  at(form);
  api.apply({ type: 'pick', id: 'r', x: 1, y: 1 });
  assert.equal(sent.at(-1).pick.masksOverflow, true);
  assert.deepEqual(sent.at(-1).pick.masks, []);
  // At the cap, every field is masked.
  form.lastElementChild.remove();
  api.apply({ type: 'pick', id: 'r2', x: 1, y: 1 });
  assert.equal(sent.at(-1).pick.masksOverflow, false);
  assert.equal(sent.at(-1).pick.masks.length, MAX_VISUALIZE_MASKS);
});

test('data-choice clicks mark one choice per group and post the pick, never in Comment mode', (t) => {
  const { document, sent, api, click } = page(
    t,
    `<div data-choice="a" data-choice-group="layout">One   column</div>
     <div data-choice="b" data-choice-group="layout" data-choice-label="Two columns"><span>2 cols</span></div>
     <button data-choice="dark">Dark</button>`
  );
  const [a, b, dark] = document.querySelectorAll('[data-choice]');
  click(b.querySelector('span'));
  assert.equal(b.hasAttribute('data-choice-selected'), true);
  assert.deepEqual(sent.at(-1), {
    type: 'choice',
    group: 'layout',
    choice: 'b',
    label: 'Two columns',
    selected: true,
    ...tag,
  });
  click(a);
  assert.equal(b.hasAttribute('data-choice-selected'), false);
  assert.equal(a.hasAttribute('data-choice-selected'), true);
  assert.equal(sent.at(-1).label, 'One column');
  click(dark);
  assert.equal(a.hasAttribute('data-choice-selected'), true, 'other groups keep their pick');
  assert.equal(sent.at(-1).group, '');
  click(a);
  assert.equal(sent.at(-1).selected, false);
  assert.equal(a.hasAttribute('data-choice-selected'), false);

  api.apply({ type: 'state', comment: true, markers: [] });
  const count = sent.length;
  click(a);
  assert.equal(sent.length, count, 'Comment mode posts no choices');
  api.apply({ type: 'state', comment: false, markers: [] });

  // A reloaded page gets its queued picks back.
  api.apply({ type: 'state', comment: false, markers: [], choices: [{ group: 'layout', choice: 'b' }] });
  assert.equal(b.hasAttribute('data-choice-selected'), true);
  assert.equal(dark.hasAttribute('data-choice-selected'), false);
});

test('page messages are shape-checked, bounded, and fail closed on masks', () => {
  assert.equal(visualizeFeedbackPageMessage({ type: 'ready' }), null, 'untagged messages are ignored');
  assert.deepEqual(visualizeFeedbackPageMessage({ ...tag, type: 'ready' }), { type: 'ready' });
  assert.equal(visualizeFeedbackPageMessage({ ...tag, type: 'pin', pin: { note: 'x', selector: 'a' } }), null);
  assert.equal(visualizeFeedbackPageMessage({ ...tag, type: 'choice', choice: '' }), null);
  assert.equal(visualizeFeedbackPageMessage({ ...tag, type: 'picked', pick: { selector: 'a' } }), null, 'needs its id');
  const picked = (pick) =>
    visualizeFeedbackPageMessage({ ...tag, type: 'picked', id: 'r', pick: { selector: 'a', ...pick } }).pick;
  const pick = picked({
    role: 'spaceship',
    name: 'n'.repeat(200),
    html: 'x'.repeat(2000),
    styles: { color: 'red', 'bad key!': 'x', width: 3 },
    box: { x: 1.234, y: 'no', width: -5, height: 4 },
    view: null,
    masks: [{ x: 1, y: 1, width: 1, height: 1 }],
    path: [{ selector: 'main', role: 'section', name: 'Main' }],
    child: { selector: '', role: 'text' },
  });
  assert.equal(pick.role, 'box', 'an unknown kind reads as a box');
  assert.equal(pick.name.length, 80);
  assert.deepEqual(pick.path, [{ selector: 'main', role: 'section', name: 'Main' }]);
  assert.equal(pick.child, null, 'a node needs its selector');
  assert.deepEqual(picked({ path: [{ selector: 'main' }, 'junk'] }).path, [], 'a broken path is dropped whole');
  assert.equal(picked({ path: Array.from({ length: 9 }, (_, i) => ({ selector: `s${i}` })) }).path.length, 4);
  assert.equal(pick.html.length, 600);
  assert.deepEqual(pick.styles, { color: 'red' });
  assert.deepEqual(pick.box, { x: 1.23, y: 0, width: 0, height: 4 });
  assert.deepEqual(pick.view, { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(pick.masks, [{ x: 1, y: 1, width: 1, height: 1 }]);
  assert.equal(pick.masksOverflow, false);

  const mask = { x: 1, y: 1, width: 1, height: 1 };
  for (const overflowing of [
    { masks: new Array(MAX_VISUALIZE_MASKS + 1).fill(mask) },
    { masks: [mask], masksOverflow: true },
    { masks: 'none' },
    {},
  ]) {
    const result = picked(overflowing);
    assert.equal(result.masksOverflow, true);
    assert.deepEqual(result.masks, []);
  }
});

test('the page scrolls over nested boxes: their overscroll containment is released', async (t) => {
  const { document, frames } = page(
    t,
    '<div class="dialog-body" style="overflow:auto;overscroll-behavior:contain">x</div>'
  );
  await frames();
  const css = [...document.querySelectorAll('style[data-mixdog-visualize]')].map((node) => node.textContent).join('\n');
  assert.match(css, /@layer mixdog-visualize-scroll\{body \*\{overscroll-behavior:auto!important\}\}/);
});

test('a remote pane page carries the script first in its head', () => {
  const html = withVisualizeFeedbackScript(
    '<!doctype html><html lang="en"><head data-x="1"><title>t</title></head><body></body></html>'
  );
  assert.match(html, /^<!doctype html><html lang="en"><head data-x="1"><script>\(\(function \(target\)/);
  assert.match(html, /\(window\.parent\)<\/script><title>/);
  assert.doesNotMatch(html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>')), /<\/script/i);
  assert.match(withVisualizeFeedbackScript('<p>bare</p>'), /^<script>.*<\/script><p>bare<\/p>$/s);
});

test('the page reports its mx-tweaks block and applies root overrides the panel sends', async (t) => {
  const block = JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]);
  const { sent, window, document, api, frames } = page(
    t,
    `<script type="application/json" id="mx-tweaks">${block}</script>`
  );
  document.documentElement.setAttribute('data-density', 'cozy');
  await frames();
  assert.deepEqual(sent[1], { type: 'tweaks', raw: block, ...tag });

  api.apply({
    type: 'tweaks',
    ops: [
      { var: '--accent', value: '#ff0000' },
      { attr: 'data-density', value: 'compact' },
      // Names outside the contract and malformed ops are ignored.
      { var: 'color', value: 'red' },
      { attr: 'onclick', value: 'alert(1)' },
      { attr: 'data-x', value: 3 },
      null,
    ],
  });
  const root = document.documentElement;
  assert.equal(root.style.getPropertyValue('--accent'), '#ff0000');
  assert.equal(root.getAttribute('data-density'), 'compact');
  assert.equal(root.style.getPropertyValue('color'), '');
  assert.equal(root.hasAttribute('onclick'), false);

  // Back to the default removes the override; an attribute the page itself set returns to that.
  api.apply({
    type: 'tweaks',
    ops: [
      { var: '--accent', value: null },
      { attr: 'data-density', value: null },
    ],
  });
  assert.equal(root.style.getPropertyValue('--accent'), '');
  assert.equal(root.getAttribute('data-density'), 'cozy');

  // A malformed block is logged by the page (the desktop reports console errors as page problems).
  const logged = [];
  window.console.error = (...args) => logged.push(args.join(' '));
  api.apply({ type: 'tweaks-problem', reason: 'the block is not valid JSON' });
  assert.deepEqual(logged, ['tweaks: the block is not valid JSON']);
});

test('page messages: a tweaks report is bounded text or null', () => {
  assert.deepEqual(visualizeFeedbackPageMessage({ ...tag, type: 'tweaks', raw: '[]' }), { type: 'tweaks', raw: '[]' });
  assert.deepEqual(visualizeFeedbackPageMessage({ ...tag, type: 'tweaks', raw: 3 }), { type: 'tweaks', raw: null });
  assert.equal(visualizeFeedbackPageMessage({ ...tag, type: 'tweaks', raw: 'x'.repeat(50_000) }).raw.length, 20_000);
});
test('the page answers inspect with a bounded reading and highlights an element for the Elements list', async (t) => {
  const { window, sent, api, frames, overlay } = page(
    t,
    '<main><button id="go" aria-label="Go">Go</button><input type="password" aria-label="Pass" value="hunter2"></main>'
  );
  await frames();
  sent.length = 0;
  // jsdom has no layout: give every element a box.
  window.Element.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 100,
    height: 30,
    right: 100,
    bottom: 30,
  });
  api.apply({ type: 'inspect', id: 'i1', selector: 'main' });
  const answer = sent.find((message) => message.type === 'inspected');
  assert.equal(answer.id, 'i1');
  assert.equal(answer.inspection.elements.find((element) => element.tag === 'input').value, '[redacted]');
  assert.ok(!JSON.stringify(answer).includes('hunter2'));
  // The renderer's parser accepts it, and bounds a forged one.
  const parsed = visualizeFeedbackPageMessage(answer);
  assert.equal(parsed.type, 'inspected');
  assert.equal(parsed.inspection.elements.length, 2);
  assert.equal(visualizeFeedbackPageMessage({ ...answer, inspection: { nonsense: true } }), null);
  api.apply({ type: 'inspect', id: 'i2', selector: ':::' });
  assert.deepEqual(sent.at(-1).inspection, { error: 'invalid selector' });

  window.document.getElementById('go').getBoundingClientRect = () => ({
    left: 5,
    top: 6,
    width: 40,
    height: 20,
    right: 45,
    bottom: 26,
  });
  api.apply({ type: 'highlight', selector: '#go' });
  await frames();
  assert.equal(overlay().querySelectorAll('.hover').length, 1);
  api.apply({ type: 'highlight', selector: null });
  await frames();
  assert.equal(overlay().querySelectorAll('.hover').length, 0);
});
