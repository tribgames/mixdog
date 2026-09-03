import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join } from 'node:path';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  normalizeExtensionScopes,
  extensionScopeProjects,
  cwdWithinProjects,
  skillAllowedForCwd,
  mcpServerAllowedForCwd,
  filterMcpToolsForCwd,
  filterMcpToolsForSession,
  registeredPluginIdentities,
  withExtensionScope,
  pluginIdForMcpServer,
} from './extension-scopes.mjs';
import { _registerMcpServerForTest, disconnectAll, getMcpTools } from '../runtime/agent/orchestrator/mcp/client.mjs';

const A = resolve('/work/alpha');
const B = resolve('/work/beta');

test('normalize drops empty lists, unknown kinds, and duplicate roots', () => {
  const scopes = normalizeExtensionScopes({
    skills: { deploy: [A, `${A}/`, ''], empty: [] },
    mcp: { unity: B },
    bogus: { x: [A] },
  });
  assert.deepEqual(Object.keys(scopes).sort(), ['mcp', 'plugins', 'skills']);
  assert.deepEqual(scopes.skills, { deploy: [A] });
  assert.deepEqual(scopes.mcp, { unity: [B] });
  assert.equal(extensionScopeProjects(scopes, 'skills', 'empty'), null);
  assert.equal(extensionScopeProjects(scopes, 'skills', 'unknown'), null);
});

test('cwd matches a root itself or any directory below it', () => {
  assert.equal(cwdWithinProjects(A, [A]), true);
  assert.equal(cwdWithinProjects(join(A, 'src', 'deep'), [A]), true);
  assert.equal(cwdWithinProjects(`${A}-other`, [A]), false);
  assert.equal(cwdWithinProjects(B, [A]), false);
  assert.equal(cwdWithinProjects('', [A]), false);
  assert.equal(cwdWithinProjects(B, []), true);
});

test('skill scope and owning plugin scope both gate visibility', () => {
  const scopes = normalizeExtensionScopes({ skills: { bench: [A] }, plugins: { unity: [B] } });
  assert.equal(skillAllowedForCwd(scopes, { name: 'bench' }, A), true);
  assert.equal(skillAllowedForCwd(scopes, { name: 'bench' }, B), false);
  assert.equal(skillAllowedForCwd(scopes, { name: 'free' }, B), true);
  assert.equal(skillAllowedForCwd(scopes, { name: 'free', plugin: 'unity' }, A), false);
  assert.equal(skillAllowedForCwd(scopes, { name: 'free', owner: { kind: 'plugin', id: 'unity' } }, B), true);
});

test('MCP tools filter by server scope, cascading from the installing plugin', () => {
  const plugins = [{ id: 'unity', name: 'Unity Tools' }];
  assert.equal(pluginIdForMcpServer('plugin-unity-tools', plugins), 'unity');
  assert.equal(pluginIdForMcpServer('plugin-unity-tools--editor', plugins), 'unity');
  assert.equal(pluginIdForMcpServer('UnityMCP', plugins), '');
  const scopes = normalizeExtensionScopes({ mcp: { UnityMCP: [B] }, plugins: { unity: [A] } });
  assert.equal(mcpServerAllowedForCwd(scopes, 'UnityMCP', A), false);
  assert.equal(mcpServerAllowedForCwd(scopes, 'UnityMCP', B), true);
  assert.equal(mcpServerAllowedForCwd(scopes, 'plugin-unity-tools', B, { plugins }), false);
  const tools = [
    { name: 'read' },
    { name: 'mcp__UnityMCP__manage_scene' },
    { name: 'mcp__plugin-unity-tools--editor__run' },
    { name: 'mcp__demo__tool' },
  ];
  assert.deepEqual(
    filterMcpToolsForCwd(tools, scopes, A, { plugins }).map((tool) => tool.name),
    ['read', 'mcp__plugin-unity-tools--editor__run', 'mcp__demo__tool'],
  );
  assert.deepEqual(
    filterMcpToolsForCwd(tools, scopes, B, { plugins }).map((tool) => tool.name),
    ['read', 'mcp__UnityMCP__manage_scene', 'mcp__demo__tool'],
  );
});

test('a live MCP registry is filtered per session cwd, cascading the plugin scope from registry.json', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-scope-data-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const scopeId = 'scope-test';
  try {
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    writeFileSync(join(dataDir, 'plugins', 'registry.json'), JSON.stringify({
      plugins: [{ id: 'unity', name: 'Unity Tools', root: dataDir, enabled: true }],
    }));
    assert.deepEqual(registeredPluginIdentities(dataDir), [{ id: 'unity', name: 'Unity Tools' }]);

    _registerMcpServerForTest(scopeId, 'UnityMCP', [{ name: 'manage_scene' }]);
    _registerMcpServerForTest(scopeId, 'plugin-unity-tools', [{ name: 'run' }]);
    _registerMcpServerForTest(scopeId, 'demo', [{ name: 'tool' }]);
    const live = getMcpTools(scopeId);
    assert.ok(live.some((tool) => tool.name === 'mcp__UnityMCP__manage_scene'));

    const config = { extensionScopes: { mcp: { UnityMCP: [B] }, plugins: { unity: [B] } } };
    const names = (cwd) => filterMcpToolsForSession(live, cwd, config)
      .filter((tool) => !tool.name.includes('__mixdog_'))
      .map((tool) => tool.name).sort();
    assert.deepEqual(names(A), ['mcp__demo__tool']);
    assert.deepEqual(names(join(B, 'Assets')), [
      'mcp__UnityMCP__manage_scene',
      'mcp__demo__tool',
      'mcp__plugin-unity-tools__run',
    ]);
    // No scopes at all → the live catalog passes through untouched.
    assert.equal(filterMcpToolsForSession(live, A, {}).length, live.length);
  } finally {
    await disconnectAll({ scopeId });
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('withExtensionScope replaces one entry and clears it with an empty list', () => {
  const config = { other: 1, extensionScopes: { mcp: { UnityMCP: [A] } } };
  const scoped = withExtensionScope(config, 'skills', 'bench', [B, A]);
  assert.deepEqual(scoped.extensionScopes.skills.bench, [A, B].sort((x, y) => x.localeCompare(y)));
  assert.deepEqual(scoped.extensionScopes.mcp, { UnityMCP: [A] });
  assert.equal(scoped.other, 1);
  const cleared = withExtensionScope(scoped, 'mcp', 'UnityMCP', []);
  assert.deepEqual(cleared.extensionScopes.mcp, {});
  assert.throws(() => withExtensionScope(config, 'agents', 'x', [A]), /unknown extension scope kind/);
});
