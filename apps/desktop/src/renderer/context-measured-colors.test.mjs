import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ContextBody } from './ContextBody.tsx';
import { t } from './i18n.ts';

function render(measurement, categories) {
  return JSDOM.fragment(
    renderToStaticMarkup(
      React.createElement(ContextBody, {
        status: {
          sessionId: `colors-${measurement.source}`,
          contextWindow: 10000,
          measurement,
          inspection: {
            revision: 'colors',
            entries: [],
            categories,
            estimatedTokens: categories.reduce((sum, row) => sum + row.tokens, 0),
          },
        },
        snapshot: {},
      })
    )
  );
}

const categories = [
  { key: 'system', label: 'System prompt', tokens: 3000, count: 1 },
  { key: 'messages', label: 'Messages', tokens: 1000, count: 1 },
];

test('measured bar keeps its actual total while colors express estimated category shares', () => {
  const dom = render({ source: 'last_api_request', tokens: 2000 }, categories);
  const bar = dom.querySelector('.context-main-bar');
  assert.equal(bar.querySelector('span').style.width, '20%');
  assert.equal(bar.querySelector('[data-context-key="system"]').style.width, '75%');
  assert.equal(bar.querySelector('[data-context-key="messages"]').style.width, '25%');
  assert.equal(bar.title, t('Measured total; category colors show estimated proportions.'));
  assert.equal(dom.querySelector('button[data-context-key="system"] strong').textContent, '≈3,000');
  assert.equal(dom.querySelector('button[data-context-key="messages"] strong').textContent, '≈1,000');
});

test('unknown measurements do not acquire a colored reading from estimates', () => {
  const dom = render({ source: 'pending', tokens: null }, categories);
  const bar = dom.querySelector('.context-main-bar');
  assert.equal(bar.querySelector('span').style.width, '0%');
  assert.equal(bar.querySelectorAll('b').length, 0);
  assert.equal(bar.getAttribute('aria-label'), t('Awaiting measurement'));
});

test('measured totals without a breakdown retain a plain fill rather than invented categories', () => {
  const dom = render({ source: 'last_api_request', tokens: 2000 }, []);
  const bar = dom.querySelector('.context-main-bar');
  assert.equal(bar.querySelector('span').style.width, '20%');
  assert.equal(bar.querySelectorAll('b').length, 0);
  assert.equal(bar.title, t('Last measured input'));
});
