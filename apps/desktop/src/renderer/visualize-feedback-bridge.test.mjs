import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import React, { act, useState } from 'react';

import { VISUALIZE_FEEDBACK_TAG } from '../shared/visualize-feedback.ts';
import { installTestDom } from './test-support/test-dom.mjs';

// The panel window's own activation must not matter any more: keep it on.
installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['requestAnimationFrame', 'cancelAnimationFrame'],
  globals: { navigator: { userAgent: 'node', userActivation: { isActive: true } } },
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
const { captureVisualizeElementCrop, requestVisualizeDescription, useVisualizeFeedbackBridge, VisualizeCommentLayer } =
  await import('./VisualizeFeedback.tsx');
const { resetVisualizeFeedback, visualizeFeedbackFor } = await import('./visualize-feedback-store.ts');
const { resetVisualizeChoiceProposals, VISUALIZE_PROPOSAL_MIN_INTERVAL_MS } = await import(
  './visualize-feedback-gate.ts'
);
const consumeGesture = window.mixdogDesktop.visualizeConsumeGesture;

// jsdom marks every script-dispatched event untrusted; a real user click is
// stood in for by dispatching through jsdom's internals with the flag set.
const jsdomUtils = createRequire(import.meta.url)('jsdom/lib/jsdom/living/generated/utils.js');
async function userClick(node) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  const impl = jsdomUtils.implForWrapper(event);
  impl.isTrusted = true;
  await act(async () => jsdomUtils.implForWrapper(node)._dispatch(impl));
}
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

async function mount(t, comment) {
  resetVisualizeFeedback();
  resetVisualizeChoiceProposals();
  window.mixdogDesktop.visualizeConsumeGesture = consumeGesture;
  gestures.length = 0;
  consumed.length = 0;
  const exits = [];
  function Harness() {
    const [body, setBody] = useState(null);
    useVisualizeFeedbackBridge({ sessionId: 's1', tab, body, comment, setComment: (on) => exits.push(on) });
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
          React.createElement(VisualizeCommentLayer, { sessionId: 's1', tab, pane: tab.panes[0], index: 0, comment })
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
  assert.deepEqual(toPage.at(-1), { type: 'state', comment: false, markers: [], choices: [], [VISUALIZE_FEEDBACK_TAG]: 1 });
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
  const { resetVisualizeTweakStore, setVisualizeTweakValue, visualizePaneTweaks } = await import('./visualize-tweaks-store.ts');
  resetVisualizeTweakStore();
  const { toPage, fromPage } = await mount(t, false);
  const raw = JSON.stringify([{ id: 'accent', type: 'color', var: '--accent', default: '#3b82f6' }]);
  const tweakMessages = () => toPage.filter((message) => message.type === 'tweaks' || message.type === 'tweaks-problem');

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