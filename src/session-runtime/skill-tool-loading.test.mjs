import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as contextMod from '../runtime/agent/orchestrator/context/collect.mjs';
import { setInternalToolsProvider } from '../runtime/agent/orchestrator/internal-tools.mjs';
import { executeTool } from '../runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import { agentLoop } from '../runtime/agent/orchestrator/session/agent-loop.mjs';
import { normalizeToolEnvelope } from '../runtime/agent/orchestrator/session/tool-envelope.mjs';
import { parseSkillDocument } from '../runtime/shared/skill-document.mjs';
import { applyDeferredToolSurface, rebuildDeferredToolSurfaceForProvider, snapshotProviderRequestTools } from './tool-catalog.mjs';
import { createSkillsApi } from './skills-api.mjs';
import { loadSkillToolDependencies } from './skill-tool-loading.mjs';

const office = { name: 'office', description: 'Create a document.', inputSchema: {
  type: 'object', properties: { action: { type: 'string' } }, required: ['action'],
} };
const read = { name: 'read', description: 'Read content.', inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true } };
const skill = { name: 'Skill', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } };
function session(provider, tools = [skill, office, read], mode = 'full') {
  const current = { provider, tools: [...tools], messages: [], toolSpec: mode };
  applyDeferredToolSurface(current, mode);
  return current;
}
const envelope = (dependencies) => contextMod.buildSkillToolEnvelope('deck-guide', '# Deck guide', '/skills/deck-guide',
  { toolDependencies: dependencies });
const dependency = { type: 'tool', value: 'office' };

test('loading a skill supplies callable schemas on the next provider request and dispatches through the tool path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-load-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const directory = join(process.env.MIXDOG_DATA_DIR, 'skills', 'deck-guide');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'),
    '---\nname: deck-guide\ndescription: Create a presentation.\ndependencies:\n  tools:\n    - type: tool\n      value: office\n---\n# Deck guide\n');
  contextMod.invalidateSkillsCache(root);
  const calls = [];
  setInternalToolsProvider({ tools: [office], executor: async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ created: true });
  } });
  try {
    for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
      const current = session(provider);
      const loaded = await executeTool('Skill', { name: 'deck-guide' }, root, null, current);
      const normalized = normalizeToolEnvelope(loaded);
      assert.equal(normalized.newMessages.length, 1);
      const beforeRepeat = current.tools.length;
      await executeTool('Skill', { name: 'deck-guide' }, root, null, current);
      assert.equal(current.tools.length, beforeRepeat);
      const requestTools = snapshotProviderRequestTools({ provider, tools: current.tools, session: current, messages: [] });
      const definition = requestTools.find((tool) => tool.name === 'office');
      assert.deepEqual(definition.inputSchema, office.inputSchema);
      assert.notEqual(definition.deferLoading, true);
      assert.notEqual(definition.defer_loading, true);
      const result = normalizeToolEnvelope(await executeTool('office', { action: 'create' }, root, null, current));
      assert.match(typeof result.result === 'string' ? result.result : JSON.stringify(result.result), /created/);
      rebuildDeferredToolSurfaceForProvider(current, 'openai-oauth');
      assert.ok(current.tools.some((tool) => tool.name === 'office'));
      const loopSession = session(provider);
      loopSession.id = `skill-wire-${provider}`;
      loopSession.compaction = { auto: false };
      const sentTools = [];
      const fakeProvider = {
        name: provider,
        async send(_messages, _model, requestTools) {
          sentTools.push(requestTools);
          if (sentTools.length <= 2) return {
            content: '',
            toolCalls: [{ id: `skill-${sentTools.length}`, name: 'Skill', arguments: { name: 'deck-guide' } }],
          };
          return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
        },
      };
      await agentLoop(fakeProvider, [{ role: 'user', content: 'Create a presentation.' }],
        'fake-model', loopSession.tools, null, root,
        { session: loopSession, sessionId: loopSession.id });
      const nextDefinition = sentTools[1].find((tool) => tool.name === 'office');
      assert.deepEqual(nextDefinition.inputSchema, office.inputSchema);
      assert.notEqual(nextDefinition.deferLoading, true);
      assert.notEqual(nextDefinition.defer_loading, true);
      assert.deepEqual(sentTools[2], sentTools[1]);
    }
    assert.equal(calls.length, 4);
    const current = session('openai-oauth');
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    const loaded = api.skillToolContent('deck-guide', current);
    assert.equal(loaded.newMessages.length, 1);
    assert.ok(current.tools.some((tool) => tool.name === 'office'));
  } finally {
    setInternalToolsProvider({ tools: [], executor: async () => '' });
    contextMod.invalidateSkillsCache(root);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR; else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing, readonly and schema policy restrictions cannot be relaxed by a skill', () => {
  for (const current of [
    session('openai-oauth', [skill, read]),
    session('openai-oauth', [skill, office, read], 'readonly'),
    { ...session('openai-oauth'), schemaAllowedTools: ['Skill', 'read'] },
  ]) {
    const before = JSON.stringify({ toolSpec: current.toolSpec, allowed: current.schemaAllowedTools });
    const loaded = loadSkillToolDependencies(envelope([dependency]), current);
    assert.match(loaded.result, /unavailable/i);
    assert.equal(current.tools.some((tool) => tool.name === 'office'), false);
    assert.equal(JSON.stringify({ toolSpec: current.toolSpec, allowed: current.schemaAllowedTools }), before);
  }
  const current = session('openai-oauth');
  loadSkillToolDependencies(envelope([dependency]), current);
  current.tools = [skill, read];
  applyDeferredToolSurface(current, 'full', [], { disallowed: ['office'] });
  assert.equal(current.tools.some((tool) => tool.name === 'office'), false);
});

test('MCP dependencies load only registered server tools, and never follow installation metadata', () => {
  const current = session('openai-oauth', [skill,
    { ...read, name: 'mcp__figma__get_design' }, { ...read, name: 'mcp__other__inspect' }]);
  const loaded = loadSkillToolDependencies(envelope([
    { type: 'mcp', value: 'figma', command: 'must-not-run' },
    { type: 'mcp', value: 'absent', url: 'https://must-not-connect.invalid' },
  ]), current);
  assert.ok(current.tools.some((tool) => tool.name === 'mcp__figma__get_design'));
  assert.equal(current.tools.some((tool) => tool.name === 'mcp__other__inspect'), false);
  assert.match(loaded.result, /absent.*no available connected tools/);
});

test('every bundled skill declares its mandatory existing tools without eagerly linking optional capabilities', () => {
  const expected = {
    'browser-use': ['browser'], 'computer-use': ['computer'],
    docx: ['office'], pdf: ['office'], pptx: ['office'], xlsx: ['office'],
    image: ['media'], video: ['media'], setup: ['setup'], 'local-provider': ['setup'],
    'skill-creator': ['read', 'shell'],
    'goal-management': ['goal'], 'memory-management': ['memory'],
    'history-recall': ['recall'],
  };
  const root = new URL('../defaults/skills/', import.meta.url);
  const names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual(names.sort(), Object.keys(expected).sort());
  for (const name of names) {
    const parsed = parseSkillDocument(readFileSync(new URL(`${name}/SKILL.md`, root), 'utf8'));
    assert.deepEqual(parsed.frontmatter.dependencies.tools.map((entry) => entry.value), expected[name]);
  }
});

test('policy skills load their deferred tools while search stays independently deferred', () => {
  const names = ['goal', 'recall', 'memory', 'web_search'];
  const tools = [skill, read, ...names.map((name) => ({
    name, description: name, inputSchema: { type: 'object', properties: {} },
  }))];
  for (const provider of ['openai-oauth', 'anthropic-oauth']) {
    const current = session(provider, tools, 'lead');
    assert.deepEqual(current.tools.map((tool) => tool.name).sort(), ['Skill', 'read']);
    for (const name of ['history-recall', 'goal-management', 'memory-management']) {
      const parsed = parseSkillDocument(readFileSync(new URL(`../defaults/skills/${name}/SKILL.md`, import.meta.url), 'utf8'));
      const loaded = loadSkillToolDependencies(contextMod.buildSkillToolEnvelope(
        name, parsed.body, `/skills/${name}`,
        { toolDependencies: parsed.frontmatter.dependencies.tools },
      ), current);
      assert.equal(loaded.newMessages.length, 1);
      for (const dependency of parsed.frontmatter.dependencies.tools) {
        assert.ok(current.tools.some((tool) => tool.name === dependency.value));
      }
      if (name === 'history-recall') {
        assert.equal(current.tools.some((tool) => tool.name === 'memory'), false);
        assert.equal(current.tools.some((tool) => tool.name === 'goal'), false);
      }
    }
    assert.equal(current.tools.some((tool) => tool.name === 'web_search'), false);
    assert.ok(current.deferredToolCatalog.some((tool) => tool.name === 'web_search'));
  }
  // Canonical/local-compatible surfaces retain their complete fixed catalog.
  const canonical = session('openrouter', tools, 'lead');
  for (const name of names) assert.ok(canonical.tools.some((tool) => tool.name === name));
});
