import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_TOOLS } from '../runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import {
  applyDeferredToolSurface,
  deferredCatalogUnion,
  renderToolSearch,
} from './tool-catalog.mjs';

const deferredGitNames = ['git_stage', 'github'];

function session(provider = 'openai-oauth') {
  const current = { provider, tools: BUILTIN_TOOLS.slice(), messages: [] };
  applyDeferredToolSurface(current, 'lead');
  return current;
}

for (const provider of ['openai-oauth', 'anthropic-oauth']) {
  test(`${provider} rebuilds retain unloaded built-ins without eagerly exposing their schemas`, () => {
    const current = session(provider);
    for (let rebuild = 0; rebuild < 3; rebuild += 1) {
      applyDeferredToolSurface(current, 'lead');
      for (const name of deferredGitNames) {
        assert.ok(deferredCatalogUnion(current).some((tool) => tool.name === name));
        assert.equal(current.tools.some((tool) => tool.name === name), false);
        assert.equal(current.deferredCallableTools.includes(name), false);
      }
    }

    const loaded = JSON.parse(renderToolSearch({ names: deferredGitNames }, current, 'lead'));
    assert.deepEqual(loaded.loaded, deferredGitNames);
    assert.deepEqual(loaded.missing, []);
    assert.deepEqual(loaded.nativeToolSearch.toolReferences, deferredGitNames);
    for (const name of deferredGitNames) {
      assert.ok(current.deferredCallableTools.includes(name));
      assert.equal(current.tools.some((tool) => tool.name === name), false);
    }

    const repeated = JSON.parse(renderToolSearch({ names: deferredGitNames }, current, 'lead'));
    assert.deepEqual(repeated.loaded, []);
    assert.deepEqual(repeated.alreadyActive, deferredGitNames);
    assert.deepEqual(repeated.missing, []);
    assert.deepEqual(repeated.nativeToolSearch.toolReferences, deferredGitNames);
  });
}

for (const denySource of ['session', 'options']) {
  test(`rebuilding cannot restore a retained built-in denied by ${denySource}`, () => {
    const current = session();
    const denied = ['git_stage'];
    const options = denySource === 'options' ? { disallowed: denied } : {};
    if (denySource === 'session') current.disallowedTools = denied;
    applyDeferredToolSurface(current, 'lead', BUILTIN_TOOLS, options);

    assert.equal(deferredCatalogUnion(current).some((tool) => tool.name === 'git_stage'), false);
    const loaded = JSON.parse(renderToolSearch({ names: deferredGitNames }, current, 'lead'));
    assert.deepEqual(loaded.loaded, ['github']);
    assert.deepEqual(loaded.missing, ['git_stage']);
  });
}

test('retained mutating tools remain blocked when the surface is rebuilt readonly', () => {
  const current = session();
  applyDeferredToolSurface(current, 'readonly');
  const loaded = JSON.parse(renderToolSearch({ names: deferredGitNames }, current, 'readonly'));
  assert.deepEqual(loaded.loaded, []);
  assert.deepEqual(loaded.missing, []);
  assert.deepEqual(loaded.blocked, deferredGitNames.map((name) => ({ name, reason: 'readonly mode' })));
});

test('current and extra definitions override retained schemas without losing other built-ins', () => {
  const current = session();
  current.tools = current.tools.map((tool) =>
    tool.name === 'git' ? { ...tool, description: 'Current git schema.' } : tool
  );
  const stage = BUILTIN_TOOLS.find((tool) => tool.name === 'git_stage');
  applyDeferredToolSurface(current, 'lead', [{ ...stage, description: 'Updated staging schema.' }]);

  const byName = new Map(deferredCatalogUnion(current).map((tool) => [tool.name, tool]));
  assert.equal(byName.get('git').description, 'Current git schema.');
  assert.equal(byName.get('git_stage').description, 'Updated staging schema.');
  assert.ok(byName.has('github'));
  assert.equal(current.tools.some((tool) => tool.name === 'git_stage'), false);
});
