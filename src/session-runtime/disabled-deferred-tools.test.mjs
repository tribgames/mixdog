import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestBody } from '../runtime/agent/orchestrator/providers/openai-responses-payload.mjs';
import { TOOL_SEARCH_TOOL } from './tool-defs.mjs';
import {
  applyDeferredToolSurface,
  deferredCatalogUnion,
  refreshInitialDeferredMcpSurface,
  renderToolSearch,
  selectDeferredTools,
  snapshotProviderRequestTools,
} from './tool-catalog.mjs';

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
  assert.deepEqual(
    deferredCatalogUnion(session)
      .map((t) => t.name)
      .sort(),
    ['git', 'shell']
  );
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
    assert.ok(!deferredCatalogUnion(session).some((t) => t.name === 'office'));
  }
});

function initialSession(provider, denied) {
  const session = {
    id: `initial-mcp-${provider}`,
    provider,
    model: 'gpt-6-astra',
    tools: [tool('read'), TOOL_SEARCH_TOOL],
    disallowedTools: denied,
    messages: [
      { role: 'system', content: 'BP1 BASE' },
      { role: 'system', content: 'BP2 PROFILE' },
      { role: 'system', content: 'BP3 SESSION', cacheTier: 'tier3' },
    ],
  };
  applyDeferredToolSurface(session, 'lead');
  return session;
}

function requestTools(session) {
  return snapshotProviderRequestTools({
    provider: session.provider,
    tools: session.tools,
    messages: session.messages,
    session,
  });
}

for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
  test(`${provider}: first-turn MCP discovery exposes only allowed tools`, () => {
    const blocked = tool('mcp__policy__blocked');
    const allowed = tool('mcp__policy__allowed');
    const session = initialSession(provider, [blocked.name]);
    const native = provider === 'openai-oauth' || provider === 'anthropic-oauth';
    const eagerBefore = JSON.stringify(requestTools(session));

    assert.equal(refreshInitialDeferredMcpSurface(session, [blocked, allowed]), true);
    assert.equal(session.deferredToolCatalog.some((tool) => tool.name === blocked.name), false);
    assert.ok(deferredCatalogUnion(session).some((tool) => tool.name === allowed.name));
    assert.equal(requestTools(session).some((tool) => tool.name === blocked.name), false);
    assert.equal(JSON.stringify(session.messages).includes(blocked.name), false);
    assert.equal(session.messages[0].content, 'BP1 BASE');
    assert.equal(session.messages[2].content, 'BP3 SESSION');
    if (native) {
      assert.equal(JSON.stringify(requestTools(session)), eagerBefore);
      assert.ok(session.messages[1].content.includes(allowed.name));
    } else {
      assert.ok(requestTools(session).some((tool) => tool.name === allowed.name));
    }

    const loaded = JSON.parse(renderToolSearch({ names: [blocked.name, allowed.name] }, session, 'lead'));
    assert.deepEqual(loaded.missing, [blocked.name]);
    assert.ok([...loaded.loaded, ...loaded.alreadyActive].includes(allowed.name));
    if (native) assert.deepEqual(loaded.nativeToolSearch.toolReferences, [allowed.name]);

    const repeated = JSON.parse(renderToolSearch({ names: [allowed.name] }, session, 'lead'));
    assert.deepEqual(repeated.alreadyActive, [allowed.name]);
    assert.deepEqual(repeated.missing, []);
  });

  test(`${provider}: denied-only first-turn discovery leaves cached request bytes unchanged`, () => {
    const blocked = tool('mcp__policy__blocked');
    const session = initialSession(provider, [blocked.name]);
    const toolsBefore = JSON.stringify(requestTools(session));
    const messagesBefore = JSON.stringify(session.messages);
    const body = () => buildRequestBody(
      [...session.messages, { role: 'user', content: 'Inspect the project.' }],
      session.model,
      requestTools(session),
      { sessionId: session.id }
    );
    const openaiBefore = provider === 'openai-oauth' ? body() : null;

    assert.equal(refreshInitialDeferredMcpSurface(session, [blocked]), false);
    assert.equal(JSON.stringify(requestTools(session)), toolsBefore);
    assert.equal(JSON.stringify(session.messages), messagesBefore);
    assert.equal(session.deferredToolCatalog.some((tool) => tool.name === blocked.name), false);
    if (openaiBefore) {
      const after = body();
      assert.equal(after.prompt_cache_key, openaiBefore.prompt_cache_key);
      assert.deepEqual(after, openaiBefore);
    }
  });
}
