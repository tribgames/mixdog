import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import React, { act, useState } from 'react';

import { VISUALIZE_FEEDBACK_TAG } from '../shared/visualize-feedback.ts';
import { installTestDom } from './test-support/test-dom.mjs';

/** Live resize observers: a test lays the pane out anew and calls them. */
const resizeObservers = new Set();
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    resizeObservers.add(this);
  }
  disconnect() {
    resizeObservers.delete(this);
  }
}

// The panel window's own activation must not matter any more: keep it on.
installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: [
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'HTMLVideoElement',
    'HTMLIFrameElement',
    'HTMLTextAreaElement',
    'HTMLInputElement',
  ],
  globals: {
    navigator: { userAgent: 'node', userActivation: { isActive: true } },
    ResizeObserver: FakeResizeObserver,
  },
});
/** Gestures main saw, per pane: each choice must spend one. */
const gestures = [];
const consumed = [];
window.mixdogDesktop = {
  async visualizeConsumeGesture(target) {
    consumed.push(target);
    const index = gestures.findIndex((gesture) => JSON.stringify(gesture) === JSON.stringify(target));
    if (index < 0) return false;
    gestures.splice(index, 1);
    return true;
  },
};
const { createRoot } = await import('react-dom/client');
const {
  captureVisualizeElementCrop,
  captureVisualizeRegionCrop,
  requestVisualizeDescription,
  useVisualizeFeedbackBridge,
  VisualizeCommentLayer,
  VISUALIZE_COMMENT_HINT_SEEN_KEY,
  announceVisualizeCommentMode,
  visualizeCommentHintText,
  visualizeCardPlace,
} = await import('./VisualizeFeedback.tsx');
const { VISUALIZE_COMMENT_KINDS } = await import('../shared/visualize-comment-kinds.ts');
const {
  addVisualizePin,
  peekVisualizePinOpen,
  removeVisualizePin,
  requestVisualizePinOpen,
  resetVisualizeFeedback,
  takeVisualizePinOpen,
  visualizeFeedbackFor,
} = await import('./visualize-feedback-store.ts');
const { resetVisualizeChoiceProposals, VISUALIZE_PROPOSAL_MIN_INTERVAL_MS } = await import(
  './visualize-feedback-gate.ts'
);
const consumeGesture = window.mixdogDesktop.visualizeConsumeGesture;

// jsdom marks every script-dispatched event untrusted; a real user click is
// stood in for by dispatching through jsdom's internals with the flag set.
const jsdomUtils = createRequire(import.meta.url)('jsdom/lib/jsdom/living/generated/utils.js');
async function userEvent(node, event) {
  const impl = jsdomUtils.implForWrapper(event);
  impl.isTrusted = true;
  await act(async () => jsdomUtils.implForWrapper(node)._dispatch(impl));
}
const mouse = (type, init = {}) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
const userClick = (node, init) => userEvent(node, mouse('click', init));
/** A trusted drag from one point to another (the click that follows included). */
async function userDrag(node, [x1, y1], [x2, y2]) {
  await userEvent(node, mouse('pointerdown', { clientX: x1, clientY: y1 }));
  await userEvent(node, mouse('pointermove', { clientX: x2, clientY: y2 }));
  await userEvent(node, mouse('pointerup', { clientX: x2, clientY: y2 }));
  await userClick(node, { clientX: x2, clientY: y2 });
}
async function type(textarea, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const sized = (node, left, top, width, height) => {
  node.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
};
async function scriptClick(node) {
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

const tab = {
  id: 'v1',
  label: 'Mockup',
  revision: 0,
  panes: [{ kind: 'html', label: 'index.html', target: 'site/index.html', url: '', file: 'site/index.html' }],
};
const tagged = (message) => ({ ...message, [VISUALIZE_FEEDBACK_TAG]: 1 });
const pick = {
  selector: 'h1',
  label: 'h1',
  html: '<h1>x</h1>',
  styles: {},
  box: { x: 0, y: 0, width: 10, height: 10 },
  view: { x: 0, y: 0, width: 10, height: 10 },
  masks: [],
};
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(t, comment, shown = tab) {
  resetVisualizeFeedback();
  resetVisualizeChoiceProposals();
  window.mixdogDesktop.visualizeConsumeGesture = consumeGesture;
  gestures.length = 0;
  consumed.length = 0;
  const exits = [];
  function Harness() {
    const [body, setBody] = useState(null);
    useVisualizeFeedbackBridge({ sessionId: 's1', tab: shown, body, comment, setComment: (on) => exits.push(on) });
    return React.createElement(
      'div',
      { ref: setBody },
      React.createElement(
        'div',
        { 'data-visualize-pane': '0' },
        React.createElement(
          'div',
          { className: 'visualize-pane-content' },
          React.createElement('iframe', { title: 'page' }),
          React.createElement(VisualizeCommentLayer, {
            sessionId: 's1',
            tab: shown,
            pane: shown.panes[0],
            index: 0,
            comment,
          })
        )
      )
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  const frame = host.querySelector('iframe');
  const toPage = [];
  frame.contentWindow.postMessage = (message) => toPage.push(message);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  const fromPage = async (message, source = frame.contentWindow) => {
    await act(async () => window.dispatchEvent(new window.MessageEvent('message', { data: tagged(message), source })));
    await settle();
  };
  return { host, frame, toPage, fromPage, exits };
}

test('a page cannot make a pin: unsolicited answers and old-style pins are dropped, untrusted clicks ask nothing', async (t) => {
  const { host, toPage, fromPage } = await mount(t, true);
  const layer = host.querySelector('.visualize-region-layer.is-commenting');
  assert.ok(layer, 'Comment mode lays the panel layer over the page');

  await fromPage({ type: 'picked', id: 'guessed', pick });
  await fromPage({ type: 'pin', pin: { ...pick, note: 'forged' } });
  assert.equal(host.querySelector('.visualize-region-note'), null, 'no note box without a request');
  assert.deepEqual(visualizeFeedbackFor('s1').pins, []);

  await act(async () => layer.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 3, clientY: 3 })));
  assert.equal(
    toPage.some((message) => message.type === 'pick'),
    false,
    'a script-dispatched click is not a user click'
  );
});

const choice = { type: 'choice', group: 'layout', choice: 'b', label: 'Two columns', selected: true };
const here = { sessionId: 's1', tabId: 'v1', pane: 0 };
const bar = (host) => host.querySelector('.visualize-choice-confirm');
const buttons = (host) => bar(host).querySelectorAll('button');
const queued = () => visualizeFeedbackFor('s1').choices.map((entry) => [entry.group, entry.choice, entry.file]);

test('a gesture main saw in that pane queues one choice directly; a burst after it only proposes', async (t) => {
  const { host, fromPage } = await mount(t, false);
  // A gesture in another pane cannot be spent here.
  gestures.push({ ...here, pane: 1 });
  gestures.push(here);
  await fromPage(choice);
  assert.deepEqual(consumed.at(-1), here);
  assert.deepEqual(queued(), [['layout', 'b', 'site/index.html']]);
  assert.equal(bar(host), null, 'no bar when the gesture was seen');

  await fromPage({ ...choice, group: 'theme', choice: 'dark', label: 'Dark' });
  assert.equal(queued().length, 1, 'the same gesture is not spent twice');
  assert.match(bar(host).textContent, /Dark/);

  // From some other window: ignored whatever its shape, and no gesture is spent.
  gestures.push(here);
  const spent = consumed.length;
  await fromPage({ ...choice, group: 'x' }, window);
  assert.equal(consumed.length, spent);
});

test('without a gesture the panel asks: only a trusted click on its own button queues the choice', async (t) => {
  const { host, fromPage } = await mount(t, false);
  // The user is typing in the composer; the page proposes on its own.
  await fromPage(choice);
  assert.deepEqual(queued(), [], 'nothing queued from the page alone');
  assert.equal(bar(host).querySelector('.visualize-choice-confirm-text').textContent, 'Choose Two columns?');
  const [confirm] = buttons(host);

  await scriptClick(confirm);
  assert.deepEqual(queued(), [], 'a script-made click does not confirm');
  assert.ok(bar(host), 'the bar stays');

  await userClick(confirm);
  assert.deepEqual(queued(), [['layout', 'b', 'site/index.html']]);
  assert.equal(bar(host), null);

  // A paired remote client has no gesture source at all: same bar, same rule.
  window.mixdogDesktop.visualizeConsumeGesture = undefined;
  await new Promise((resolve) => setTimeout(resolve, VISUALIZE_PROPOSAL_MIN_INTERVAL_MS));
  await fromPage({ ...choice, group: 'theme', choice: 'dark', label: 'Dark' });
  assert.match(bar(host).textContent, /Choose Dark\?/);
  await userClick(buttons(host)[0]);
  assert.deepEqual(queued().at(-1), ['theme', 'dark', 'site/index.html']);
});

test('a proposal flood updates the bar at most once per interval, and Cancel resets the page marks', async (t) => {
  const { host, fromPage, toPage } = await mount(t, false);
  await fromPage(choice);
  const before = toPage.length;
  for (let i = 0; i < 5; i += 1) await fromPage({ ...choice, choice: `c${i}`, label: `Flood ${i}` });
  assert.match(bar(host).textContent, /Two columns/, 'the bar is not replaced inside the interval');
  assert.ok(
    toPage.slice(before).filter((message) => message.type === 'state' && Array.isArray(message.choices)).length >= 5,
    'every dropped proposal puts the page marks back'
  );

  // Past the interval the latest proposal replaces the bar.
  await new Promise((resolve) => setTimeout(resolve, VISUALIZE_PROPOSAL_MIN_INTERVAL_MS));
  await fromPage({ ...choice, choice: 'a', label: 'One column' });
  assert.match(bar(host).textContent, /One column/);
  assert.equal(host.querySelectorAll('.visualize-choice-confirm').length, 1, 'one bar per pane');

  const marks = toPage.length;
  await scriptClick(buttons(host)[1]);
  assert.equal(bar(host), null);
  assert.deepEqual(queued(), []);
  const { nouns, ...reset } = toPage.at(-1);
  assert.deepEqual(reset, { type: 'state', comment: false, markers: [], choices: [], [VISUALIZE_FEEDBACK_TAG]: 1 });
  assert.equal(nouns.button, 'Button', 'the page gets the element nouns for its hover label');
  assert.ok(toPage.length > marks);
});

test('Comment mode drops page choices: no gesture spent, no bar', async (t) => {
  const { host, fromPage, exits } = await mount(t, true);
  gestures.push(here);
  await fromPage(choice);
  assert.deepEqual(visualizeFeedbackFor('s1').choices, []);
  assert.deepEqual(consumed, []);
  assert.equal(bar(host), null);
  await fromPage({ type: 'exit-comment' });
  assert.deepEqual(exits, [false]);
});

test('a crop re-describes the element: only the answer to its own request counts, within a short wait', async (t) => {
  const { frame, toPage, fromPage } = await mount(t, false);
  const asking = requestVisualizeDescription(frame, 'h1');
  const request = toPage.at(-1);
  assert.equal(request.type, 'describe');
  assert.equal(request.selector, 'h1');
  assert.match(request.id, /^[0-9a-f]{32}$/);
  await fromPage({ type: 'picked', id: 'other', pick: { ...pick, masks: [], masksOverflow: false } });
  await fromPage({ type: 'picked', id: request.id, pick: { ...pick, selector: 'h1' } }, window);
  const fresh = { ...pick, masks: [{ x: 1, y: 1, width: 2, height: 2 }] };
  await fromPage({ type: 'picked', id: request.id, pick: fresh });
  const answer = await asking;
  assert.deepEqual(answer.masks, fresh.masks);
  assert.equal(answer.masksOverflow, false);

  // No answer: null after the wait, so no crop.
  assert.equal(await requestVisualizeDescription(frame, 'h1'), null);
});

test('a crop is kept only if the page answers the same before and after the shot', async (t) => {
  const { frame } = await mount(t, false);
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  const view = { x: 10, y: 20, width: 100, height: 40 };
  const pinned = { ...pick, selector: 'form', view, box: view, masksOverflow: false };
  const mask = { x: 12, y: 22, width: 50, height: 10 };
  const describe = (overrides = {}) => ({ ...pinned, masks: [mask], ...overrides });
  /** The page's answers to successive describe requests (undefined: silent). */
  let answers = [];
  frame.contentWindow.postMessage = (message) => {
    if (message.type !== 'describe') return;
    const answer = answers.shift();
    if (!answer) return;
    setTimeout(() =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: tagged({ type: 'picked', id: message.id, pick: answer }),
          source: frame.contentWindow,
        })
      )
    );
  };
  const shots = [];
  const capture = async (area, masks) => {
    shots.push({ area, masks });
    return { data: 'PNG', mimeType: 'image/png', width: 1, height: 1 };
  };
  const crop = () => captureVisualizeElementCrop(frame, pinned, capture);

  answers = [describe(), describe()];
  assert.equal((await crop())?.data, 'PNG', 'unchanged page: the crop stays');
  assert.deepEqual(shots[0].masks, [mask], 'shot with the fresh pre-capture masks');

  for (const [label, after] of [
    ['a secret field appeared during the shot', describe({ masks: [mask, { ...mask, y: 40 }] })],
    ['a mask moved', describe({ masks: [{ ...mask, x: 13 }] })],
    ['the element moved', describe({ view: { ...view, y: 21 } })],
    ['the page box changed', describe({ box: { ...view, x: 11 } })],
    ['too many secret fields now', describe({ masks: [], masksOverflow: true })],
    ['another element answers', describe({ selector: 'main' })],
    ['no answer after the shot', undefined],
  ]) {
    answers = [describe(), after];
    assert.equal(await crop(), null, label);
  }

  // Before the shot: overflow, or no answer, means nothing is captured at all.
  const taken = shots.length;
  answers = [describe({ masks: [], masksOverflow: true })];
  assert.equal(await crop(), null);
  answers = [];
  assert.equal(await crop(), null);
  assert.equal(shots.length, taken);
});

test('a page reports its tweaks: controls appear, overrides reach the page, a malformed block is sent back to be logged', async (t) => {
  const { resetVisualizeTweakStore, setVisualizeTweakValue, visualizePaneTweaks } = await import(
    './visualize-tweaks-store.ts'
  );
  resetVisualizeTweakStore();
  const { toPage, fromPage } = await mount(t, false);
  const raw = JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]);
  const tweakMessages = () =>
    toPage.filter((message) => message.type === 'tweaks' || message.type === 'tweaks-problem');

  await fromPage({ type: 'tweaks', raw });
  const [accent] = visualizePaneTweaks('s1', 'v1', 0);
  assert.equal(accent?.id, 'accent');
  // Nothing moved yet: the page gets removals (its own CSS stands).
  assert.deepEqual(tweakMessages().at(-1).ops, [{ var: '--accent', value: null }]);

  await act(async () => {
    setVisualizeTweakValue('s1', 'v1', 0, 0, accent, '#2f6fed');
  });
  assert.deepEqual(tweakMessages().at(-1).ops, [{ var: '--accent', value: '#2f6fed' }], 'a change is applied live');

  // A malformed block: no controls, and the page is told to log the reason.
  await fromPage({ type: 'tweaks', raw: '[{"id":"x"}]' });
  assert.deepEqual(visualizePaneTweaks('s1', 'v1', 0), []);
  assert.match(tweakMessages().at(-1).reason, /control "x" type must be/);
  assert.equal(tweakMessages().at(-1).type, 'tweaks-problem');

  // Not from this pane's page: ignored.
  await fromPage({ type: 'tweaks', raw }, window);
  assert.deepEqual(visualizePaneTweaks('s1', 'v1', 0), []);
});

test('a page that announces ready again (a same-URL reload) gets its state and saved tweaks', async (t) => {
  const { resetVisualizeTweakStore, setVisualizeTweakValue, visualizePaneTweaks } = await import(
    './visualize-tweaks-store.ts'
  );
  resetVisualizeTweakStore();
  const { toPage, fromPage } = await mount(t, false);
  await fromPage({
    type: 'tweaks',
    raw: JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]),
  });
  const [accent] = visualizePaneTweaks('s1', 'v1', 0);
  await act(async () => setVisualizeTweakValue('s1', 'v1', 0, 0, accent, '#2f6fed'));

  // Ready alone replays nothing: the new document's own definitions come first.
  const before = toPage.length;
  await fromPage({ type: 'ready' });
  assert.deepEqual(
    toPage.slice(before).map((message) => message.type),
    ['state']
  );

  // A second document's ready inside the throttle is dropped, yet its tweaks
  // announcement (same definitions, same URL) still replays the saved override.
  const raw = JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]);
  const mark = toPage.length;
  await fromPage({ type: 'ready' });
  assert.equal(
    toPage.slice(mark).filter((message) => message.type === 'state').length,
    0,
    'the second ready inside the throttle window got no state reply'
  );
  await fromPage({ type: 'tweaks', raw });
  const replayed = toPage.slice(mark).filter((message) => message.type === 'tweaks');
  assert.ok(replayed.length >= 1);
  for (const message of replayed) {
    assert.deepEqual(
      message.ops,
      [{ var: '--accent', value: '#2f6fed' }],
      'the saved override is replayed (and idempotent)'
    );
  }
});

test('a reloaded page that declares no tweaks keeps its own values: nothing is posted from the previous document', async (t) => {
  const { resetVisualizeTweakStore, setVisualizeTweakValue, visualizePaneTweaks } = await import(
    './visualize-tweaks-store.ts'
  );
  resetVisualizeTweakStore();
  const { toPage, fromPage } = await mount(t, false);
  await fromPage({
    type: 'tweaks',
    raw: JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]),
  });
  const [accent] = visualizePaneTweaks('s1', 'v1', 0);
  await act(async () => setVisualizeTweakValue('s1', 'v1', 0, 0, accent, '#2f6fed'));

  const before = toPage.length;
  await fromPage({ type: 'ready' });
  assert.equal(
    toPage.slice(before).some((message) => message.type === 'tweaks'),
    false,
    'no stale override at ready'
  );
  // The replacement declares none (its own inline --accent must stand).
  await fromPage({ type: 'tweaks', raw: null });
  assert.deepEqual(
    toPage.slice(before).filter((message) => message.type === 'tweaks'),
    [],
    'no removal or override is posted to the replacement document'
  );
  assert.deepEqual(visualizePaneTweaks('s1', 'v1', 0), []);
});

/** Waits out a pin's crop attempt (the page answers nothing here, so no crop). */
const cropSettled = () => act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
const card = (host) => host.querySelector('.visualize-region-note');
const button = (host, text) => [...card(host).querySelectorAll('button')].find((node) => node.textContent === text);

test('an element click opens a card with a human title and crumbs that widen the target; the pin keeps no selector label', async (t) => {
  const { host, frame, toPage, fromPage } = await mount(t, true);
  const layer = host.querySelector('.visualize-region-layer');
  sized(layer, 0, 0, 400, 300);
  sized(frame, 0, 0, 400, 300);
  const save = {
    ...pick,
    selector: '#save',
    role: 'button',
    name: 'Save',
    view: { x: 300, y: 250, width: 60, height: 24 },
    masksOverflow: false,
    path: [{ selector: '#card', role: 'section', name: 'Settings' }],
    child: { selector: '#save > span', role: 'text', name: 'Save' },
  };
  await userClick(layer, { clientX: 310, clientY: 260 });
  const asked = toPage.findLast((message) => message.type === 'pick');
  assert.deepEqual([asked.x, asked.y], [310, 260]);
  await fromPage({ type: 'picked', id: asked.id, pick: save });
  assert.equal(card(host).querySelector('.visualize-region-note-label').textContent, 'Button · Save');
  assert.equal(card(host).querySelector('.visualize-region-note-number').textContent, '1');
  assert.deepEqual(
    [...card(host).querySelectorAll('.visualize-region-crumbs button')].map((node) => [
      node.textContent,
      node.className,
    ]),
    [
      ['Section', ''],
      ['Button', 'is-current'],
      ['Text', ''],
    ]
  );
  // jsdom lays nothing out: the card is measured 0 tall, so it fits below.
  assert.deepEqual([card(host).style.left, card(host).style.top], ['104px', '284px']);
  assert.deepEqual(toPage.findLast((message) => message.type === 'select').selector, '#save');

  await type(card(host).querySelector('textarea'), 'Bigger');
  await userClick(card(host).querySelector('.visualize-region-crumbs button'));
  const widen = toPage.at(-1);
  assert.deepEqual([widen.type, widen.selector], ['describe', '#card']);
  await fromPage({
    type: 'picked',
    id: widen.id,
    pick: { ...save, selector: '#card', role: 'section', name: 'Settings', path: [], child: null },
  });
  assert.equal(card(host).querySelector('.visualize-region-note-label').textContent, 'Section · Settings');
  assert.equal(card(host).querySelector('textarea').value, 'Bigger', 'widening keeps the note');

  await act(async () => button(host, 'Add').click());
  const [pin] = visualizeFeedbackFor('s1').pins;
  assert.equal(pin.label, 'Section · Settings');
  assert.deepEqual(
    { ...pin.target, html: undefined, styles: undefined },
    { type: 'element', selector: '#card', html: undefined, styles: undefined, box: save.box, path: [] }
  );
  assert.equal(card(host), null);
  await cropSettled();
  assert.equal(visualizeFeedbackFor('s1').pins[0].image, undefined, 'no capture here: the pin stays, without a crop');

  // Clicking the pinned element reopens its card: edit, then delete.
  await userClick(layer, { clientX: 20, clientY: 20 });
  await fromPage({
    type: 'picked',
    id: toPage.findLast((message) => message.type === 'pick').id,
    pick: { ...save, selector: '#card' },
  });
  assert.equal(card(host).querySelector('textarea').value, 'Bigger');
  await type(card(host).querySelector('textarea'), 'Much bigger');
  await act(async () => button(host, 'Save').click());
  assert.equal(visualizeFeedbackFor('s1').pins[0].note, 'Much bigger');
  await userClick(layer, { clientX: 20, clientY: 20 });
  await fromPage({
    type: 'picked',
    id: toPage.findLast((message) => message.type === 'pick').id,
    pick: { ...save, selector: '#card' },
  });
  await act(async () => button(host, 'Delete').click());
  assert.deepEqual(visualizeFeedbackFor('s1').pins, []);
});

test('a drag on an HTML pane is a region: it counts the elements inside and makes no pick', async (t) => {
  const { host, frame, toPage, fromPage } = await mount(t, true);
  const layer = host.querySelector('.visualize-region-layer');
  sized(layer, 0, 0, 400, 300);
  sized(frame, 0, 0, 400, 300);
  // Under the threshold it is still a click.
  await userDrag(layer, [10, 10], [13, 13]);
  assert.equal(toPage.filter((message) => message.type === 'pick').length, 1);
  assert.equal(
    toPage.some((message) => message.type === 'measure'),
    false
  );

  await userDrag(layer, [40, 30], [240, 130]);
  assert.equal(toPage.filter((message) => message.type === 'pick').length, 1, 'the drag ends in no pick');
  const measure = toPage.findLast((message) => message.type === 'measure');
  assert.deepEqual(measure.rect, { x: 40, y: 30, width: 200, height: 100 });
  assert.equal(card(host).querySelector('.visualize-region-note-label').textContent, 'Region');
  await fromPage({ type: 'measured', id: measure.id, count: 2, masks: [], masksOverflow: false });
  assert.equal(card(host).querySelector('.visualize-region-note-label').textContent, 'Region · 2 elements');
  assert.equal(card(host).querySelector('.visualize-region-crumbs'), null);

  await type(card(host).querySelector('textarea'), 'Tighter');
  await act(async () => button(host, 'Add').click());
  const [pin] = visualizeFeedbackFor('s1').pins;
  assert.equal(pin.label, 'Region · 2 elements');
  assert.deepEqual(pin.target, { type: 'region', view: { x: 0.1, y: 0.1, width: 0.5, height: 0.3333 }, elements: 2 });
  await cropSettled();

  // The region's number is drawn by the layer; clicking it reopens the card.
  assert.equal(host.querySelector('.visualize-region-box .visualize-region-number').textContent, '1');
  await userClick(layer, { clientX: 100, clientY: 60 });
  assert.equal(card(host).querySelector('textarea').value, 'Tighter');
  assert.ok(button(host, 'Delete'));
});

test('an HTML region keeps the element it lies in: the page draws it, its number and its card reopen it where it is now', async (t) => {
  const { host, frame, toPage, fromPage } = await mount(t, true);
  const layer = host.querySelector('.visualize-region-layer');
  sized(layer, 0, 0, 400, 300);
  sized(frame, 0, 0, 400, 300);
  await userDrag(layer, [40, 30], [240, 130]);
  const measure = toPage.findLast((message) => message.type === 'measure');
  const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  await fromPage({
    type: 'measured',
    id: measure.id,
    count: 2,
    masks: [],
    masksOverflow: false,
    anchor: { selector: '#card', rect, path: [{ selector: '#card', role: 'section', name: 'Settings' }] },
  });
  await type(card(host).querySelector('textarea'), 'Tighter');
  await act(async () => button(host, 'Add').click());
  await cropSettled();
  const [pin] = visualizeFeedbackFor('s1').pins;
  assert.deepEqual(pin.target.anchor, { selector: '#card', rect, path: ['Section · Settings'] });

  // The page draws it from the element's live box; the layer does not.
  assert.equal(host.querySelectorAll('.visualize-region-box').length, 0);
  assert.deepEqual(toPage.findLast((message) => message.type === 'state').markers, [
    { n: 1, selector: '#card', region: { pin: pin.id, rect } },
  ]);

  // Its number in the page reopens it, the card beside where it is now
  // (the element reflowed to 400×200 at the top) and the page outlining it.
  await userClick(layer, { clientX: 92, clientY: 42 });
  const asked = toPage.findLast((message) => message.type === 'pick');
  await fromPage({
    type: 'picked',
    id: asked.id,
    pin: pin.id,
    pick: { ...pick, selector: '#card', view: { x: 0, y: 0, width: 400, height: 200 } },
  });
  assert.equal(card(host).querySelector('textarea').value, 'Tighter');
  assert.ok(button(host, 'Delete'));
  assert.deepEqual([card(host).style.left, card(host).style.top], ['100px', '160px']);
  assert.equal(toPage.findLast((message) => message.type === 'select').pin, pin.id);
  await act(async () => button(host, 'Cancel').click());
  assert.equal(toPage.findLast((message) => message.type === 'select').pin, null);

  // Its composer card asks the page for the element and opens there.
  await act(async () => requestVisualizePinOpen('s1', pin.id));
  const described = toPage.findLast((message) => message.type === 'describe');
  assert.equal(described.selector, '#card');
  assert.equal(card(host), null, 'it waits for the page');
  await fromPage({
    type: 'picked',
    id: described.id,
    pick: { ...pick, selector: '#card', view: { x: 0, y: 100, width: 400, height: 200 } },
  });
  assert.equal(card(host).querySelector('textarea').value, 'Tighter');
  assert.deepEqual([card(host).style.left, card(host).style.top], ['100px', '260px']);
});

test('a region crop of an HTML page masks its secret fields and needs the same answer after the shot', async (t) => {
  const { frame } = await mount(t, false);
  sized(frame, 10, 20, 400, 300);
  const mask = { x: 5, y: 5, width: 20, height: 10 };
  let answers = [];
  frame.contentWindow.postMessage = (message) => {
    if (message.type !== 'measure') return;
    const answer = answers.shift();
    if (answer)
      setTimeout(() =>
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data: tagged({ type: 'measured', id: message.id, ...answer }),
            source: frame.contentWindow,
          })
        )
      );
  };
  const shots = [];
  const capture = async (area, masks) => {
    shots.push({ area, masks });
    return { data: 'PNG', mimeType: 'image/png', width: 1, height: 1 };
  };
  const area = { x: 0, y: 0, width: 100, height: 50 };
  const same = { count: 1, masks: [mask], masksOverflow: false };
  answers = [same, same];
  assert.equal((await captureVisualizeRegionCrop(frame, area, capture))?.data, 'PNG');
  assert.deepEqual(shots[0], { area: { x: 10, y: 20, width: 100, height: 50 }, masks: [{ ...mask, x: 15, y: 25 }] });
  answers = [same, { ...same, masks: [] }];
  assert.equal(await captureVisualizeRegionCrop(frame, area, capture), null, 'a field changed during the shot');
  answers = [{ count: 1, masks: [], masksOverflow: true }];
  const taken = shots.length;
  assert.equal(await captureVisualizeRegionCrop(frame, area, capture), null, 'too many secret fields: no shot');
  assert.equal(shots.length, taken);
});

test('a video pane pauses for comments, keeps the pin time and shows it on the timeline', async (t) => {
  resetVisualizeFeedback();
  const videoTab = {
    id: 'v9',
    label: 'Clip',
    revision: 0,
    panes: [{ kind: 'video', label: 'intro.mp4', target: 'clips/intro.mp4', url: '', file: 'clips/intro.mp4' }],
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  let current = 12.4;
  const calls = [];
  const render = (comment) =>
    act(async () =>
      root.render(
        React.createElement(
          'section',
          { className: 'visualize-pane' },
          React.createElement(
            'div',
            { className: 'visualize-pane-content' },
            React.createElement('video', { ref: stub }),
            React.createElement(VisualizeCommentLayer, {
              sessionId: 's1',
              tab: videoTab,
              pane: videoTab.panes[0],
              index: 0,
              comment,
            })
          )
        )
      )
    );
  let video = null;
  function stub(node) {
    if (!node || node === video) return;
    video = node;
    let paused = false;
    Object.defineProperties(node, {
      currentTime: {
        get: () => current,
        set: (value) => {
          calls.push(['seek', value]);
          current = value;
        },
      },
      duration: { get: () => 30 },
      paused: { get: () => paused },
      pause: {
        value: () => {
          calls.push(['pause']);
          paused = true;
        },
      },
      play: {
        value: async () => {
          calls.push(['play']);
          paused = false;
        },
      },
    });
  }
  await render(false);
  assert.equal(host.querySelector('.visualize-region-layer'), null, 'nothing over the video until Comment mode');
  await render(true);
  assert.deepEqual(calls, [['pause']], 'Comment mode pauses the video');
  assert.ok(host.querySelector('.visualize-media-bar'));

  const layer = host.querySelector('.visualize-region-layer');
  sized(layer, 0, 0, 400, 300);
  await userDrag(layer, [100, 200], [300, 260]);
  assert.equal(card(host).querySelector('.visualize-region-note-label').textContent, 'Video 0:12 · Region');
  await type(card(host).querySelector('textarea'), 'Move the subtitle up');
  await act(async () => button(host, 'Add').click());
  await cropSettled();
  const [pin] = visualizeFeedbackFor('s1').pins;
  assert.equal(pin.paneKind, 'video');
  assert.equal(pin.target.time, 12.4);
  assert.equal(pin.label, 'Video 0:12 · Region');

  // The pin sits on the timeline; clicking it seeks there, paused.
  current = 3;
  await act(async () => video.dispatchEvent(new window.Event('timeupdate')));
  assert.equal(host.querySelectorAll('.visualize-region-box').length, 0, 'away from its time the region is not drawn');
  const marker = host.querySelector('.visualize-media-pin');
  assert.equal(marker.textContent, '1');
  assert.match(marker.style.left, /^41\.33/);
  calls.length = 0;
  await act(async () => marker.click());
  assert.deepEqual(calls, [['pause'], ['seek', 12.4]]);
  await act(async () => video.dispatchEvent(new window.Event('seeked')));
  assert.equal(host.querySelectorAll('.visualize-region-box').length, 1, 'at its time the region shows again');

  // Space plays and pauses, ←/→ step through the video.
  calls.length = 0;
  await userEvent(document.body, new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await userEvent(
    document.body,
    new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
  );
  assert.deepEqual(calls, [['play'], ['pause'], ['seek', 11.4]]);
});

const queuedPin = (target, note) =>
  addVisualizePin('s1', {
    tabId: 'v1',
    tabLabel: 'Mockup',
    pane: 0,
    paneKind: 'html',
    file: 'site/index.html',
    note,
    label: 'Section · Settings',
    target,
  });

test('a pin card asks the panel to reopen that pin: Comment mode comes on, an element is described again, a region opens at once', async (t) => {
  const { host, toPage, fromPage, exits } = await mount(t, true);
  const element = queuedPin(
    { type: 'element', selector: '#card', html: '', styles: {}, box: pick.box, path: [] },
    'Bigger'
  );
  const region = queuedPin({ type: 'region', view: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 } }, 'Tighter');
  sized(host.querySelector('.visualize-region-layer'), 0, 0, 400, 300);

  await act(async () => requestVisualizePinOpen('s1', region.id));
  assert.equal(card(host).querySelector('textarea').value, 'Tighter');
  assert.equal(takeVisualizePinOpen('s1', 'v1', 0), null, 'the request is spent once the layer takes it');

  await act(async () => requestVisualizePinOpen('s1', element.id));
  const asked = toPage.findLast((message) => message.type === 'describe');
  assert.equal(asked.selector, '#card');
  await fromPage({ type: 'picked', id: asked.id, pick: { ...pick, selector: '#card' } });
  assert.equal(card(host).querySelector('textarea').value, 'Bigger');
  assert.deepEqual(exits, [], 'Comment mode was already on');
});

test('a pin card request for an element waits for its page: a page that gets ready later is asked again', async (t) => {
  const { host, toPage, fromPage } = await mount(t, true);
  const element = queuedPin(
    { type: 'element', selector: '#late', html: '', styles: {}, box: pick.box, path: [] },
    'Later'
  );
  sized(host.querySelector('.visualize-region-layer'), 0, 0, 400, 300);
  await act(async () => requestVisualizePinOpen('s1', element.id));
  const first = toPage.findLast((message) => message.type === 'describe');
  assert.equal(first.selector, '#late');
  assert.ok(peekVisualizePinOpen('s1', 'v1', 0), 'the request stays until the page answers');
  assert.equal(card(host), null);

  // The page was not running yet: once it announces itself it is asked again.
  await fromPage({ type: 'ready' });
  const again = toPage.findLast((message) => message.type === 'describe');
  assert.notEqual(again.id, first.id);
  assert.equal(again.selector, '#late');
  await fromPage({ type: 'picked', id: first.id, pick: { ...pick, selector: '#late' } });
  assert.equal(card(host), null, 'the superseded request is not answered');
  await fromPage({ type: 'picked', id: again.id, pick: { ...pick, selector: '#late' } });
  assert.equal(card(host).querySelector('textarea').value, 'Later');
  assert.equal(peekVisualizePinOpen('s1', 'v1', 0), null, 'spent once the card opened');
});

test('the comment card is clamped inside the pane, over its target when neither side has room', async (t) => {
  const pane = { width: 400, height: 300 };
  const size = { width: 288, height: 120 };
  assert.deepEqual(visualizeCardPlace({ x: 10, y: 20, width: 50, height: 20 }, pane, size), { left: 10, top: 50 });
  assert.deepEqual(visualizeCardPlace({ x: 10, y: 200, width: 50, height: 20 }, pane, size), { left: 10, top: 70 });
  assert.deepEqual(visualizeCardPlace({ x: 300, y: 6, width: 90, height: 288 }, pane, size), { left: 104, top: 172 });
  assert.deepEqual(visualizeCardPlace({ x: 0, y: 0, width: 10, height: 10 }, pane, { width: 288, height: 400 }), {
    left: 8,
    top: 8,
  });

  const measure = window.HTMLFormElement.prototype.getBoundingClientRect;
  window.HTMLFormElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 288,
    height: 120,
    right: 288,
    bottom: 120,
  });
  t.after(() => {
    window.HTMLFormElement.prototype.getBoundingClientRect = measure;
  });
  const { host } = await mount(t, true);
  const tall = queuedPin({ type: 'region', view: { x: 0.75, y: 0.02, width: 0.225, height: 0.96 } }, 'Tall');
  sized(host.querySelector('.visualize-region-layer'), 0, 0, 400, 300);
  await act(async () => requestVisualizePinOpen('s1', tall.id));
  assert.equal(card(host).style.left, '104px');
  assert.equal(card(host).style.top, '172px');
});

test('Comment mode keys go to the pane the pointer is over, not the first one', async (t) => {
  resetVisualizeFeedback();
  const twoTab = { ...tab, id: 'v2', panes: [tab.panes[0], { ...tab.panes[0], label: 'b.html' }] };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  const cell = (index) =>
    React.createElement(
      'div',
      { key: index, 'data-visualize-pane': String(index) },
      React.createElement(
        'div',
        { className: 'visualize-pane-content' },
        React.createElement('iframe', { title: `page ${index}` }),
        React.createElement(VisualizeCommentLayer, {
          sessionId: 's1',
          tab: twoTab,
          pane: twoTab.panes[index],
          index,
          comment: true,
        })
      )
    );
  await act(async () => root.render(React.createElement('section', { className: 'visualize-pane' }, cell(0), cell(1))));
  const sent = [[], []];
  host.querySelectorAll('iframe').forEach((frame, index) => {
    frame.contentWindow.postMessage = (message) => sent[index].push(message);
  });
  const layers = host.querySelectorAll('.visualize-region-layer');
  sized(layers[1], 0, 0, 400, 300);
  await userEvent(layers[1], mouse('pointermove', { clientX: 10, clientY: 10 }));
  await userEvent(
    document.body,
    new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true })
  );
  const steps = (index) => sent[index].filter((message) => message.type === 'hover-step');
  assert.equal(steps(0).length, 0, 'the first pane is left alone');
  assert.deepEqual(
    steps(1).map((message) => message.dir),
    ['up']
  );
});

for (const kind of ['image', 'video']) {
  test(`${kind} region pins sit on the picture as it is laid out now, after a pane resize too`, async (t) => {
    resetVisualizeFeedback();
    const mediaTab = {
      id: `m-${kind}`,
      label: 'Media',
      revision: 0,
      panes: [{ kind, label: 'shot', target: 'out/shot', url: '', file: 'out/shot' }],
    };
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
      resetVisualizeFeedback();
    });
    // A 1000×500 picture, drawn object-fit: contain in the element's box.
    let element = null;
    const stub = (node) => {
      if (!node || node === element) return;
      element = node;
      const size =
        kind === 'image'
          ? { naturalWidth: { get: () => 1000 }, naturalHeight: { get: () => 500 } }
          : {
              videoWidth: { get: () => 1000 },
              videoHeight: { get: () => 500 },
              currentTime: { get: () => 0 },
              duration: { get: () => 10 },
              paused: { get: () => true },
              pause: { value: () => {} },
            };
      Object.defineProperties(node, size);
    };
    const render = (comment) =>
      act(async () =>
        root.render(
          React.createElement(
            'div',
            { className: 'visualize-pane-content' },
            React.createElement(kind === 'image' ? 'img' : 'video', { ref: stub }),
            React.createElement(VisualizeCommentLayer, {
              sessionId: 's1',
              tab: mediaTab,
              pane: mediaTab.panes[0],
              index: 0,
              comment,
            })
          )
        )
      );
    await render(true);
    const layer = host.querySelector('.visualize-region-layer');
    sized(layer, 0, 0, 400, 300);
    sized(element, 0, 0, 400, 300);
    // Picture: 400×200 at y 50. The drag covers (100,100)-(300,200).
    await userDrag(layer, [100, 100], [300, 200]);
    await type(card(host).querySelector('textarea'), 'Here');
    await act(async () => button(host, 'Add').click());
    await cropSettled();
    const [pin] = visualizeFeedbackFor('s1').pins;
    assert.deepEqual(pin.target.image, { x: 250, y: 125, width: 500, height: 250 }, 'kept in picture pixels');
    const drawn = () => {
      const { style } = host.querySelector('.visualize-region-box');
      return [style.left, style.top, style.width, style.height].map(
        (value) => Math.round(Number.parseFloat(value) * 100) / 100
      );
    };
    assert.deepEqual(drawn(), [25, 33.33, 50, 33.33]);

    // Maximized: the pane is 800 wide, the picture 600×300 at x 100.
    sized(layer, 0, 0, 800, 300);
    sized(element, 0, 0, 800, 300);
    await act(async () => {
      for (const observer of resizeObservers) observer.callback([]);
    });
    assert.deepEqual(drawn(), [31.25, 25, 37.5, 50], 'the box stays on the same part of the picture');

    // Its card reopens beside where it is now.
    await userClick(layer, { clientX: 400, clientY: 150 });
    assert.equal(card(host).querySelector('textarea').value, 'Here');
    assert.deepEqual([card(host).style.left, card(host).style.top], ['250px', '235px']);
    await act(async () => button(host, 'Cancel').click());

    // A pin without picture pixels (made before this, or before the size
    // was known) keeps its view.
    removeVisualizePin('s1', pin.id);
    addVisualizePin('s1', {
      tabId: mediaTab.id,
      tabLabel: 'Media',
      pane: 0,
      paneKind: kind,
      file: 'out/shot',
      note: 'Old',
      label: 'Region',
      target: {
        type: 'region',
        view: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        ...(kind === 'video' ? { time: 0 } : {}),
      },
    });
    await render(true);
    assert.deepEqual(drawn(), [10, 20, 30, 40]);
  });
}

test('a video that mounts after Comment mode starts is still paused and followed', async (t) => {
  resetVisualizeFeedback();
  const videoTab = {
    id: 'v8',
    label: 'Clip',
    revision: 0,
    panes: [{ kind: 'video', label: 'late.mp4', target: 'clips/late.mp4', url: '', file: 'clips/late.mp4' }],
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  const calls = [];
  let paused = false;
  const stub = (node) => {
    if (!node || node.__stubbed) return;
    node.__stubbed = true;
    Object.defineProperties(node, {
      currentTime: { get: () => 4 },
      duration: { get: () => 20 },
      paused: { get: () => paused },
      pause: {
        value: () => {
          calls.push('pause');
          paused = true;
        },
      },
    });
  };
  const render = (withVideo) =>
    act(async () =>
      root.render(
        React.createElement(
          'div',
          { className: 'visualize-pane-content' },
          withVideo ? React.createElement('video', { ref: stub }) : null,
          React.createElement(VisualizeCommentLayer, {
            sessionId: 's1',
            tab: videoTab,
            pane: videoTab.panes[0],
            index: 0,
            comment: true,
          })
        )
      )
    );
  await render(false);
  assert.equal(host.querySelector('.visualize-media-bar'), null, 'no video yet');
  await render(true);
  await settle();
  assert.deepEqual(calls, ['pause'], 'the late video is paused');
  assert.ok(host.querySelector('.visualize-media-bar'), 'and gets its timeline');
});

test('which panes get the page bridge comes from the registry page flag', async (t) => {
  const original = VISUALIZE_COMMENT_KINDS.document;
  const attached = [];
  window.mixdogDesktop.visualizeFeedbackAttach = async (_session, tabId) => {
    attached.push(tabId);
  };
  t.after(() => {
    VISUALIZE_COMMENT_KINDS.document = original;
    delete window.mixdogDesktop.visualizeFeedbackAttach;
  });
  const docTab = {
    id: 'v7',
    label: 'Doc',
    revision: 0,
    panes: [{ kind: 'document', label: 'a.docx', target: 'a.docx', url: '', file: 'a.docx' }],
  };
  const answers = async () => {
    const { frame, toPage, fromPage } = await mount(t, false, docTab);
    await act(async () => frame.dispatchEvent(new window.Event('load')));
    await fromPage({ type: 'ready' });
    return toPage.filter((message) => message.type === 'state').length;
  };
  assert.equal(await answers(), 0, 'not a page kind: no state, no script');
  assert.deepEqual(attached, []);
  VISUALIZE_COMMENT_KINDS.document = { ...original, page: true };
  assert.ok((await answers()) > 0, 'a page kind is answered');
  // jsdom loads the frame itself too: one attach per load, all for this tab.
  assert.ok(attached.length > 0 && attached.every((id) => id === 'v7'), 'its script is attached');
});

test('a pin card request turns Comment mode on when it is off, and a stale one is dropped', async (t) => {
  const { exits } = await mount(t, false);
  const pin = queuedPin({ type: 'region', view: { x: 0, y: 0, width: 1, height: 1 } }, 'x');
  await act(async () => requestVisualizePinOpen('s1', pin.id));
  assert.deepEqual(exits, [true]);
  assert.equal(takeVisualizePinOpen('s1', 'v2', 0), null, 'another tab');
  assert.equal(takeVisualizePinOpen('s1', 'v1', 0, performance.now() + 60_000), null, 'too old');
  assert.equal(takeVisualizePinOpen('s1', 'v1', 0), null, 'a stale request was dropped, not kept');
});

test('the bridge resends to pages only when what it sends changes, not when the tab object does', async (t) => {
  resetVisualizeFeedback();
  let setShown = () => {};
  function Harness() {
    const [body, setBody] = useState(null);
    const [shown, set] = useState(tab);
    setShown = set;
    useVisualizeFeedbackBridge({ sessionId: 's1', tab: shown, body, comment: false, setComment: () => {} });
    return React.createElement(
      'div',
      { ref: setBody },
      React.createElement('div', { 'data-visualize-pane': '0' }, React.createElement('iframe', { title: 'page' }))
    );
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  await act(async () => root.render(React.createElement(Harness)));
  const toPage = [];
  host.querySelector('iframe').contentWindow.postMessage = (message) => toPage.push(message);
  const markers = () => toPage.filter((message) => message.type === 'state');

  // A new tab object with an unrelated field (another thumbnail, problems)
  // and new-but-equal pane objects: nothing is resent.
  await act(async () =>
    setShown({ ...tab, panes: tab.panes.map((pane) => ({ ...pane })), thumbnail: 'data:image/png;base64,AAAA' })
  );
  await act(async () =>
    setShown({ ...tab, problems: [{ kind: 'exception', message: 'x', source: 'a', line: 1, count: 1, pane: 0 }] })
  );
  assert.equal(markers().length, 0, 'unrelated tab fields resend nothing');

  // A pin on another tab changes the feedback state but not this pane's markers.
  await act(async () => {
    addVisualizePin('s1', {
      tabId: 'other',
      tabLabel: 'Other',
      pane: 0,
      paneKind: 'html',
      file: 'o.html',
      note: 'x',
      label: 'Region',
      target: { type: 'region', view: { x: 0, y: 0, width: 1, height: 1 } },
    });
  });
  assert.equal(markers().length, 0, "another tab's pins resend nothing");

  // A pin on this pane, and a reload (revision), do resend.
  await act(async () => {
    queuedPin({ type: 'element', selector: 'h1', html: '<h1>x</h1>', styles: {}, box: pick.box, path: [] }, 'mine');
  });
  assert.equal(markers().length, 1);
  assert.deepEqual(markers()[0].markers, [{ n: 2, selector: 'h1' }]);
  await act(async () => setShown({ ...tab, revision: 1 }));
  assert.equal(markers().length, 2, 'a reload resends');
});

test('Comment mode shows no hint strip; its hints are a one-time toast', async (t) => {
  resetVisualizeFeedback();
  addVisualizePin('s1', {
    tabId: 'v1',
    tabLabel: 'Mockup',
    pane: 0,
    paneKind: 'pdf',
    file: 'a.pdf',
    note: 'x',
    label: 'PDF · Region',
    target: { type: 'region', view: { x: 0, y: 0, width: 1, height: 1 } },
  });
  t.after(() => resetVisualizeFeedback());
  // No strip under the toolbar: the same hints are one line, announced once.
  assert.equal(
    visualizeCommentHintText(['html', 'video']),
    'Click element · Drag area · Alt↑ Parent element · Space Play/pause · ←→ Seek · Esc End comments'
  );
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail.text);
  window.addEventListener('mixdog:desktop-toast', onToast);
  t.after(() => window.removeEventListener('mixdog:desktop-toast', onToast));
  window.localStorage.removeItem(VISUALIZE_COMMENT_HINT_SEEN_KEY);
  announceVisualizeCommentMode(['pdf']);
  announceVisualizeCommentMode(['pdf']);
  assert.deepEqual(toasts, ['Drag area · Esc End comments'], 'one toast, once');
});
