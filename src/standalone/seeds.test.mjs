import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retireSeededSkillCopies } from './seeds.mjs';

function writeSkill(dir, name, body, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${body}\n`);
  for (const [file, content] of Object.entries(extra)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}

test('seeded copies identical to a bundled skill are retired; edited copies stay as overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-seeds-'));
  const rootDir = join(root, 'package');
  const dataDir = join(root, 'data');
  try {
    const bundled = join(rootDir, 'defaults', 'skills');
    const seeded = join(dataDir, 'skills');
    writeSkill(join(bundled, 'setup'), 'setup', 'Runbook', { 'references/a.md': 'a\n' });
    writeSkill(join(bundled, 'pptx'), 'pptx', 'Deck guide');
    writeSkill(join(bundled, 'docx'), 'docx', 'Document guide');
    // Untouched seed copied from a CRLF checkout: same tree, same text.
    writeSkill(join(seeded, 'setup'), 'setup', 'Runbook', { 'references/a.md': 'a\r\n' });
    writeFileSync(join(seeded, 'setup', 'SKILL.md'), `---\r\nname: setup\r\ndescription: Runbook\r\n---\r\n\r\n# Runbook\r\n`);
    // User edited the body: keep.
    writeSkill(join(seeded, 'pptx'), 'pptx', 'Deck guide with my notes');
    // User added a file next to an identical SKILL.md: keep.
    writeSkill(join(seeded, 'docx'), 'docx', 'Document guide', { 'references/mine.md': 'mine\n' });
    // Purely user-owned skill: never considered.
    writeSkill(join(seeded, 'mine'), 'mine', 'Personal');

    assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), ['setup']);
    assert.equal(existsSync(join(seeded, 'setup')), false);
    assert.equal(existsSync(join(seeded, 'pptx', 'SKILL.md')), true);
    assert.equal(existsSync(join(seeded, 'docx', 'references', 'mine.md')), true);
    assert.equal(existsSync(join(seeded, 'mine', 'SKILL.md')), true);
    assert.deepEqual(retireSeededSkillCopies({ rootDir, dataDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
