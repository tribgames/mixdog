import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebSearchRouteConfig } from './workflow.mjs';

test('a web-search route never carries autoEffort, so no stale flag can label it Auto', () => {
  const route = normalizeWebSearchRouteConfig({
    provider: 'openai-oauth',
    model: 'gpt-6.1-sol',
    effort: 'high',
    autoEffort: true,
  });
  assert.equal(route.effort, 'high');
  assert.equal('autoEffort' in route, false);
});
