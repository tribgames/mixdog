import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
dom.window.Element.prototype.scrollIntoView = () => {};
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'navigator',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QuestionCard } = await import('./QuestionCard.tsx');

const questions = [
  {
    question: 'Which?',
    header: 'W',
    multi_select: true,
    recommended: 0,
    options: [
      { label: 'A', description: 'da' },
      { label: 'B', description: '' },
    ],
  },
  {
    question: 'Keep?',
    header: 'K',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
  },
];

async function mount(render) {
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById('root'));
  await act(async () => root.render(render));
  return {
    doc,
    button: (name) => [...doc.querySelectorAll('button')].find((b) => b.dataset.action === name),
    click: (node) => act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))),
    type: (input, value) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }),
    done: () => act(async () => root.unmount()),
  };
}

test('step buttons: a multi-select advances by click, Previous goes back, the last question sends', async () => {
  const decisions = [];
  const draftsRef = { current: [] };
  const ui = await mount(
    React.createElement(QuestionCard, { questions, draftsRef, resolve: async (d) => (decisions.push(d), true) })
  );
  try {
    const options = () => [...ui.doc.querySelectorAll('.question-option')];
    const hint = () => ui.doc.querySelector('.question-hint').textContent;
    assert.equal(ui.doc.querySelector('.question-title strong').textContent, 'W');
    assert.equal(ui.doc.querySelector('.question-meta').textContent, '1/2 · Multiple');
    assert.equal(ui.button('skip').textContent, 'Skip');
    assert.equal(ui.button('previous'), undefined);
    await ui.click(options()[0]);
    await ui.click(options()[1]);
    assert.equal(options()[0].getAttribute('role'), 'checkbox');
    assert.equal(hint(), '2 selected · Enter Next');
    assert.deepEqual(draftsRef.current[0].selected, [0, 1], 'picks are exposed for a composer reply');
    await ui.click(ui.button('next'));
    assert.equal(ui.doc.querySelector('.question-text').textContent, 'Keep?');
    assert.equal(ui.doc.querySelector('.question-title strong').textContent, 'K');
    assert.equal(ui.doc.querySelector('.question-meta').textContent, '2/2');
    assert.equal(hint(), 'Enter Send · ← Previous question');
    await ui.click(ui.button('previous'));
    assert.equal(ui.doc.querySelector('.question-text').textContent, 'Which?');
    assert.equal(options()[0].getAttribute('aria-checked'), 'true', 'picks survive going back');
    await ui.click(ui.button('next'));
    await ui.type(ui.doc.querySelector('.question-other input'), 'mine');
    assert.equal(ui.button('send').textContent, 'Send');
    await ui.click(ui.button('send'));
    assert.deepEqual(decisions, [
      { approved: true, answers: [{ selected: ['A', 'B'] }, { selected: [], text: 'mine' }] },
    ]);
  } finally {
    await ui.done();
  }
});
