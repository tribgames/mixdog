import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSkillDocument,
  parseSkillDocument,
  updateSkillDocument,
  validateSkillName,
} from './skill-document.mjs';

test('parses standard multiline YAML and the Markdown instructions body', () => {
  const parsed = parseSkillDocument([
    '---',
    'name: imported-skill',
    'description: >',
    '  Use when an imported skill',
    '  needs multiline matching.',
    'metadata:',
    '  author: example',
    'allowed-tools:',
    '  - shell',
    '---',
    '',
    '# Instructions',
    '',
    'Read `references/guide.md`.',
    '',
  ].join('\n'));

  assert.equal(parsed.name, 'imported-skill');
  assert.equal(parsed.description,
    'Use when an imported skill needs multiline matching.');
  assert.deepEqual(parsed.frontmatter.metadata, { author: 'example' });
  assert.deepEqual(parsed.frontmatter['allowed-tools'], ['shell']);
  assert.match(parsed.body, /^# Instructions/);
});

test('updates the three editable fields without dropping optional frontmatter', () => {
  const source = [
    '---',
    '# retained comment',
    'name: old-name',
    'description: Old trigger.',
    'license: MIT',
    'compatibility: Requires Python.',
    'metadata:',
    '  author: example',
    'allowed-tools: shell',
    '---',
    '',
    'Old instructions.',
    '',
  ].join('\n');

  const updated = updateSkillDocument(source, {
    name: 'new-name',
    description: 'Use when the new trigger matches.',
    body: '# New instructions',
  });
  const parsed = parseSkillDocument(updated);

  assert.equal(parsed.name, 'new-name');
  assert.equal(parsed.description, 'Use when the new trigger matches.');
  assert.equal(parsed.body, '# New instructions\n');
  assert.equal(parsed.frontmatter.license, 'MIT');
  assert.equal(parsed.frontmatter.compatibility, 'Requires Python.');
  assert.deepEqual(parsed.frontmatter.metadata, { author: 'example' });
  assert.equal(parsed.frontmatter['allowed-tools'], 'shell');
  assert.match(updated, /# retained comment/);
});

test('creates a standard document and rejects non-standard names', () => {
  const source = createSkillDocument({
    name: 'project-skill',
    description: 'Use when this project needs the skill.',
    body: '# Instructions',
  });
  assert.equal(parseSkillDocument(source).name, 'project-skill');
  assert.throws(() => validateSkillName('Project_Skill'), /lowercase letters/);
  assert.throws(() => validateSkillName('project--skill'), /consecutive hyphens/);
});
