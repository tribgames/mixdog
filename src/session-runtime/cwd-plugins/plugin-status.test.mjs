import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createPluginStatus } from './plugin-status.mjs';

test('claude-plugin skills are counted live and empty plugins warn with searched roots', async () => {
  const { pluginManifest, countSkillFiles } = await import(
    '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs'
  );
  const base = mkdtempSync(join(tmpdir(), 'plugin-status-claude-'));
  const claudeRoot = join(base, 'claude');
  const emptyRoot = join(base, 'empty');
  mkdirSync(join(claudeRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(emptyRoot);
  writeFileSync(join(claudeRoot, '.claude-plugin', 'plugin.json'), '{"name":"claude","skills":"./.claude/skills/"}');
  writeFileSync(join(emptyRoot, 'plugin.json'), '{"name":"empty"}');
  const entries = [
    { id: 'claude', name: 'claude', root: claudeRoot },
    { id: 'empty', name: 'empty', root: emptyRoot },
  ];
  const { pluginsStatus } = createPluginStatus({
    getConfig: () => ({}),
    listRegisteredPlugins: () => entries,
    pluginAdminStatus: () => ({ registryPath: 'r', installRoot: 'i' }),
    pluginManifest,
    countSkillFiles,
    clean: (value) => (typeof value === 'string' ? value.trim() : ''),
    resolve,
    statSync,
    existsSync,
    cfgMod: {},
  });
  const byId = (status, id) => status.plugins.find((plugin) => plugin.id === id);
  let status = pluginsStatus();
  assert.equal(byId(status, 'claude').skillCount, 0);
  assert.match(byId(status, 'claude').warning, /\.claude[\\/]skills/);
  assert.match(byId(status, 'empty').warning, /skills/);
  const skillDir = join(claudeRoot, '.claude', 'skills', 'one');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: one\ndescription: x\n---\n');
  status = pluginsStatus();
  assert.equal(byId(status, 'claude').skillCount, 1);
  assert.equal(byId(status, 'claude').warning, undefined);
  // A hooks-only plugin is a working extension (Extensions tab), not empty.
  assert.equal(byId(status, 'empty').hooks, false);
  mkdirSync(join(emptyRoot, 'hooks'));
  writeFileSync(join(emptyRoot, 'hooks', 'hooks.json'), '{}');
  status = pluginsStatus();
  assert.equal(byId(status, 'empty').hooks, true);
  assert.equal(byId(status, 'empty').warning, undefined);
});

test('a codex manifest skills list counts every listed root', async () => {
  const { pluginManifest, countSkillFiles } = await import(
    '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs'
  );
  const root = join(mkdtempSync(join(tmpdir(), 'plugin-status-codex-')), 'codex');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), '{"name":"codex","skills":["./a","./b",""]}');
  for (const [dir, name] of [
    ['a', 'first'],
    ['b', 'second'],
  ]) {
    mkdirSync(join(root, dir, name), { recursive: true });
    writeFileSync(join(root, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`);
  }
  const { pluginsStatus } = createPluginStatus({
    getConfig: () => ({}),
    listRegisteredPlugins: () => [{ id: 'codex', name: 'codex', root }],
    pluginAdminStatus: () => ({ registryPath: 'r', installRoot: 'i' }),
    pluginManifest,
    countSkillFiles,
    clean: (value) => (typeof value === 'string' ? value.trim() : ''),
    resolve,
    statSync,
    existsSync,
    cfgMod: {},
  });
  const plugin = pluginsStatus().plugins.find((entry) => entry.id === 'codex');
  assert.equal(plugin.skillCount, 2);
  assert.equal(plugin.warning, undefined);
});

test('missing roots are listed by id/name and unparseable manifests are invalid', () => {
  const base = mkdtempSync(join(tmpdir(), 'plugin-status-'));
  const badRoot = join(base, 'bad');
  const goodRoot = join(base, 'good');
  mkdirSync(badRoot);
  mkdirSync(goodRoot);
  writeFileSync(join(badRoot, 'plugin.json'), '{ nope');
  writeFileSync(join(goodRoot, 'plugin.json'), '{"name":"good"}');
  const entries = [
    { id: 'bad', name: 'bad', root: badRoot },
    { id: 'good', name: 'good', root: goodRoot },
    { id: 'gone', name: 'gone', root: join(base, 'gone') },
  ];
  const { pluginsStatus } = createPluginStatus({
    getConfig: () => ({}),
    listRegisteredPlugins: () => entries,
    pluginAdminStatus: () => ({ registryPath: 'r', installRoot: 'i' }),
    pluginManifest: () => ({}),
    countSkillFiles: () => 0,
    clean: (value) => (typeof value === 'string' ? value.trim() : ''),
    resolve,
    statSync,
    existsSync,
    cfgMod: {},
  });
  const status = pluginsStatus();
  assert.deepEqual(status.missing, [{ id: 'gone', name: 'gone', enabled: true }]);
  assert.deepEqual(status.plugins.map((plugin) => plugin.id).sort(), ['bad', 'good']);
  assert.equal(status.plugins.find((plugin) => plugin.id === 'bad').invalid, true);
  assert.equal(status.plugins.find((plugin) => plugin.id === 'good').invalid, undefined);
});
