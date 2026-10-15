import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { html: '<html><body></body></html>' });
const { createRoot } = await import('react-dom/client');
const { visualizeFeedbackCards, VisualizeFeedbackCards } = await import('./VisualizeFeedbackCards.tsx');
const {
  addVisualizePin,
  resetVisualizeFeedback,
  setVisualizeChoice,
  setVisualizeTweakSet,
  takeVisualizePinOpen,
  visualizeFeedbackFor,
} = await import('./visualize-feedback-store.ts');

const base = { tabId: 'v1', tabLabel: 'Mockup', pane: 0, file: 'a', note: 'Make it bigger' };
const image = { data: 'AAAA', mimeType: 'image/png', width: 4, height: 4 };
const region = { type: 'region', view: { x: 0, y: 0, width: 1, height: 1 } };

function queue() {
  resetVisualizeFeedback();
  addVisualizePin('s1', {
    ...base,
    paneKind: 'html',
    label: 'Button · Save',
    image,
    target: {
      type: 'element',
      selector: '#save',
      html: '',
      styles: {},
      box: { x: 0, y: 0, width: 1, height: 1 },
      path: [],
    },
  });
  addVisualizePin('s1', {
    ...base,
    paneKind: 'video',
    label: 'Video 0:12 · Region',
    image,
    target: { ...region, time: 12.4 },
  });
  addVisualizePin('s1', { ...base, paneKind: 'pdf', label: 'PDF · Region', target: region });
  setVisualizeChoice(
    's1',
    { tabId: 'v1', tabLabel: 'Mockup', pane: 0, file: 'a', group: 'layout', choice: 'inline', label: 'Inline chip' },
    true
  );
  setVisualizeTweakSet('s1', {
    tabId: 'v1',
    tabLabel: 'Mockup',
    pane: 0,
    file: 'a',
    changes: [{ id: 'accent', target: '--accent', value: '#2f6fed', was: '#3b82f6' }],
  });
}

test('the card model picks a crop or the kind icon, a video time, and one card each for choices and tweaks', () => {
  queue();
  const cards = visualizeFeedbackCards(visualizeFeedbackFor('s1'));
  assert.deepEqual(
    cards.map((card) => [card.type, card.n, Boolean(card.image), card.icon, card.time]),
    [
      ['pin', 1, true, 'code', undefined],
      ['pin', 2, true, 'film', '0:12'],
      ['pin', 3, false, 'file-text', undefined],
      ['choices', undefined, false, undefined, undefined],
      ['tweaks', undefined, false, undefined, undefined],
    ]
  );
  assert.equal(cards[0].image, 'data:image/png;base64,AAAA');
  assert.deepEqual(cards[3], { type: 'choices', value: 'Inline chip', bar: 'layout' });
  assert.deepEqual(cards[4], { type: 'tweaks', value: '#2f6fed', color: '#2f6fed', bar: 'accent' });
});

test('a tweak value that is not a color shows as text; several changes show the first and a count', () => {
  resetVisualizeFeedback();
  setVisualizeTweakSet('s1', {
    tabId: 'v1',
    tabLabel: 'Mockup',
    pane: 0,
    file: 'a',
    changes: [
      { id: 'density', target: 'data-density', value: 'compact', was: 'cozy' },
      { id: 'size', target: '--size', value: '18px', was: '14px' },
    ],
  });
  assert.deepEqual(visualizeFeedbackCards(visualizeFeedbackFor('s1')), [
    { type: 'tweaks', value: 'compact +1', bar: 'density, size' },
  ]);
});

test('the cards draw the crop, the fallback, the video time, remove and clear, and a pin card requests its panel card', async (t) => {
  queue();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  });
  await act(async () => root.render(React.createElement(VisualizeFeedbackCards, { sessionId: 's1' })));
  const cards = [...host.querySelectorAll('.attachment-card')];
  assert.equal(cards.length, 5);
  assert.deepEqual(
    cards.slice(0, 3).map((card) => card.querySelector('.visualize-card-number').textContent),
    ['1', '2', '3']
  );
  assert.ok(cards[0].querySelector('img'));
  assert.equal(cards[1].querySelector('.visualize-card-time').textContent, '0:12');
  assert.equal(cards[2].querySelector('img'), null);
  assert.equal(cards[2].querySelector('.visualize-card-label').textContent, 'PDF · Region');
  assert.equal(cards[2].querySelector('svg').closest('.visualize-card-clip').classList.contains('is-fallback'), true);
  assert.equal(cards[0].querySelector('.attachment-card-name').textContent, 'Make it bigger');
  assert.equal(cards[0].dataset.tooltip, 'Button · Save\nMake it bigger');
  assert.equal(cards[3].querySelector('.visualize-card-value').textContent, 'Inline chip');
  assert.ok(cards[4].querySelector('.visualize-card-swatch'));

  await act(async () => cards[1].querySelector('.visualize-card-open').click());
  assert.equal(takeVisualizePinOpen('s1', 'v1', 0)?.id, visualizeFeedbackFor('s1').pins[1].id);

  await act(async () => cards[4].querySelector('.attachment-card-remove').click());
  assert.deepEqual(visualizeFeedbackFor('s1').tweaks, []);
  await act(async () => host.querySelectorAll('.attachment-card')[3].querySelector('.attachment-card-remove').click());
  assert.deepEqual(visualizeFeedbackFor('s1').choices, []);
  await act(async () => host.querySelectorAll('.attachment-card')[0].querySelector('.attachment-card-remove').click());
  assert.equal(visualizeFeedbackFor('s1').pins.length, 2);
  assert.equal(host.querySelectorAll('.attachment-card')[0].querySelector('.visualize-card-number').textContent, '1');
});
