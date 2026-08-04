import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MIXDOG_DISABLE_MCP = '1';
process.env.MIXDOG_DISABLE_SKILLS = '1';

const {
  buildSkillManifest,
  buildSkillToolDefs,
  collectSkills,
  collectSkillsCached,
  loadSkillResource,
} = await import('../src/runtime/agent/orchestrator/context/collect.mjs');
const { seedBundledSkills } = await import('../src/standalone/seeds.mjs');
const { createMcpGlue } = await import('../src/session-runtime/mcp-glue.mjs');

test('skills guard suppresses discovery, bundled seeding, prompt, and tool exposure', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-skill-guard-'));
  try {
    const bundled = join(root, 'defaults', 'skills', 'bundled');
    const project = join(root, 'project', '.mixdog', 'skills', 'project');
    const data = join(root, 'data');
    for (const dir of [bundled, project]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(bundled, 'SKILL.md'), '---\nname: bundled\n---\nsecret');
    writeFileSync(join(project, 'SKILL.md'), '---\nname: project\n---\nsecret');

    seedBundledSkills({ rootDir: root, dataDir: data });
    assert.equal(readFileSync(join(bundled, 'SKILL.md'), 'utf8').includes('secret'), true);
    assert.deepEqual(collectSkills(join(root, 'project')), []);
    assert.deepEqual(collectSkillsCached(join(root, 'project')), []);
    assert.equal(loadSkillResource('project', join(root, 'project')), null);
    assert.equal(buildSkillManifest([{ name: 'injected', description: 'secret' }]), '');
    assert.deepEqual(
      buildSkillToolDefs([{ name: 'injected' }], { ownerIsAgentSession: true }),
      [],
    );
    const runtimeCore = readFileSync(
      fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(
      runtimeCore,
      /envFlag\('MIXDOG_DISABLE_SKILLS'\) \? \[\] : \[SKILL_TOOL\]/,
    );
    assert.throws(
      () => readFileSync(join(data, 'skills', 'bundled', 'SKILL.md'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP guard ignores config and project sources and disconnects without connecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-mcp-guard-'));
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'personal-project' } } }),
    );
    const calls = [];
    const glue = createMcpGlue({
      mcpClient: {
        getMcpServerStatus: () => [{ name: 'stale', connected: true }],
        connectMcpServers: async () => calls.push('connect'),
        disconnectAll: async () => calls.push('disconnect-all'),
        disconnectMcpServer: async (name) => calls.push(`disconnect:${name}`),
      },
      getConfig: () => ({
        mcpServers: { configured: { command: 'personal-config' } },
      }),
      getCurrentCwd: () => root,
      state: {
        mcpFailures: [{ name: 'personal', msg: 'secret' }],
        mcpConnectGeneration: 0,
        mcpConnectInFlight: null,
      },
    });

    assert.deepEqual(glue.resolveEffectiveMcpServers(), { servers: {}, sources: {} });
    assert.deepEqual(glue.mcpStatus(), {
      servers: [],
      configuredCount: 0,
      connectedCount: 0,
      failedCount: 0,
    });
    await glue.connectConfiguredMcp({ reset: true });
    assert.deepEqual(calls, ['disconnect-all']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
