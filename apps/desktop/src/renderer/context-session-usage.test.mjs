import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ContextBody } from './ContextBody.tsx';
import { t } from './i18n.ts';
import { statsMoney, statsPercent, statsTokens } from './usage-stats-model.tsx';

const sessionUsage = {
  turns: 42,
  input: 182_000,
  output: 58_300,
  cacheRead: 3_420_000,
  cacheWrite: 241_000,
  costUsd: 2.47,
  costKnownTurns: 42,
  costUnpricedTurns: 0,
  cacheHitRate: 0.89,
};

const footer = (props) => {
  const html = renderToStaticMarkup(
    React.createElement(ContextBody, { status: { sessionId: 'context', contextWindow: 1000 }, snapshot: {}, ...props })
  );
  return new JSDOM(html).window.document.querySelector('.context-session-usage');
};

test('the context dialog closes on the session spend, in the statistics terms', () => {
  const node = footer({
    sessionUsage,
    status: { sessionId: 'context', contextWindow: 1000, compaction: { compactCount: 2 } },
  });
  const figures = [...node.querySelectorAll(':scope > span:not(.context-session-usage-end)')].map((span) => [
    span.firstChild.textContent.trim(),
    span.querySelector('strong').textContent,
  ]);
  assert.deepEqual(figures, [
    [t('Est. value'), statsMoney(sessionUsage)],
    [t('Cache hit rate'), statsPercent(0.89)],
    [t('Input'), statsTokens(182_000)],
    [t('Output'), statsTokens(58_300)],
    [t('Cache read'), statsTokens(3_420_000)],
    [t('Cache write'), statsTokens(241_000)],
  ]);
  const end = node.querySelector('.context-session-usage-end').textContent;
  assert.ok(end.includes(t('Turns')) && end.includes('42'));
  assert.ok(end.includes(t('Compactions')) && end.includes('2'));
});

test('a timed session also reports its output speed', () => {
  const node = footer({ sessionUsage: { ...sessionUsage, outputTokensPerSecond: 61.2 } });
  const speed = [...node.querySelectorAll(':scope > span')].find((span) => span.firstChild.textContent.trim() === t('Speed'));
  assert.equal(speed.querySelector('strong').textContent, '61 tok/s');
});

test('no session spend yet, or none readable, leaves the footer out', () => {
  assert.equal(footer({ sessionUsage: null }), null);
  assert.equal(footer({ sessionUsage: { ...sessionUsage, turns: 0 } }), null);
  const uncompacted = footer({ sessionUsage });
  assert.ok(!uncompacted.textContent.includes(t('Compactions')));
});
