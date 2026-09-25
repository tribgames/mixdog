// Agent tags in the review sources list are user data, not catalog keys: a tag
// that happens to spell a UI word must not be translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import i18n, { t as translate } from './i18n';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

test('turn review shows an agent tag verbatim in every UI language', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
  const previous = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.mixdogDesktop = {};
  await i18n.changeLanguage('ko');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await i18n.changeLanguage('en');
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  rememberAgentReviews('draft:none', [{ sessionId: 'child', agent: 'Plan', tag: null, patch }], null, [], '', '');
  await act(async () => {
    root.render(React.createElement(TurnReviewBar, { items: [], active: false, cwd: '' }));
  });
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-summary').click());
  const labels = [...document.querySelectorAll('.turn-review-source strong')].map((node) => node.textContent);
  // The tag spells a catalog key, so translating it would visibly change it.
  assert.notEqual(translate('Plan'), 'Plan');
  assert.deepEqual(labels, ['Plan']);
});
