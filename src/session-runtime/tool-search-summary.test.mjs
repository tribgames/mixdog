import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDeferredToolSurface, renderToolSearch } from './tool-catalog.mjs';

test('native re-selection retains registration without duplicating schemas in prose', () => {
  const tool = {
    name: 'office',
    description: 'Create a document.',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
  };
  const session = {
    provider: 'openai-oauth',
    tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }, tool],
    messages: [],
    toolSpec: 'full',
  };
  applyDeferredToolSurface(session, 'full');
  renderToolSearch({ names: ['office'] }, session);
  const result = JSON.parse(renderToolSearch({ names: ['office'] }, session));
  assert.deepEqual(result.alreadyActive, ['office']);
  assert.deepEqual(result.nativeToolSearch.toolReferences, ['office']);
  assert.deepEqual(result.nativeToolSearch.openaiTools[0].parameters, tool.inputSchema);
  assert.equal(result.nativeToolSearch.summary, 'Already active: office');
  assert.equal(result.alreadyActiveSchemas, undefined);
});
