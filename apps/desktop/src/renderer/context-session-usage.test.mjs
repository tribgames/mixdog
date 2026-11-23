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
  unmeasuredTurns: 0,
};

const footer = (props) => {
  const html = renderToStaticMarkup(
    React.createElement(ContextBody, { status: { sessionId: 'context', contextWindow: 1000 }, snapshot: {}, ...props })
  );
  return new JSDOM(html).window.document.querySelector('.context-session-usage');
};

const figureCells = (node) =>
  [...node.querySelectorAll(':scope > span:not(.context-session-usage-end)')].map((span) => [
    span.querySelector('strong').textContent,
    span.getAttribute('title'),
  ]);

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

test('a session with a call that reported no usage shows the measured figures as floors', () => {
  const node = footer({ sessionUsage: { ...sessionUsage, unmeasuredTurns: 3, costUnpricedTurns: 3, cacheHitRate: null } });
  const note = t('Some usage was not reported by its provider or has no known price; figures marked ≥ are a lower bound.');
  // The hit rate is the measured calls' own rate: plain, with a tooltip saying so.
  assert.deepEqual(figureCells(node), [
    [`≥ ${statsMoney(sessionUsage)}`, note],
    [statsPercent(3_420_000 / (182_000 + 3_420_000 + 241_000)), t('The rate covers only the calls whose usage was reported.')],
    [`≥ ${statsTokens(182_000)}`, note],
    [`≥ ${statsTokens(58_300)}`, note],
    [`≥ ${statsTokens(3_420_000)}`, note],
    [`≥ ${statsTokens(241_000)}`, note],
  ]);
});

test('a turn without a known price marks the cost alone as a floor; nothing priced is no cost', () => {
  const note = t('Some usage was not reported by its provider or has no known price; figures marked ≥ are a lower bound.');
  const [cost, hit, input] = figureCells(footer({ sessionUsage: { ...sessionUsage, costUnpricedTurns: 3 } }));
  assert.deepEqual(cost, [`≥ ${statsMoney(sessionUsage)}`, note]);
  assert.deepEqual(hit, [statsPercent(0.89), null]);
  assert.deepEqual(input, [statsTokens(182_000), null]);
  const [none] = figureCells(footer({ sessionUsage: { ...sessionUsage, costUsd: 0, costUnpricedTurns: 42 } }));
  assert.deepEqual(none, ['—', null]);
});

test('a lower bound of zero tokens is no figure; an answer that does not say what it measured is a lower bound', () => {
  const note = t('Some usage was not reported by its provider or has no known price; figures marked ≥ are a lower bound.');
  const cells = figureCells(footer({ sessionUsage: { ...sessionUsage, cacheRead: 0, cacheWrite: 0, unmeasuredTurns: 2 } }));
  assert.deepEqual(cells.slice(2), [
    [`≥ ${statsTokens(182_000)}`, note],
    [`≥ ${statsTokens(58_300)}`, note],
    ['—', null],
    ['—', null],
  ]);
  const { unmeasuredTurns: _, ...unsaid } = sessionUsage;
  const [, , input] = figureCells(footer({ sessionUsage: unsaid }));
  assert.deepEqual(input, [`≥ ${statsTokens(182_000)}`, note]);
});

test('a timed session also reports its output speed', () => {
  const node = footer({ sessionUsage: { ...sessionUsage, outputTokensPerSecond: 61.2 } });
  const speed = [...node.querySelectorAll(':scope > span')].find(
    (span) => span.firstChild.textContent.trim() === t('Speed')
  );
  assert.equal(speed.querySelector('strong').textContent, '61 tok/s');
});

test('no session spend yet, or none readable, leaves the footer out', () => {
  assert.equal(footer({ sessionUsage: null }), null);
  assert.equal(footer({ sessionUsage: { ...sessionUsage, turns: 0 } }), null);
  const uncompacted = footer({ sessionUsage });
  assert.ok(!uncompacted.textContent.includes(t('Compactions')));
});
