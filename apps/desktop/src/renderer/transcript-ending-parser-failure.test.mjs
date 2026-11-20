import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

// Reject the resolved parser chunk, regardless of how the TS loader spells the import.
const parserUrl = new URL('./markdown-ast.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.split('?')[0] === parserUrl) throw new Error('Parser chunk unavailable');
    return result;
  },
});
test.after(() => hooks.deregister());

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['HTMLElement', 'MutationObserver', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'],
});
const { TranscriptRow } = await import('./transcript-row.tsx');
const { DesktopErrorBoundary } = await import('./RendererRecovery.tsx');
const { preloadSyncMarkdownParser, syncMarkdownParser } = await import('./markdown-worker-client.ts');

test('a held completion goes to renderer recovery when its parser import rejects', async (t) => {
  const host = document.createElement('div');
  const root = createRoot(host, { onCaughtError() {} });
  t.after(() => act(() => root.unmount()));
  t.mock.method(console, 'error', () => {});
  const row = (streaming) =>
    React.createElement(
      DesktopErrorBoundary,
      null,
      React.createElement(TranscriptRow, {
        item: { id: 'r', kind: 'assistant', text: streaming ? 'Intro' : 'Intro and final text', streaming },
        revealKey: 'failed-parser:r',
        paced: true,
      })
    );
  act(() => root.render(row(true)));
  act(() => root.render(row(false)));
  assert.equal(host.querySelector('article')?.getAttribute('aria-live'), 'off');
  await act(() => preloadSyncMarkdownParser());
  assert.equal(syncMarkdownParser(), null);
  assert.ok(host.querySelector('.desktop-recovery-screen[role="alert"]'), 'the failure reached the recovery screen');
});
