import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSkillToolDependencies, saveSkillToolDependencies } from './skill-tool-dependencies.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-links-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const file = join(root, 'imported', 'SKILL.md');
  mkdirSync(join(root, 'imported', 'agents'), { recursive: true });
  writeFileSync(file, 'An imported document that the link editor must not rewrite.\n');
  try { fn({ root, file }); }
  finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR; else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('legacy allowed-tools and prose do not load dependencies', () => fixture(({ file }) => {
  const result = readSkillToolDependencies(file, { 'allowed-tools': ['office'], description: 'Use office' });
  assert.deepEqual(result.toolDependencies, []);
  assert.equal(result.dependencySource, 'none');
}));

test('imports dependency metadata without executing it and local edits survive source updates', () => fixture(({ root, file }) => {
  const metadata = join(root, 'imported', 'agents', 'openai.yaml');
  const yaml = 'dependencies:\n  tools:\n    - type: mcp\n      value: figma\n      command: never-execute-this\n';
  writeFileSync(metadata, yaml);
  const original = readFileSync(file, 'utf8');
  const declared = readSkillToolDependencies(file, { dependencies: { tools: [{ type: 'tool', value: 'office' }] } });
  assert.deepEqual(declared.toolDependencies.map(({ type, value }) => ({ type, value })),
    [{ type: 'tool', value: 'office' }, { type: 'mcp', value: 'figma' }]);
  saveSkillToolDependencies(file, [{ type: 'tool', value: 'media' }]);
  writeFileSync(metadata, yaml.replace('figma', 'updated-server'));
  assert.deepEqual(readSkillToolDependencies(file).toolDependencies, [{ type: 'tool', value: 'media' }]);
  assert.equal(readFileSync(file, 'utf8'), original);
  saveSkillToolDependencies(file, []);
  assert.deepEqual(readSkillToolDependencies(file).toolDependencies, []);
  saveSkillToolDependencies(file, null);
  assert.equal(readSkillToolDependencies(file).toolDependencies[0].value, 'updated-server');
}));

test('malformed optional dependency metadata reports readiness without losing the skill', () => fixture(({ file }) => {
  const result = readSkillToolDependencies(file, { dependencies: { tools: 'office' } });
  assert.deepEqual(result.toolDependencies, []);
  assert.ok(result.dependencyIssues.length);
  assert.throws(() => saveSkillToolDependencies(file, [{ type: 'permission', value: 'shell' }]), /Unsupported/);
}));
