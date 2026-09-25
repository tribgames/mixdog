import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateSkillDirectory } from './validate-skill.mjs';

test('UI summaries and model triggers have independent budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-fields-'));
  const dir = join(root, 'sample');
  mkdirSync(dir);
  const validate = (trigger) => {
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: sample',
        `description: ${JSON.stringify('A'.repeat(100))}`,
        `when_to_use: ${JSON.stringify(trigger)}`,
        '---',
        '# Instructions',
        'Perform the requested operation and verify the result.',
      ].join('\n')
    );
    return validateSkillDirectory(dir);
  };
  try {
    const withinBudget = validate('B'.repeat(100));
    assert.equal(withinBudget.ok, true);
    assert.deepEqual(withinBudget.warnings, []);
    const overBudget = validate('B'.repeat(101));
    assert.equal(overBudget.ok, true);
    assert.equal(overBudget.warnings.length, 1);
    const missingTrigger = validate('');
    assert.equal(missingTrigger.ok, true);
    assert.equal(missingTrigger.warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a code fence glued to the end of a line is reported as unclosed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-fence-'));
  const dir = join(root, 'sample');
  mkdirSync(dir);
  const validate = (bodyLines) => {
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'name: sample', 'description: Sample skill.', 'when_to_use: Sample requests.', '---', ...bodyLines].join(
        '\n'
      )
    );
    return validateSkillDirectory(dir);
  };
  try {
    assert.equal(validate(['Write the prompt:', '```', 'Use: photo', '```']).ok, true);
    const glued = validate(['Never wrap the prompt in JSON.```', 'Use: photo', '```']);
    assert.equal(glued.ok, false);
    assert.match(glued.errors.join('\n'), /unclosed code fence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
