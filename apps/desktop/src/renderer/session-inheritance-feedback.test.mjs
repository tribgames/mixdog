import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import i18n from './i18n.ts';
import { CompletionStatus, ContextUsageIndicator } from './transcript-status.tsx';
import { TranscriptRow } from './transcript-row.tsx';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { modelDisplayName } from './provider-display.tsx';

const koCatalog = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', koCatalog, true, true);

test('auto-clear and compact completion render polished localized labels', async () => {
  const previousLang = i18n.language;
  try {
    await i18n.changeLanguage('ko');
    const autoClearMarkup = renderToStaticMarkup(
      React.createElement(CompletionStatus, {
        item: { kind: 'statusdone', label: 'Auto-clear complete' },
      })
    );
    assert.match(autoClearMarkup, /세션 자동 정리 완료/);

    const autoClearSkippedMarkup = renderToStaticMarkup(
      React.createElement(CompletionStatus, {
        item: { kind: 'statusdone', label: 'Auto-clear skipped', detail: 'conversation kept · nothing to compact' },
      })
    );
    assert.match(autoClearSkippedMarkup, /자동 정리 생략 \(대화 유지\)/);
    assert.match(autoClearSkippedMarkup, /대화 내용 보존/);

    const compactMarkup = renderToStaticMarkup(
      React.createElement(CompletionStatus, {
        item: { kind: 'statusdone', label: 'Compact complete', detail: '2s' },
      })
    );
    assert.match(compactMarkup, /대화 압축 완료/);
  } finally {
    await i18n.changeLanguage(previousLang);
  }
});

test('inheritance completion renders a distinct, accessible conversation boundary', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CompletionStatus, {
      item: { kind: 'statusdone', status: 'inherited' },
    })
  );
  const dom = new JSDOM(markup);
  try {
    const status = dom.window.document.querySelector('[role="status"]');
    assert.match(status.textContent, /Session forked/);
    assert.match(status.textContent, /Continuing with the previous context/);
    assert.doesNotMatch(status.textContent, /compacted/i);
  } finally {
    dom.window.close();
  }
});

test('a quota fallback renders a switch divider with the localized reason and both model names', async () => {
  const previousLang = i18n.language;
  try {
    await i18n.changeLanguage('ko');
    const item = {
      kind: 'notice',
      text: 'Claude Fable 5.2 usage limit reached — switched to GPT-6.2-Astra.',
    };
    const row = JSDOM.fragment(renderToStaticMarkup(React.createElement(TranscriptRow, { item })));
    const divider = row.querySelector('.compaction-divider[role="status"]');
    assert.ok(divider?.querySelector('svg.lucide-arrow-left-right'));
    assert.match(divider.textContent, /^Claude Fable 5\.2 한도 소진 — GPT-6\.2-Astra.*로 전환합니다\.$/);
  } finally {
    await i18n.changeLanguage(previousLang);
  }
});

test('an in-place model switch renders the compaction-style divider naming only the new model', async () => {
  const previousLang = i18n.language;
  const item = {
    kind: 'statusdone',
    status: 'model-switched',
    label: 'Model switched',
    provider: 'openai-oauth',
    modelId: 'gpt-6-astra',
  };
  const render = () => {
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(CompletionStatus, { item })));
    const status = dom.window.document.querySelector('.compaction-divider[role="status"]');
    const text = status.textContent;
    const icon = status.querySelector('svg.compaction-icon');
    dom.window.close();
    return { text, icon };
  };
  try {
    const english = render();
    assert.ok(english.icon, 'swap glyph');
    const model = modelDisplayName('gpt-6-astra', 'openai-oauth');
    assert.equal(english.text, `Switched to ${model}`);
    await i18n.changeLanguage('ko');
    assert.equal(render().text, `${model}로 전환`);
  } finally {
    await i18n.changeLanguage(previousLang);
  }
});

async function startCompaction(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key],
    });
  }
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const notices = [];
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => notices.push(event.detail));
  let resolve;
  let reject;
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: (request) => {
      calls.push(request.capability);
      return pending;
    },
  };
  const snapshot = {
    sessionId: 'source',
    provider: 'openai-oauth',
    model: 'gpt-6-astra',
    items: [
      {
        kind: 'assistant',
        provider: 'openai-oauth',
        modelId: 'gpt-6-astra',
      },
    ],
  };
  const render = (open, current = snapshot) =>
    root.render(
      React.createElement(ContextUsageIndicator, {
        snapshot: current,
        open,
        onOpenChange() {},
      })
    );
  const label = 'Compact context';
  await act(async () => render(true));
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label);
  assert.ok(button);
  const idleMarkup = button.innerHTML;
  await act(async () => {
    button.click();
    button.click();
  });
  return { render, snapshot, calls, notices, resolve, reject, label, button, idleMarkup };
}

test('compact blocks re-entry without extra progress UI while it runs', async (t) => {
  const run = await startCompaction(t);
  const { render, snapshot, calls } = run;
  assert.equal(run.button.disabled, true);
  assert.equal(run.button.innerHTML, run.idleMarkup);
  assert.deepEqual(calls, ['compact']);
  await act(async () => render(false));
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.doesNotMatch(document.body.textContent, /Inheriting|Compacting/);
  await act(async () =>
    render(true, {
      ...snapshot,
      items: [
        {
          kind: 'assistant',
          provider: 'anthropic-oauth',
          modelId: 'claude-fable-5-1',
        },
      ],
    })
  );
  const otherButton = document.querySelector('.context-action');
  assert.equal(otherButton.disabled, true);
  await act(async () => otherButton.click());
  assert.deepEqual(calls, ['compact']);
});

test('compact success leaves no status and the heir offers compaction again', async (t) => {
  const { render, snapshot, calls, notices, resolve } = await startCompaction(t);
  await act(async () => render(true));
  await act(async () => resolve());
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.deepEqual(calls, ['compact']);
  await act(async () =>
    render(true, {
      ...snapshot,
      sessionId: 'heir',
      items: [
        ...snapshot.items,
        {
          kind: 'statusdone',
          status: 'inherited',
          provider: snapshot.provider,
          modelId: snapshot.model,
        },
      ],
    })
  );
  assert.ok([...document.querySelectorAll('button')].some((node) => node.textContent === 'Compact context'));
  assert.equal(notices.length, 0);
});

test('compact failure reports the error and re-enables the button', async (t) => {
  const { render, notices, reject, label } = await startCompaction(t);
  await act(async () => render(true));
  await act(async () => reject(new Error('Carry failed')));
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(notices.at(-1).tone, 'error');
  assert.match(notices.at(-1).text, /Carry failed/);
  await act(async () => render(true));
  assert.ok([...document.querySelectorAll('button')].some((node) => node.textContent === label && !node.disabled));
});
