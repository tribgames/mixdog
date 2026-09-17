import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ContextUsageIndicator } from './transcript-status.tsx';
import { ContextBody } from './ContextBody.tsx';
import { t } from './i18n.ts';

test('context detail no longer renders the cached-input explanation', () => {
  const html = renderToStaticMarkup(React.createElement(ContextBody, {
    status: { sessionId: 'context', contextWindow: 1000 },
    snapshot: {},
  }));
  assert.ok(!html.includes(t('Input includes cached tokens. Output appears in the next measured request.')));
  assert.ok(html.includes(t('Estimated usage by category')));
});

for (const action of ['compact', 'inherit']) {
  test(`details appear above ${action} and remain read-only while the session is busy`, async (context) => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.getElementById('root'));
    context.after(async () => {
      await act(() => root.unmount());
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
      dom.window.close();
    });
    const opened = [];
    const changed = [];
    const mutations = [];
    window.mixdogDesktop = { invokeCapability: async (request) => { mutations.push(request); } };
    const snapshot = {
      sessionId: 'the-pane-session', busy: true,
      provider: 'openai-oauth', model: 'gpt-6-astra',
      items: [{
        kind: 'assistant',
        provider: action === 'inherit' ? 'anthropic-oauth' : 'openai-oauth',
        modelId: action === 'inherit' ? 'claude-fable-5-1' : 'gpt-6-astra',
      }],
    };
    await act(async () => root.render(React.createElement(ContextUsageIndicator, {
      snapshot, open: true, onOpenChange: (open) => changed.push(open),
      onInherit: async () => { mutations.push('inherit'); },
      onViewDetails: () => opened.push(snapshot.sessionId),
    })));
    const buttons = [...document.querySelectorAll('.context-action')];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].textContent, t('View context details'));
    assert.ok(buttons[1].classList.contains(`context-${action}`));
    assert.equal(buttons[1].disabled, true);
    assert.equal(buttons[0].disabled, false);
    await act(async () => buttons[0].click());
    assert.deepEqual(opened, ['the-pane-session']);
    assert.deepEqual(changed, [false]);
    assert.deepEqual(mutations, []);
  });
}
