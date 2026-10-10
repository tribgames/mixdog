import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useModelSelection } from './use-model-selection.ts';

test('a canonical default response releases the preview and accepts later tuning', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { url: 'about:blank' },
  });
  const root = createRoot(document.querySelector('main'));
  let paint;
  let acknowledge;
  function Harness() {
    const [source, setSource] = useState({
      provider: 'openai',
      model: 'gpt-test',
      effort: 'high',
      contextPercent: 100,
    });
    paint = setSource;
    const { selection, pending, begin, settle } = useModelSelection('source-session', source);
    return React.createElement(
      'button',
      {
        type: 'button',
        disabled: pending,
        onClick() {
          const token = begin({ ...source, effort: 'auto' });
          acknowledge = (snapshot) => settle(token, snapshot);
        },
      },
      `${selection.effort || 'default'}/${selection.contextPercent ?? 'default'}`
    );
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const button = document.querySelector('button');
    await act(async () => button.click());
    assert.equal(button.disabled, true);
    await act(async () =>
      acknowledge({
        provider: 'openai',
        model: 'gpt-test',
        effort: null,
        contextPercent: null,
      })
    );
    assert.equal(button.textContent, 'default/default');
    await act(async () =>
      paint({
        provider: 'openai',
        model: 'gpt-test',
        effort: '',
        contextPercent: undefined,
      })
    );
    assert.equal(button.disabled, false);
    await act(async () =>
      paint({
        provider: 'openai',
        model: 'gpt-test',
        effort: 'low',
        contextPercent: 50,
      })
    );
    assert.equal(button.textContent, 'low/50');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
