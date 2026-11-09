import assert from 'node:assert/strict';
import test from 'node:test';
import { contextMeasurementStats, measuredContextUsage } from '../../src/rows/context-measurement.mjs';

test('a measured last request is the gauge: stats carry the tokens and the percent follows the window', () => {
  const stats = contextMeasurementStats({ measurement: { tokens: 8300, source: 'last_api_request', updatedAt: 5 } });
  assert.equal(stats.currentContextTokens, 8300);
  assert.equal(stats.currentContextSource, 'last_api_request');
  assert.equal(measuredContextUsage({ stats, contextWindow: 436000 }).percent, 1.9);
});

test('pending and unavailable measurements never expose tokens or a percent', () => {
  for (const source of ['pending', 'unavailable']) {
    const stats = contextMeasurementStats({ measurement: { tokens: 24000, source } });
    assert.equal(stats.currentContextTokens, null);
    assert.equal(stats.currentContextSource, source);
    assert.equal(measuredContextUsage({ stats, contextWindow: 100000 }).percent, null);
  }
});
