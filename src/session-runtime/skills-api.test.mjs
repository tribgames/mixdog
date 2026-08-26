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
      instructions: '# Instructions\n\nDo the work.',
    });
    const parsed = parseSkillDocument(readFileSync(created.filePath, 'utf8'));

    assert.equal(parsed.name, 'new-skill');
    assert.equal(parsed.description, 'Use when creating a standard skill.');
    assert.equal(parsed.body, '# Instructions\n\nDo the work.\n');
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
