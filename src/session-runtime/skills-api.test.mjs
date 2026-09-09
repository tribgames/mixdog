import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as contextMod from '../runtime/agent/orchestrator/context/collect.mjs';
import { parseSkillDocument } from '../runtime/shared/skill-document.mjs';
import { createSkillsApi } from './skills-api.mjs';

test('edits existing skills without dropping optional metadata or sibling resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const originalDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'existing-skill');
    mkdirSync(join(originalDir, 'scripts'), { recursive: true });
    writeFileSync(join(originalDir, 'SKILL.md'), [
      '---',
      'name: existing-skill',
      'description: Use when editing an existing skill.',
      'license: MIT',
      'metadata:',
      '  author: example',
      'allowed-tools:',
      '  - shell',
      '---',
      '',
      '# Original instructions',
      '',
    ].join('\n'));
    writeFileSync(join(originalDir, 'scripts', 'check.py'), 'print("ok")\n');

    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    const saved = api.saveSkillDocument({
      originalName: 'existing-skill',
      name: 'renamed-skill',
      description: 'Use when the renamed skill is needed.',
      instructions: '# Updated instructions',
    });
    const renamedDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'renamed-skill');
    const parsed = parseSkillDocument(readFileSync(saved.filePath, 'utf8'));

    assert.equal(existsSync(originalDir), false);
    assert.equal(saved.filePath, join(renamedDir, 'SKILL.md'));
    assert.equal(existsSync(join(renamedDir, 'scripts', 'check.py')), true);
    assert.equal(parsed.name, 'renamed-skill');
    assert.equal(parsed.description, 'Use when the renamed skill is needed.');
    assert.equal(parsed.body, '# Updated instructions\n');
    assert.equal(parsed.frontmatter.license, 'MIT');
    assert.deepEqual(parsed.frontmatter.metadata, { author: 'example' });
    assert.deepEqual(parsed.frontmatter['allowed-tools'], ['shell']);
    assert.ok(api.skillsStatus().skills.some((skill) => skill.name === 'renamed-skill'));
  } finally {
    contextMod.invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('skillsStatus attributes each skill to the owner that installs and toggles it', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-owner-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  const cwd = join(root, 'project');
  const skill = (dir, name, extra = []) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: Use ${name}.`, ...extra, '---', '', '# x', ''].join('\n'));
  };
  try {
    skill(join(process.env.MIXDOG_DATA_DIR, 'skills', 'mine'), 'mine');
    skill(join(process.env.MIXDOG_ROOT, 'defaults', 'skills', 'pptx'), 'pptx', ['metadata:', '  requires: office']);
    const pluginRoot = join(root, 'plugin-a');
    skill(join(pluginRoot, 'skills', 'from-plugin'), 'from-plugin');
    mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'plugins'), { recursive: true });
    writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'plugins', 'registry.json'), JSON.stringify({
      plugins: [{ id: 'plugin-a', name: 'Plugin A', root: pluginRoot, enabled: true }],
    }));
    contextMod.invalidateSkillsCache(cwd);

    const byName = Object.fromEntries(createSkillsApi({ contextMod, getCwd: () => cwd })
      .skillsStatus().skills.map((entry) => [entry.name, entry]));
    assert.deepEqual(byName.mine.owner, { kind: 'user' });
    assert.equal(byName.mine.editable, true);
    assert.deepEqual(byName.pptx.owner, { kind: 'builtin', feature: 'office' });
    assert.equal(byName.pptx.editable, false);
    assert.deepEqual(byName['from-plugin'].owner, { kind: 'plugin', id: 'plugin-a' });
    assert.equal(byName['from-plugin'].editable, false);
  } finally {
    contextMod.invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates new global skills with all three standard fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-create-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    const created = api.addGlobalSkill({
      name: 'new-skill',
      description: 'Use when creating a standard skill.',
      whenToUse: '"새 스킬", "new skill"; not for editing one.',
      instructions: '# Instructions\n\nDo the work.',
    });
    const parsed = parseSkillDocument(readFileSync(created.filePath, 'utf8'));

    assert.equal(parsed.name, 'new-skill');
    assert.equal(parsed.description, 'Use when creating a standard skill.');
    assert.equal(parsed.whenToUse, '"새 스킬", "new skill"; not for editing one.');
    assert.equal(parsed.body, '# Instructions\n\nDo the work.\n');
    assert.equal(api.skillsStatus().skills.find((skill) => skill.name === 'new-skill')?.whenToUse,
      '"새 스킬", "new skill"; not for editing one.');
    assert.equal(created.filePath, join(process.env.MIXDOG_DATA_DIR, 'skills', 'new-skill', 'SKILL.md'));
    assert.throws(() => api.addGlobalSkill({
      name: 'Invalid_Name',
      description: 'Use when invalid.',
      instructions: '# Instructions',
    }), /lowercase letters/);
  } finally {
    contextMod.invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool-link edits preserve imported source bytes, survive renames, and can be cleared or restored', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-links-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const cwd = join(root, 'project');
  const dir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'imported-guide');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  const source = '---\n# preserve formatting\nname: imported-guide\ndescription: Original guide.\nallowed-tools: shell\n---\n\n# Instructions\n';
  writeFileSync(join(dir, 'SKILL.md'), source);
  const metadata = 'dependencies:\n  tools:\n    - type: mcp\n      value: design-server\n';
  writeFileSync(join(dir, 'agents', 'openai.yaml'), metadata);
  try {
    contextMod.invalidateSkillsCache(cwd);
    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    api.saveSkillDocument({ originalName: 'imported-guide', dependenciesOnly: true,
      toolDependencies: [{ type: 'tool', value: 'office' }] });
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), source);
    assert.equal(readFileSync(join(dir, 'agents', 'openai.yaml'), 'utf8'), metadata);
    assert.deepEqual(api.skillContent('imported-guide').toolDependencies, [{ type: 'tool', value: 'office' }]);
    api.saveSkillDocument({ originalName: 'imported-guide', name: 'renamed-guide',
      description: 'Original guide.', instructions: '# Instructions' });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, [{ type: 'tool', value: 'office' }]);
    api.saveSkillDocument({ originalName: 'renamed-guide', dependenciesOnly: true, toolDependencies: [] });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, []);
    api.saveSkillDocument({ originalName: 'renamed-guide', dependenciesOnly: true, toolDependencies: null });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, [{ type: 'mcp', value: 'design-server' }]);
  } finally {
    contextMod.invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only packaged skills permit local dependency edits but not source edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-builtin-links-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  const dir = join(process.env.MIXDOG_ROOT, 'defaults', 'skills', 'packaged-guide');
  mkdirSync(dir, { recursive: true });
  const source = '---\nname: packaged-guide\ndescription: Packaged guide.\n---\n\n# Instructions\n';
  writeFileSync(join(dir, 'SKILL.md'), source);
  try {
    contextMod.invalidateSkillsCache(root);
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    api.saveSkillDocument({ originalName: 'packaged-guide', dependenciesOnly: true,
      toolDependencies: [{ type: 'tool', value: 'office' }] });
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), source);
    assert.equal(api.skillsStatus().skills.find((entry) => entry.name === 'packaged-guide').dependencySource, 'override');
    assert.throws(() => api.saveSkillDocument({ originalName: 'packaged-guide', name: 'packaged-guide',
      description: 'Changed source', instructions: 'New body' }), /read-only/);
  } finally {
    contextMod.invalidateSkillsCache(root);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR; else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT; else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
