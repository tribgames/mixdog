import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

// Reject only the main-thread parser chunk import in this isolated test file.
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (context.parentURL?.includes('/markdown-worker-client.ts') && specifier === './markdown-ast') {
      throw new Error('Parser chunk unavailable');
    }
    return next(specifier, context);
  }
`)}`);

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
  const row = (streaming) => React.createElement(DesktopErrorBoundary, null, React.createElement(TranscriptRow, {
    item: { id: 'r', kind: 'assistant', text: streaming ? 'Intro' : 'Intro and final text', streaming },
    revealKey: 'failed-parser:r',
    paced: true,
  }));
  act(() => root.render(row(true)));
  act(() => root.render(row(false)));
  assert.equal(host.querySelector('article')?.getAttribute('aria-live'), 'off');
  await act(() => preloadSyncMarkdownParser());
  assert.equal(syncMarkdownParser(), null);
  assert.ok(host.querySelector('.desktop-recovery-screen[role="alert"]'), 'the failure reached the recovery screen');
});
