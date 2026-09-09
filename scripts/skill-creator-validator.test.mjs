import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectSkills } from '../src/runtime/agent/orchestrator/context/collect.mjs';
import { validateSkillDirectory } from '../src/defaults/skills/skill-creator/scripts/validate-skill.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const builtinSkillDir = join(repoRoot, 'src', 'defaults', 'skills', 'skill-creator');

test('the bundled skill-creator validates and is collected as a built-in skill', () => {
  const result = validateSkillDirectory(builtinSkillDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.skill.name, 'skill-creator');

  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-collect-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const skill = collectSkills(repoRoot).find((candidate) => candidate.name === 'skill-creator');
    assert.ok(skill);
    assert.equal(skill.source, 'builtin');
    assert.equal(skill.filePath, join(builtinSkillDir, 'SKILL.md'));
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the validator accepts standard multiline frontmatter and existing resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-valid-'));
  const skillDir = join(root, 'portable-skill');
  try {
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide\n');
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: portable-skill',
      'description: >',
      '  Use when a portable skill',
      '  needs validation.',
      'metadata:',
      '  author: example',
      '---',
      '',
      '# Instructions',
      '',
      'Read `references/guide.md` when the detailed guide is needed.',
      '',
    ].join('\n'));

    const result = validateSkillDirectory(skillDir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.skill.description, 'Use when a portable skill needs validation.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the validator reports folder mismatch, unsupported fields, and missing resources together', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-invalid-'));
  const skillDir = join(root, 'folder-name');
  try {
    // A bundled references/ folder makes a missing file inside it a broken
    // link (error), not a repository path the validator cannot resolve.
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: manifest-name',
      'description: Use when testing invalid skills.',
      'vendor-only: true',
      '---',
      '',
      '# Instructions',
      '',
      'Read `references/missing.md`.',
      '',
    ].join('\n'));

    const result = validateSkillDirectory(skillDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('Unsupported frontmatter field')));
    assert.ok(result.errors.some((error) => error.includes('must match skill name')));
    assert.ok(result.errors.some((error) => error.includes('does not exist')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the validator rejects malformed nested YAML through the Mixdog parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-yaml-'));
  const skillDir = join(root, 'broken-yaml');
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: broken-yaml',
      'description: Use when testing malformed YAML.',
      'metadata:',
      '  tags: [unclosed',
      '---',
      '',
      '# Instructions',
      '',
    ].join('\n'));

    const result = validateSkillDirectory(skillDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('Invalid SKILL.md frontmatter')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the validator accepts explicit tool dependencies and rejects malformed dependency entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-dependencies-'));
  const skillDir = join(root, 'linked-skill');
  mkdirSync(skillDir);
  try {
    for (const [declaration, valid] of [
      ['dependencies:\n  tools:\n    - type: tool\n      value: office', true],
      ['dependencies:\n  tools:\n    - type: mcp\n      value: figma', true],
      ['dependencies: office', false],
      ['dependencies:\n  tools: office', false],
      ['dependencies:\n  tools:\n    - type: tool', false],
    ]) {
      writeFileSync(join(skillDir, 'SKILL.md'), [
        '---', 'name: linked-skill', 'description: Create linked output.',
        'when_to_use: Linked output requests.', declaration, '---', '', '# Instructions', '',
      ].join('\n'));
      const result = validateSkillDirectory(skillDir);
      assert.equal(result.ok, valid, JSON.stringify(result.errors));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

