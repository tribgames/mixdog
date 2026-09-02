import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectPromptSkillsCached,
  collectSkillsCached,
  invalidateSkillsCache,
  isSkillDisabled,
  loadSkillResource,
  skillMissingFeature,
} from './collect.mjs';

test('discovers global standard skill folders and ignores project-local skills and reference Markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-standard-skill-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const skillDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'copied-skill');
    const projectSkillDir = join(cwd, '.mixdog', 'skills', 'project-only');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: copied-skill',
      'description: >',
      '  Use when a copied standard skill',
      '  should be discovered.',
      'metadata:',
      '  source: external',
      '---',
      '',
      '# Instructions',
      '',
      'Read `references/guide.md` and run `scripts/check.py` when needed.',
      '',
    ].join('\n'));
    writeFileSync(join(skillDir, 'references', 'guide.md'), [
      '---',
      'name: not-a-skill',
      'description: This reference must never become a skill.',
      '---',
      '',
      '# Reference',
      '',
    ].join('\n'));
    writeFileSync(join(skillDir, 'scripts', 'check.py'), 'print("ok")\n');
    writeFileSync(join(projectSkillDir, 'SKILL.md'), [
      '---',
      'name: project-only',
      'description: This project-local skill must be ignored.',
      '---',
      '',
      '# Project instructions',
      '',
    ].join('\n'));

    invalidateSkillsCache(cwd);
    const copied = collectSkillsCached(cwd)
      .find((skill) => skill.name === 'copied-skill');
    assert.ok(copied);
    assert.equal(copied.description,
      'Use when a copied standard skill should be discovered.');
    assert.equal(collectSkillsCached(cwd)
      .some((skill) => skill.name === 'not-a-skill'), false);
    assert.equal(collectSkillsCached(cwd)
      .some((skill) => skill.name === 'project-only'), false);

    const loaded = loadSkillResource('copied-skill', cwd);
    assert.match(loaded.content, /^# Instructions/);
    assert.equal(loaded.dir, skillDir);
    assert.equal(existsSync(join(loaded.dir, 'references', 'guide.md')), true);
    assert.equal(existsSync(join(loaded.dir, 'scripts', 'check.py')), true);
  } finally {
    invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loads skills only from globally enabled plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-skill-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const enabledRoot = join(root, 'enabled-plugin');
    const disabledRoot = join(root, 'disabled-plugin');
    const writeSkill = (pluginRoot, name) => {
      const dir = join(pluginRoot, 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: Use when ${name} is needed.`,
        '---',
        '',
        '# Instructions',
        '',
      ].join('\n'));
    };
    writeSkill(enabledRoot, 'enabled-plugin-skill');
    writeSkill(disabledRoot, 'disabled-plugin-skill');
    const registryDir = join(process.env.MIXDOG_DATA_DIR, 'plugins');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'registry.json'), JSON.stringify({
      plugins: [
        { id: 'enabled', root: enabledRoot, enabled: true },
        { id: 'disabled', root: disabledRoot, enabled: false },
      ],
    }));

    invalidateSkillsCache();
    const names = collectSkillsCached(join(root, 'any-project')).map((skill) => skill.name);
    assert.equal(names.includes('enabled-plugin-skill'), true);
    assert.equal(names.includes('disabled-plugin-skill'), false);
  } finally {
    invalidateSkillsCache();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires a standard folder name that matches the manifest name', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-mismatched-skill-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const skillDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'folder-name');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: different-name',
      'description: Use when testing mismatched folders.',
      '---',
      '',
      '# Instructions',
      '',
    ].join('\n'));

    invalidateSkillsCache(cwd);
    assert.equal(collectSkillsCached(cwd)
      .some((skill) => skill.name === 'different-name'), false);
  } finally {
    invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skill that requires a built-in feature is offered only while that feature is installed and enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-requires-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  const previousOverride = process.env.MIXDOG_FEATURE_OFFICE;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  delete process.env.MIXDOG_FEATURE_OFFICE;
  const cwd = join(root, 'project');
  try {
    const dir = join(process.env.MIXDOG_ROOT, 'defaults', 'skills', 'pptx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      'name: pptx',
      'description: Use for decks.',
      'metadata:',
      '  requires: office',
      '---',
      '',
      '# Decks',
      '',
    ].join('\n'));
    invalidateSkillsCache(cwd);
    const names = (config) => collectPromptSkillsCached(cwd, config).map((skill) => skill.name);

    const fresh = { builtins: {} };
    assert.deepEqual(names(fresh), []);
    assert.equal(skillMissingFeature('pptx', fresh), 'office');
    assert.equal(isSkillDisabled('pptx', fresh), true);

    const installedOff = { builtins: { office: { installed: true } }, modules: { office: { enabled: false } } };
    assert.deepEqual(names(installedOff), []);

    const active = { builtins: { office: { installed: true } } };
    assert.deepEqual(names(active), ['pptx']);
    assert.equal(skillMissingFeature('pptx', active), null);
    assert.equal(isSkillDisabled('pptx', active), false);

    // A profile from before the builtins section is grandfathered as installed,
    // matching what the daemon does when it adopts that config.
    const grandfathered = { presets: {}, providers: {} };
    assert.deepEqual(names(grandfathered), ['pptx']);
  } finally {
    invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    if (previousOverride !== undefined) process.env.MIXDOG_FEATURE_OFFICE = previousOverride;
    rmSync(root, { recursive: true, force: true });
  }
});

test('built-in package skills are discovered in place and shadowed by a user-global skill of the same name', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-builtin-skill-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  const cwd = join(root, 'project');
  const skillFile = (name, body) => [
    '---',
    `name: ${name}`,
    `description: ${body}`,
    '---',
    '',
    `# ${body}`,
    '',
  ].join('\n');
  try {
    const builtin = join(process.env.MIXDOG_ROOT, 'defaults', 'skills');
    mkdirSync(join(builtin, 'pptx', 'references'), { recursive: true });
    mkdirSync(join(builtin, 'docx'), { recursive: true });
    writeFileSync(join(builtin, 'pptx', 'SKILL.md'), skillFile('pptx', 'Built-in deck guide'));
    writeFileSync(join(builtin, 'pptx', 'references', 'helper-kit.md'), '# kit\n');
    writeFileSync(join(builtin, 'docx', 'SKILL.md'), skillFile('docx', 'Built-in document guide'));

    invalidateSkillsCache(cwd);
    const found = collectSkillsCached(cwd);
    assert.equal(found.find((skill) => skill.name === 'pptx')?.description, 'Built-in deck guide');
    assert.equal(found.find((skill) => skill.name === 'docx')?.description, 'Built-in document guide');
    assert.equal(loadSkillResource('pptx', cwd)?.dir, join(builtin, 'pptx'));

    const override = join(process.env.MIXDOG_DATA_DIR, 'skills', 'pptx');
    mkdirSync(override, { recursive: true });
    writeFileSync(join(override, 'SKILL.md'), skillFile('pptx', 'My own deck guide'));
    invalidateSkillsCache(cwd);
    const shadowed = collectSkillsCached(cwd).filter((skill) => skill.name === 'pptx');
    assert.equal(shadowed.length, 1);
    assert.equal(shadowed[0].description, 'My own deck guide');
    assert.equal(loadSkillResource('pptx', cwd)?.dir, override);
  } finally {
    invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
