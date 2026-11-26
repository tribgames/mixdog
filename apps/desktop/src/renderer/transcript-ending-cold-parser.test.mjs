import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['HTMLElement', 'MutationObserver', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'],
});
const { TranscriptRow } = await import('./transcript-row.tsx');
const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
const { syncMarkdownParser } = await import('./markdown-worker-client.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a reply ending before the parser loaded keeps streaming, then ends with its tail in that commit', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const row = (text, streaming) =>
    React.createElement(
      MarkdownSessionContext.Provider,
      { value: 'cold' },
      React.createElement(TranscriptRow, {
        item: { id: 'r1', kind: 'assistant', text, streaming },
        revealKey: 'cold:r1',
        paced: true,
      })
    );
  const full = `Intro ${'word '.repeat(1000)}end`;
  const article = () => host.querySelector('.message.assistant');
  const shown = () => host.querySelector('.markdown')?.textContent ?? '';
  // Every committed state from the end on: whether the row presents as ended
  // (no longer `aria-live="off"`), and whether its tail had shown.
  const states = [];
  const observer = new MutationObserver(() =>
    states.push({ ended: article()?.getAttribute('aria-live') !== 'off', tail: shown().endsWith('end') })
  );
  // Streams, then ends, with no turn between: the parser's import, started
  // as the row mounted, has not resolved.
  act(() => root.render(row('Intro ', true)));
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  act(() => root.render(row(full, false)));
  assert.equal(syncMarkdownParser(), null, 'the reply ended before the parser loaded');
  assert.equal(article().getAttribute('aria-live'), 'off', 'still in its streaming presentation');
  for (let i = 0; i < 400 && !shown().endsWith('end'); i += 1) await act(async () => sleep(5));
  await act(async () => sleep(0));
  observer.disconnect();
  assert.ok(shown().endsWith('end'), 'the tail showed');
  assert.deepEqual(
    states.filter((state) => state.ended && !state.tail),
    [],
    'no commit of the ended reply without its tail'
  );
  await act(async () => root.unmount());
});
