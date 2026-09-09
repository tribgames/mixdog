import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ContextUsageIndicator } from './transcript-status.tsx';
import { ContextBody } from './ContextBody.tsx';
import { ContextStatusView } from './settings/capability-controls.tsx';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store.ts';
import { t } from './i18n.ts';

test('tooltip, detail, and settings share measured input and explicit unknown states', (context) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  context.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  });
  for (const [source, tokens, label] of [
    ['last_api_request', 8281, 'Last measured input'],
    ['pending', null, 'Awaiting measurement'],
    ['unavailable', null, 'Usage unavailable'],
  ]) {
    const status = {
      sessionId: `measurement-${source}`,
      contextWindow: 436000,
      usedTokens: 18000,
      currentEstimatedTokens: 18000,
      measurement: { source, tokens, updatedAt: 1000 },
    };
    const snapshot = {
      sessionId: status.sessionId,
      contextWindow: 436000,
      autoCompactTokenLimit: 18000,
      stats: {
        currentContextTokens: tokens,
        currentContextSource: source,
        currentContextUpdatedAt: 1000,
        currentEstimatedContextTokens: 18000,
      },
    };
    for (const element of [
      React.createElement(ContextUsageIndicator, { snapshot }),
      React.createElement(ContextBody, { status, snapshot }),
      React.createElement(ContextStatusView, { value: status }),
    ]) {
      const html = renderToStaticMarkup(element);
      const text = JSDOM.fragment(html).textContent;
      assert.ok(text.includes(t(label)), label);
      assert.doesNotMatch(text, /100%|4\.1%/);
      if (tokens != null) assert.match(text, /1\.9%/);
      else assert.doesNotMatch(text, /1\.9%|0%/);
    }
  }
});

test('unknown-state and measurement timestamp changes repaint header-only frames', () => {
  const snapshot = {
    sessionId: 'same-session',
    stats: { currentContextTokens: null, currentContextSource: 'pending', currentContextUpdatedAt: null },
  };
  assert.equal(desktopHeaderSnapshotsEqual(snapshot, {
    ...snapshot, stats: { ...snapshot.stats, currentContextSource: 'unavailable' },
  }), false);
  const measured = {
    ...snapshot, stats: { currentContextTokens: 8281, currentContextSource: 'last_api_request', currentContextUpdatedAt: 1000 },
  };
  assert.equal(desktopHeaderSnapshotsEqual(measured, {
    ...measured, stats: { ...measured.stats, currentContextUpdatedAt: 2000 },
  }), false);
});
