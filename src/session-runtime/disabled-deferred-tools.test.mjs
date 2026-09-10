import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDeferredToolSurface, deferredCatalogUnion, renderToolSearch, selectDeferredTools } from './tool-catalog.mjs';

const tool = (name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
});

test('session-disabled tools cannot re-enter the deferred surface through extra definitions', () => {
  const session = {
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    tools: [tool('shell')],
    disallowedTools: ['office', 'memory'],
  };
  applyDeferredToolSurface(session, 'full', [tool('office'), tool('memory'), tool('git')]);
  assert.deepEqual(deferredCatalogUnion(session).map(t => t.name).sort(), ['git', 'shell']);
  assert.deepEqual(selectDeferredTools(session, ['office', 'memory'], 'full').added, []);
});

test('disabled definitions are excluded from stale boot, late, and active loader catalogs', () => {
  for (const field of ['deferredToolCatalog', 'deferredLateToolCatalog', 'tools']) {
    const session = {
      provider: 'openai-oauth',
      tools: [],
      disallowedTools: ['office'],
      [field]: [tool('office'), tool('git')],
    };
    const result = renderToolSearch({ names: ['office'] }, session, 'full');
    assert.doesNotMatch(typeof result === 'string' ? result : JSON.stringify(result), /Loaded deferred tools: office/);
    const selection = selectDeferredTools(session, ['office'], 'full');
    assert.deepEqual(selection.added, []);
    assert.ok(selection.missing.includes('office'));
    assert.ok(!deferredCatalogUnion(session).some(t => t.name === 'office'));
  }
});
